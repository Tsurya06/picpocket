import { useEffect, useState } from 'react';
import type { MediaItem } from '../types/media';
import { loadThumbnail, thumbnailCacheKey } from '../services/media/thumbnails';

export interface ThumbnailState {
  readonly url: string | null;
  readonly loading: boolean;
  readonly failed: boolean;
}

const emptyState: ThumbnailState = { url: null, loading: false, failed: false };

interface ThumbnailRecord extends ThumbnailState {
  readonly key: string | null;
}

const emptyRecord: ThumbnailRecord = { ...emptyState, key: null };

/**
 * Virtual rows mount and unmount constantly while scrolling. Previews are kept
 * in a small bounded cache so a recycled row can paint its thumbnail in the
 * same frame instead of showing a skeleton again.
 */
const MAX_CACHED_PREVIEWS = 200;
const cache = new Map<string, string>();
const inflight = new Map<string, Promise<string | null>>();
/** URLs currently rendered by a mounted tile must never be revoked. */
const activeUrls = new Map<string, number>();
let generation = 0;

function retain(url: string): void {
  activeUrls.set(url, (activeUrls.get(url) ?? 0) + 1);
}

function release(url: string): void {
  const count = activeUrls.get(url);
  if (!count || count <= 1) activeUrls.delete(url);
  else activeUrls.set(url, count - 1);
}

function touch(key: string, url: string): void {
  cache.delete(key);
  cache.set(key, url);
  while (cache.size > MAX_CACHED_PREVIEWS) {
    let evictKey: string | null = null;
    for (const [candidateKey, candidateUrl] of cache) {
      if (!activeUrls.has(candidateUrl)) {
        evictKey = candidateKey;
        break;
      }
    }
    if (evictKey === null) break;
    const evicted = cache.get(evictKey);
    cache.delete(evictKey);
    if (evicted) URL.revokeObjectURL(evicted);
  }
}

function ensurePreview(item: MediaItem): Promise<string | null> {
  const key = thumbnailCacheKey(item);
  const existing = cache.get(key);
  if (existing) {
    touch(key, existing);
    return Promise.resolve(existing);
  }

  const pending = inflight.get(key);
  if (pending) return pending;

  const startGeneration = generation;
  const promise = loadThumbnail(item)
    .then((blob) => {
      if (!blob) return null;
      const url = URL.createObjectURL(blob);
      // The vault locked while this preview was in flight: never expose it.
      if (startGeneration !== generation) {
        URL.revokeObjectURL(url);
        return null;
      }
      touch(key, url);
      return url;
    })
    .finally(() => {
      if (inflight.get(key) === promise) inflight.delete(key);
    });

  inflight.set(key, promise);
  return promise;
}

/** Warms a preview ahead of scrolling without subscribing a component to it. */
export function prefetchThumbnail(item: MediaItem | null | undefined): void {
  if (!item?.hasThumb) return;
  const key = thumbnailCacheKey(item);
  if (cache.has(key) || inflight.has(key)) return;
  void ensurePreview(item).catch(() => undefined);
}

/** Drops every decrypted preview — call when the vault locks or resets. */
export function clearThumbnailCache(): void {
  generation += 1;
  for (const url of cache.values()) URL.revokeObjectURL(url);
  cache.clear();
  activeUrls.clear();
  inflight.clear();
}

/**
 * Resolves a preview from the shared cache, loading and caching it on first
 * use. The cache owns the object URL, so unmounting a virtual tile does not
 * revoke an image that may be needed again immediately.
 */
export function useThumbnail(item: MediaItem | null, enabled = true): ThumbnailState {
  const [record, setRecord] = useState<ThumbnailRecord>(emptyRecord);

  const cacheKey = item?.hasThumb ? thumbnailCacheKey(item) : null;

  useEffect(() => {
    if (!enabled || !item || !cacheKey) {
      setRecord((current) => (current.key === null ? current : emptyRecord));
      return;
    }

    const key = cacheKey;
    const cached = cache.get(key);
    if (cached) {
      touch(key, cached);
      setRecord((current) =>
        current.key === key && current.url === cached
          ? current
          : { key, url: cached, loading: false, failed: false },
      );
      return;
    }

    let cancelled = false;
    setRecord({ key, url: null, loading: true, failed: false });

    ensurePreview(item)
      .then((url) => {
        if (cancelled) return;
        setRecord({
          key,
          url,
          loading: false,
          failed: url === null,
        });
      })
      .catch(() => {
        if (!cancelled) setRecord({ key, url: null, loading: false, failed: true });
      });

    return () => {
      cancelled = true;
    };
    // The cache key covers the channel, message and packed slice, so metadata
    // updates that keep the same preview must not reset a live object URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey, enabled]);

  // Resolve an already-cached preview during render. This is what lets a
  // virtual row that just remounted paint its image on the first frame.
  const cached = enabled && cacheKey ? cache.get(cacheKey) ?? null : null;
  const state = cached
    ? { url: cached, loading: false, failed: false }
    : !enabled || !cacheKey
      ? emptyState
      : record.key === cacheKey
        ? record
        : { url: null, loading: true, failed: false };

  const currentUrl = state.url;
  useEffect(() => {
    if (!currentUrl) return;
    retain(currentUrl);
    return () => release(currentUrl);
  }, [currentUrl]);

  return state;
}
