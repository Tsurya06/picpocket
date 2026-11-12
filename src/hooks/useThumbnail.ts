import { useEffect, useState } from 'react';
import type { MediaItem } from '../types/media';
import { loadThumbnail } from '../services/media/thumbnails';

export interface ThumbnailState {
  readonly url: string | null;
  readonly loading: boolean;
  readonly failed: boolean;
}

const emptyState: ThumbnailState = { url: null, loading: false, failed: false };

/**
 * Loads a preview and owns its object URL.
 * The URL is revoked when the tile unmounts (scrolled out, deleted, or the
 * channel changes), which keeps decoded bitmaps from accumulating.
 */
export function useThumbnail(item: MediaItem | null, enabled = true): ThumbnailState {
  const [state, setState] = useState<ThumbnailState>(emptyState);

  const itemId = item?.id ?? null;
  const thumbMessageId = item?.thumbMessageId ?? null;
  const hasThumb = item?.hasThumb ?? false;

  useEffect(() => {
    if (!enabled || !item || !item.hasThumb) {
      setState(emptyState);
      return;
    }

    let cancelled = false;
    let objectUrl: string | null = null;
    setState({ url: null, loading: true, failed: false });

    loadThumbnail(item)
      .then((blob) => {
        if (cancelled) return;
        if (!blob) {
          setState({ url: null, loading: false, failed: true });
          return;
        }
        objectUrl = URL.createObjectURL(blob);
        setState({ url: objectUrl, loading: false, failed: false });
      })
      .catch(() => {
        if (!cancelled) setState({ url: null, loading: false, failed: true });
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    // Only identifiers matter; metadata updates must not revoke a live URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, itemId, thumbMessageId, hasThumb]);

  return state;
}
