import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MediaItem, TimelineOffset } from '../types/media';
import type { ChannelMediaBatch, RemoteMediaDescriptor } from '../types/telegram';
import {
  deleteCachedMedia,
  deleteCachedThumb,
  getCachedMedia,
  putCachedMedia,
} from '../services/cache/db';
import { cryptoClient } from '../services/crypto/cryptoClient';
import { describeError, telegramService } from '../services/telegram/mtprotoClient';
import { thumbnailCacheKey } from '../services/media/thumbnails';
import { isMediaBundleIndex } from '../types/bundle';

export interface PhotoTimelineApi {
  items: MediaItem[];
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  hasMore: boolean;
  loadMore: () => Promise<void>;
  reload: () => Promise<void>;
  removeItems: (ids: readonly string[]) => void;
  itemCount: number;
}

interface PageResult {
  channelId: string;
  items: MediaItem[];
  next?: TimelineOffset;
  error?: string;
}

const toItem = (
  descriptor: RemoteMediaDescriptor,
  overrides: Partial<MediaItem> = {},
): MediaItem => ({
  id: `${descriptor.channelId}:${descriptor.messageId}`,
  channelId: descriptor.channelId,
  channelTitle: descriptor.channelTitle,
  messageId: descriptor.messageId,
  thumbMessageId: descriptor.thumbMessageId,
  kind: descriptor.kind,
  source: descriptor.vaultCaption ? 'vault' : 'direct',
  takenAt: descriptor.date,
  fileName: descriptor.fileName,
  mimeType: descriptor.mimeType,
  size: descriptor.size,
  duration: descriptor.duration,
  hasThumb: descriptor.hasThumb,
  ...overrides,
  // Spread of a partial would widen these to `number | undefined`.
  width: overrides.width ?? descriptor.width,
  height: overrides.height ?? descriptor.height,
});

/**
 * Fetches pages from every selected channel, decrypts vault metadata in the
 * worker, and keeps an IndexedDB-backed index so reloads paint instantly.
 */
export function usePhotoTimeline(options: {
  readonly channelIds: readonly string[];
  readonly enabled: boolean;
}): PhotoTimelineApi {
  const { channelIds, enabled } = options;
  const channelKey = useMemo(() => [...channelIds].sort().join('|'), [channelIds]);

  const [items, setItems] = useState<MediaItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [generation, setGeneration] = useState(0);

  /** `null` means "no further pages" for that channel. */
  const cursorsRef = useRef(new Map<string, TimelineOffset | null>());
  const generationRef = useRef(0);
  const busyRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const decodeBatch = useCallback(async (batch: ChannelMediaBatch): Promise<MediaItem[]> => {
    const thumbByMid = new Map(batch.thumbs.map((thumb) => [thumb.mid, thumb.messageId]));

    const decoded = await Promise.all(
      batch.descriptors.map(async (descriptor): Promise<MediaItem | null> => {
        if (!descriptor.vaultCaption) {
          return toItem(descriptor);
        }
        try {
          const meta = await cryptoClient.decryptMeta(descriptor.vaultCaption);
          const thumbMessageId = thumbByMid.get(meta.mid);
          return toItem(descriptor, {
            kind: meta.kind,
            width: meta.width,
            height: meta.height,
            takenAt: meta.takenAt,
            fileName: meta.name,
            mimeType: meta.mime,
            size: meta.size,
            duration: meta.duration,
            caption: meta.caption,
            thumbMime: meta.thumbMime,
            thumbMessageId,
            hasThumb: thumbMessageId !== undefined,
          });
        } catch {
          // A file sealed with a different vault key cannot be shown, but it
          // must never break the rest of the timeline.
          return null;
        }
      }),
    );

    const packedGroups = await Promise.all(
      batch.bundles.map(async (ref): Promise<MediaItem[]> => {
        try {
          const indexDownload = await telegramService.downloadOriginal(
            batch.channelId,
            ref.messageId,
          );
          const plaintext = await cryptoClient.decryptBytes(indexDownload.bytes);
          const parsed: unknown = JSON.parse(new TextDecoder().decode(plaintext));
          if (!isMediaBundleIndex(parsed) || parsed.channelId !== batch.channelId) return [];

          return parsed.entries.map((entry): MediaItem => ({
            id: `${batch.channelId}:b${ref.messageId}:${entry.origin.byteOffset}`,
            channelId: batch.channelId,
            channelTitle: batch.channelTitle,
            messageId: ref.messageId,
            kind: entry.meta.kind,
            source: 'vault',
            takenAt: entry.meta.takenAt,
            fileName: entry.meta.name,
            mimeType: entry.meta.mime,
            size: entry.meta.size,
            width: entry.meta.width,
            height: entry.meta.height,
            duration: entry.meta.duration,
            caption: entry.meta.caption,
            thumbMime: entry.meta.thumbMime,
            hasThumb: entry.thumb !== null,
            packed: {
              ...entry.origin,
              bundleIndexMessageId: ref.messageId,
            },
            ...(entry.thumb ? { packedThumb: entry.thumb } : {}),
          }));
        } catch {
          // An index sealed with another key must not break the page.
          return [];
        }
      }),
    );

    return [
      ...decoded.filter((item): item is MediaItem => item !== null),
      ...packedGroups.flat(),
    ];
  }, []);

  const fetchPage = useCallback(
    async (channelId: string, cursor: TimelineOffset | undefined): Promise<PageResult> => {
      try {
        const batch = await telegramService.fetchMediaBatch(channelId, { offset: cursor });
        const decoded = await decodeBatch(batch);
        return { channelId, items: decoded, next: batch.next };
      } catch (caught) {
        return { channelId, items: [], error: describeError(caught) };
      }
    },
    [decodeBatch],
  );

  const mergeItems = useCallback((incoming: readonly MediaItem[]) => {
    if (incoming.length === 0) return;
    setItems((current) => {
      const map = new Map(current.map((item) => [item.id, item]));
      for (const item of incoming) map.set(item.id, item);
      return [...map.values()].sort((a, b) => b.takenAt - a.takenAt);
    });
  }, []);

  const applyResults = useCallback(
    (results: readonly PageResult[]) => {
      const merged: MediaItem[] = [];
      let firstError: string | null = null;

      for (const result of results) {
        merged.push(...result.items);
        if (result.error && !firstError) firstError = result.error;
        cursorsRef.current.set(result.channelId, result.next ?? null);
      }

      mergeItems(merged);
      setHasMore([...cursorsRef.current.values()].some((cursor) => cursor !== null));
      if (firstError) setError(firstError);
      if (merged.length > 0) {
        void putCachedMedia(merged).catch(() => undefined);
      }
    },
    [mergeItems],
  );

  // Initial load / channel switch.
  useEffect(() => {
    if (!enabled || channelIds.length === 0) {
      setItems([]);
      setLoading(false);
      setLoadingMore(false);
      setHasMore(false);
      setError(null);
      cursorsRef.current = new Map();
      return;
    }

    const ids = channelIds;
    const current = generationRef.current + 1;
    generationRef.current = current;
    cursorsRef.current = new Map();
    busyRef.current = true;
    setLoading(true);
    setLoadingMore(false);
    setError(null);
    setHasMore(false);

    void (async () => {
      const cached = await getCachedMedia(ids);
      if (!mountedRef.current || generationRef.current !== current) return;
      if (cached.length > 0) {
        setItems(cached.sort((a, b) => b.takenAt - a.takenAt));
      }

      const results = await Promise.all(ids.map((id) => fetchPage(id, undefined)));
      if (!mountedRef.current || generationRef.current !== current) return;

      applyResults(results);
      busyRef.current = false;
      setLoading(false);
    })();

    return () => {
      busyRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelKey, enabled, generation]);

  const loadMore = useCallback(async () => {
    if (!enabled || busyRef.current) return;
    const pending = [...cursorsRef.current.entries()].filter((entry) => entry[1] !== null);
    if (pending.length === 0) return;

    busyRef.current = true;
    setLoadingMore(true);
    const current = generationRef.current;

    try {
      const results = await Promise.all(
        pending.map(([channelId, cursor]) => fetchPage(channelId, cursor ?? undefined)),
      );
      if (!mountedRef.current || generationRef.current !== current) return;
      applyResults(results);
    } finally {
      if (mountedRef.current) setLoadingMore(false);
      busyRef.current = false;
    }
  }, [applyResults, enabled, fetchPage]);

  const reload = useCallback(async () => {
    setGeneration((value) => value + 1);
  }, []);

  const removeItems = useCallback(
    (ids: readonly string[]) => {
      if (ids.length === 0) return;
      const removing = new Set(ids);
      for (const item of items) {
        if (!removing.has(item.id)) continue;
        void deleteCachedMedia(item.id);
        void deleteCachedThumb(thumbnailCacheKey(item));
      }
      setItems((current) => current.filter((item) => !removing.has(item.id)));
    },
    [items],
  );

  return {
    items,
    loading,
    loadingMore,
    error,
    hasMore,
    loadMore,
    reload,
    removeItems,
    itemCount: items.length,
  };
}
