import type { MediaItem, PackedSliceLocation } from '../../types/media';
import { isMediaBundleIndex, type MediaBundleEntry } from '../../types/bundle';
import { cryptoClient } from '../crypto/cryptoClient';
import { bundleIndexCaption } from '../telegram/captions';
import { telegramService } from '../telegram/mtprotoClient';

/**
 * Deletes media without destroying the other items sharing a packed bundle.
 *
 * A bundle document is immutable ciphertext, so removing one entry means
 * rewriting its encrypted index and uploading that index as a new message.
 * The bundle bytes stay in Telegram until the last entry is removed. If the
 * reindex fails, the old index is still authoritative and nothing is lost.
 */

export interface DeleteResult {
  readonly removeIds: readonly string[];
  /** Surviving items whose `bundleIndexMessageId` changed. */
  readonly updatedItems: readonly MediaItem[];
}

const sliceKey = (slice: PackedSliceLocation): string =>
  `${slice.bundleMessageId}:${slice.byteOffset}:${slice.byteLength}`;

const uniqueIds = (ids: readonly number[]): number[] => [...new Set(ids)];

interface BundleGroup {
  readonly channelId: string;
  readonly bundleMessageId: number;
  indexMessageId: number;
  readonly items: MediaItem[];
}

export async function deleteMediaItems(
  items: readonly MediaItem[],
  allItems: readonly MediaItem[],
): Promise<DeleteResult> {
  if (items.length === 0) return { removeIds: [], updatedItems: [] };

  const removeIds: string[] = [];
  const updatedItems: MediaItem[] = [];
  const standalone = new Map<string, number[]>();
  const bundles = new Map<string, BundleGroup>();

  for (const item of items) {
    if (!item.packed) {
      const ids = standalone.get(item.channelId) ?? [];
      ids.push(item.messageId);
      if (item.thumbMessageId !== undefined) ids.push(item.thumbMessageId);
      standalone.set(item.channelId, ids);
      removeIds.push(item.id);
      continue;
    }

    const key = `${item.channelId}:${item.packed.bundleMessageId}`;
    const group = bundles.get(key);
    if (group) {
      group.items.push(item);
      group.indexMessageId = Math.max(group.indexMessageId, item.packed.bundleIndexMessageId);
    } else {
      bundles.set(key, {
        channelId: item.channelId,
        bundleMessageId: item.packed.bundleMessageId,
        indexMessageId: item.packed.bundleIndexMessageId,
        items: [item],
      });
    }
    removeIds.push(item.id);
  }

  for (const [channelId, ids] of standalone) {
    await telegramService.deleteMessages(channelId, uniqueIds(ids));
  }

  for (const group of bundles.values()) {
    const download = await telegramService.downloadOriginal(
      group.channelId,
      group.indexMessageId,
    );
    const plaintext = await cryptoClient.decryptBytes(download.bytes, group.channelId);
    const parsed: unknown = JSON.parse(new TextDecoder().decode(plaintext));
    if (!isMediaBundleIndex(parsed)) {
      throw new Error('The bundle index could not be read; nothing was deleted.');
    }
    if (parsed.channelId !== group.channelId || parsed.bundleMessageId !== group.bundleMessageId) {
      throw new Error('The bundle index does not match this item; nothing was deleted.');
    }

    const selected = new Set(
      group.items.flatMap((item) => (item.packed ? [sliceKey(item.packed)] : [])),
    );
    const remaining: MediaBundleEntry[] = parsed.entries.filter(
      (entry) => !selected.has(sliceKey(entry.origin)),
    );

    if (remaining.length === parsed.entries.length) {
      // The local item came from an older index and is already gone. Remove the
      // local row, but leave the current index untouched.
      continue;
    }

    if (remaining.length === 0) {
      await telegramService.deleteMessages(group.channelId, [
        group.bundleMessageId,
        group.indexMessageId,
      ]);
      for (const sibling of allItems) {
        if (
          sibling.channelId === group.channelId &&
          sibling.packed?.bundleMessageId === group.bundleMessageId
        ) {
          removeIds.push(sibling.id);
        }
      }
      continue;
    }

    const nextIndex = {
      ...parsed,
      createdAt: Date.now(),
      entries: remaining,
    };
    const encoded = new TextEncoder().encode(JSON.stringify(nextIndex));
    const sealed = await cryptoClient.encryptBytes(
      encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength) as ArrayBuffer,
      group.channelId,
    );
    const newIndexId = await telegramService.uploadEncrypted({
      channelId: group.channelId,
      bytes: sealed,
      fileName: `index_${parsed.bundleId}.enc`,
      caption: bundleIndexCaption(parsed.bundleId),
    });

    // The new index is durable; the old one is only a stale pointer now.
    await telegramService
      .deleteMessages(group.channelId, [group.indexMessageId])
      .catch(() => undefined);

    for (const entry of remaining) {
      const existing = allItems.find(
        (candidate) =>
          candidate.channelId === group.channelId &&
          candidate.packed?.bundleMessageId === group.bundleMessageId &&
          candidate.packed.byteOffset === entry.origin.byteOffset &&
          candidate.packed.byteLength === entry.origin.byteLength,
      );
      if (!existing) continue;
      updatedItems.push({
        ...existing,
        hasThumb: entry.thumb !== null,
        packed: {
          ...entry.origin,
          bundleIndexMessageId: newIndexId,
        },
        packedThumb: entry.thumb ?? undefined,
      });
    }
  }

  return { removeIds: [...new Set(removeIds)], updatedItems };
}
