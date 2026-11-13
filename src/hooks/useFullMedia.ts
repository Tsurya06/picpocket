import { useEffect, useState } from 'react';
import type { MediaItem } from '../types/media';
import { cryptoClient } from '../services/crypto/cryptoClient';
import { describeError, telegramService } from '../services/telegram/mtprotoClient';

export interface FullMediaState {
  readonly url: string | null;
  readonly loading: boolean;
  readonly progress: number;
  readonly error: string | null;
  readonly mimeType: string | null;
}

const idle: FullMediaState = {
  url: null,
  loading: false,
  progress: 0,
  error: null,
  mimeType: null,
};

interface CachedMedia {
  readonly url: string;
  readonly mimeType: string;
}

/**
 * Decrypted originals kept as object URLs so flipping through the viewer is
 * instant. Bounded so a long session cannot grow without limit; entries are
 * revoked when evicted or when the vault locks.
 */
const MAX_CACHED_ITEMS = 24;
const cache = new Map<string, CachedMedia>();
const inflight = new Map<string, Promise<CachedMedia>>();

function touch(id: string, value: CachedMedia): void {
  cache.delete(id);
  cache.set(id, value);
  while (cache.size > MAX_CACHED_ITEMS) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    const evicted = cache.get(oldest.value);
    cache.delete(oldest.value);
    if (evicted) URL.revokeObjectURL(evicted.url);
  }
}

/** Drops every cached original — call this when the vault locks or resets. */
export function clearFullMediaCache(): void {
  for (const entry of cache.values()) URL.revokeObjectURL(entry.url);
  cache.clear();
  inflight.clear();
}

async function load(item: MediaItem, onProgress?: (fraction: number) => void): Promise<CachedMedia> {
  const existing = cache.get(item.id);
  if (existing) {
    touch(item.id, existing);
    return existing;
  }

  const pending = inflight.get(item.id);
  if (pending) return pending;

  const promise = (async (): Promise<CachedMedia> => {
    const download = item.packed
      ? await telegramService.downloadRange(
          item.channelId,
          item.packed.bundleMessageId,
          item.packed.byteOffset,
          item.packed.byteLength,
          onProgress ? { onProgress } : {},
        )
      : await telegramService.downloadOriginal(
          item.channelId,
          item.messageId,
          onProgress ? { onProgress } : {},
        );

    const plaintext = item.packed
      ? await cryptoClient.decryptPacked(download.bytes, item.channelId)
      : item.source === 'vault' || download.encrypted
        ? await cryptoClient.decryptBytes(download.bytes, item.channelId)
        : download.bytes;

    const mimeType =
      item.source === 'vault' ? item.mimeType || 'application/octet-stream' : download.mimeType;
    const blob = new Blob([plaintext], { type: mimeType });
    const value: CachedMedia = { url: URL.createObjectURL(blob), mimeType: blob.type };
    touch(item.id, value);
    return value;
  })();

  inflight.set(item.id, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(item.id);
  }
}

/** Warms the cache for a neighbour so the next swipe needs no download. */
export function prefetchFullMedia(item: MediaItem | null | undefined): void {
  if (!item) return;
  if (cache.has(item.id) || inflight.has(item.id)) return;
  void load(item).catch(() => undefined);
}

/**
 * Streams the original from Telegram and decrypts it in the worker on demand.
 * Results are memoised per item so reopening or swiping back is immediate.
 */
export function useFullMedia(item: MediaItem | null, enabled = true): FullMediaState {
  const [state, setState] = useState<FullMediaState>(idle);

  useEffect(() => {
    if (!item || !enabled) {
      setState(idle);
      return;
    }

    const cached = cache.get(item.id);
    if (cached) {
      touch(item.id, cached);
      setState({
        url: cached.url,
        loading: false,
        progress: 1,
        error: null,
        mimeType: cached.mimeType,
      });
      return;
    }

    let cancelled = false;
    setState({ ...idle, loading: true });

    void load(item, (fraction) => {
      if (!cancelled) setState((current) => ({ ...current, progress: fraction }));
    })
      .then((result) => {
        if (cancelled) return;
        setState({
          url: result.url,
          loading: false,
          progress: 1,
          error: null,
          mimeType: result.mimeType,
        });
      })
      .catch((caught) => {
        if (!cancelled) setState({ ...idle, error: describeError(caught) });
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, item]);

  return state;
}
