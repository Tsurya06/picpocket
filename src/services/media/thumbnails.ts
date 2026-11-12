import type { MediaItem } from '../../types/media';
import { evictThumbs, getCachedThumb, putCachedThumb, thumbKey } from '../cache/db';
import { cryptoClient } from '../crypto/cryptoClient';
import { telegramService } from '../telegram/mtprotoClient';

/**
 * Downloads are throttled so a long timeline does not open hundreds of
 * concurrent MTProto connections (Telegram starts rate limiting quickly).
 */
const MAX_CONCURRENT = 4;
let active = 0;

/** Packed tiles share a bundle message, so their cache key includes the slice. */
export const thumbnailCacheKey = (item: MediaItem): string =>
  item.packedThumb
    ? `${item.channelId}:packed:${item.packedThumb.bundleMessageId}:${item.packedThumb.byteOffset}`
    : thumbKey(item.channelId, item.messageId);
const waiting: (() => void)[] = [];

async function withSlot<T>(task: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  active += 1;
  try {
    return await task();
  } finally {
    active -= 1;
    const next = waiting.shift();
    if (next) next();
  }
}

/**
 * Returns a preview for a gallery item, from IndexedDB when possible.
 * Vault previews are decrypted in the worker; direct previews are Telegram's
 * own thumbnails, already compressed server-side.
 */
export async function loadThumbnail(item: MediaItem): Promise<Blob | null> {
  if (!item.hasThumb) return null;
  const key = thumbnailCacheKey(item);

  const cached = await getCachedThumb(key);
  if (cached) return cached;

  return withSlot(async () => {
    const rechecked = await getCachedThumb(key);
    if (rechecked) return rechecked;

    if (item.packedThumb) {
      const slice = item.packedThumb;
      const download = await telegramService.downloadRange(
        item.channelId,
        slice.bundleMessageId,
        slice.byteOffset,
        slice.byteLength,
      );
      const blob = new Blob([await cryptoClient.decryptPacked(download.bytes, item.channelId)], {
        type: item.thumbMime ?? 'image/webp',
      });
      await putCachedThumb({
        key,
        channelId: item.channelId,
        messageId: item.messageId,
        bytes: blob,
        byteSize: blob.size,
      });
      void evictThumbs().catch(() => undefined);
      return blob;
    }

    const download = await telegramService.downloadThumb(
      item.channelId,
      item.messageId,
      item.thumbMessageId,
    );

    const blob = download.encrypted
      ? new Blob([await cryptoClient.decryptBytes(download.bytes, item.channelId)], {
          type: item.thumbMime ?? 'image/webp',
        })
      : new Blob([download.bytes], { type: 'image/jpeg' });

    await putCachedThumb({
      key,
      channelId: item.channelId,
      messageId: item.messageId,
      bytes: blob,
      byteSize: blob.size,
    });
    void evictThumbs().catch(() => undefined);
    return blob;
  });
}

