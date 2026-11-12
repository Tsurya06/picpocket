import type { PackedSliceLocation, VaultMetadata } from '../../types/media';
import type { MediaBundleEntry, MediaBundleIndex } from '../../types/bundle';
import { cryptoClient } from '../crypto/cryptoClient';
import { describeError, telegramService } from '../telegram/mtprotoClient';
import { bundleDocCaption, bundleIndexCaption, thumbCaptionFor } from '../telegram/captions';
import { prepareFile, type PreparedMedia } from './prepare';

export const MAX_PACKABLE_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
export const TARGET_BUNDLE_SIZE = 32 * 1024 * 1024; // 32 MB

export interface UploadInput {
  readonly channelId: string;
  readonly file: File;
  readonly encrypt: boolean;
  readonly caption?: string;
  readonly onProgress?: (fraction: number) => void;
  readonly signal?: AbortSignal;
  readonly onFloodWait?: (seconds: number) => void;
}

export interface UploadOutcome {
  readonly messageId?: number;
  readonly thumbMessageId?: number;
  /** Set when the original was packed into a shared container. */
  readonly packed?: PackedSliceLocation;
  /** Set when the preview was packed into the same container. */
  readonly packedThumb?: PackedSliceLocation;
  readonly bundleIndexMessageId?: number;
}

export interface BatchUploadOptions {
  readonly channelId: string;
  readonly files: readonly File[];
  readonly encrypt: boolean;
  readonly signal?: AbortSignal;
  readonly onItemStart?: (index: number, file: File) => void;
  readonly onItemProgress?: (index: number, fraction: number) => void;
  readonly onBundleProgress?: (label: string, fraction: number) => void;
  readonly onFloodWait?: (seconds: number) => void;
}

export interface BatchUploadResult {
  readonly file: File;
  readonly outcome?: UploadOutcome;
  readonly error?: string;
}

/** Sealed metadata plus base64 must stay under Telegram's 1024-char caption cap. */
const MAX_CAPTION_LENGTH = 120;
const MAX_NAME_LENGTH = 120;

const randomId = (): string => {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  }
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
};

const trimCaption = (caption: string | undefined): string | undefined => {
  if (!caption) return undefined;
  const trimmed = caption.trim().slice(0, MAX_CAPTION_LENGTH);
  return trimmed.length > 0 ? trimmed : undefined;
};

/** Keeps the extension when shortening very long camera file names. */
const trimName = (name: string): string => {
  if (name.length <= MAX_NAME_LENGTH) return name;
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : '';
  return `${name.slice(0, Math.max(1, MAX_NAME_LENGTH - extension.length))}${extension}`;
};

const report = (onProgress: ((fraction: number) => void) | undefined, value: number): void => {
  onProgress?.(Math.min(1, Math.max(0, value)));
};

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Upload cancelled.', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, Math.max(0, ms));
    const onAbort = (): void => {
      cleanup();
      reject(new DOMException('Upload cancelled.', 'AbortError'));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

const buildMeta = (
  file: File,
  prepared: PreparedMedia,
  caption: string | undefined,
): VaultMetadata => ({
  v: 1,
  mid: randomId(),
  name: trimName(file.name),
  mime: file.type || 'application/octet-stream',
  kind: prepared.kind,
  width: prepared.width,
  height: prepared.height,
  takenAt: prepared.takenAt,
  size: prepared.original.byteLength,
  duration: prepared.duration,
  caption: trimCaption(caption),
  thumbMime: prepared.thumb?.mime,
});

/**
 * Uploads one file to one channel.
 *
 * Vault mode (`encrypt: true`) never sends plaintext media: the origin is
 * sealed as a `.bin` document, the preview is sealed separately, and only an
 * encrypted metadata caption links the two.
 */
export async function uploadFile(input: UploadInput): Promise<UploadOutcome> {
  const prepared: PreparedMedia = await prepareFile(input.file);
  report(input.onProgress, 0.03);

  if (!input.encrypt) {
    const messageId = await telegramService.uploadDirect({
      channelId: input.channelId,
      file: input.file,
      kind: prepared.kind,
      caption: trimCaption(input.caption),
      width: prepared.width || undefined,
      height: prepared.height || undefined,
      duration: prepared.duration,
      onProgress: (fraction) => report(input.onProgress, 0.05 + fraction * 0.95),
      signal: input.signal,
      onFloodWait: input.onFloodWait,
    });
    report(input.onProgress, 1);
    return { messageId };
  }

  const meta = buildMeta(input.file, prepared, input.caption);
  const caption = await cryptoClient.encryptMeta(meta, input.channelId);
  report(input.onProgress, 0.08);

  let thumbMessageId: number | undefined;
  if (prepared.thumb) {
    const sealedThumb = await cryptoClient.encryptThumb(prepared.thumb.bytes, input.channelId);
    thumbMessageId = await telegramService.uploadEncrypted({
      channelId: input.channelId,
      bytes: sealedThumb,
      fileName: `${meta.mid}.preview.bin`,
      caption: thumbCaptionFor(meta.mid),
      signal: input.signal,
      onFloodWait: input.onFloodWait,
    });
  }
  report(input.onProgress, 0.12);

  const sealedOrigin = await cryptoClient.encryptBytes(prepared.original, input.channelId);
  report(input.onProgress, 0.16);

  const messageId = await telegramService.uploadEncrypted({
    channelId: input.channelId,
    bytes: sealedOrigin,
    fileName: `${meta.mid}.bin`,
    caption,
    onProgress: (fraction) => report(input.onProgress, 0.16 + fraction * 0.84),
    signal: input.signal,
    onFloodWait: input.onFloodWait,
  });
  report(input.onProgress, 1);
  return { messageId, thumbMessageId };
}

interface PendingPackedItem {
  readonly resultIndex: number;
  readonly file: File;
  readonly meta: VaultMetadata;
  readonly origin: ArrayBuffer;
  readonly thumb: ArrayBuffer | null;
}

/**
 * Uploads a batch while collapsing small vault items into ~32 MB containers.
 *
 * Each file is encrypted separately inside the worker (unique IV), so a bundle
 * is not a single all-or-nothing ciphertext. The index that maps each original
 * to its byte offset is itself encrypted and uploaded as `TGB1B:` next to the
 * bundle (`TGB1C:`). Files above 10 MB and direct-mode uploads keep the
 * standalone path, which is already chunked/streamed by mtcute.
 */
export async function uploadBatch(options: BatchUploadOptions): Promise<BatchUploadResult[]> {
  const { channelId, files, encrypt, signal } = options;
  const results: BatchUploadResult[] = files.map((file) => ({ file }));
  let pending: PendingPackedItem[] = [];
  let pendingBytes = 0;

  const flush = async (): Promise<void> => {
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    pendingBytes = 0;

    options.onBundleProgress?.(
      `Packing ${batch.length} file${batch.length === 1 ? '' : 's'} into one bundle…`,
      0,
    );

    const buffers: ArrayBuffer[] = [];
    const plan: Array<{ readonly itemIndex: number; readonly thumb: boolean }> = [];
    for (let index = 0; index < batch.length; index += 1) {
      const item = batch[index];
      if (!item) continue;
      buffers.push(item.origin);
      plan.push({ itemIndex: index, thumb: false });
      if (item.thumb) {
        buffers.push(item.thumb);
        plan.push({ itemIndex: index, thumb: true });
      }
    }

    const packed = await cryptoClient.packBundle(buffers, channelId);
    const bundleId = randomId();
    options.onBundleProgress?.('Uploading encrypted bundle…', 0.1);

    const bundleMessageId = await telegramService.uploadEncrypted({
      channelId,
      bytes: packed.bundle,
      fileName: `bundle_${bundleId}.bin`,
      caption: bundleDocCaption(bundleId),
      signal,
      onFloodWait: options.onFloodWait,
      onProgress: (fraction) =>
        options.onBundleProgress?.('Uploading encrypted bundle…', 0.1 + fraction * 0.8),
    });

    const slicesByItem = new Map<number, { origin?: PackedSliceLocation; thumb?: PackedSliceLocation }>();
    plan.forEach((step, index) => {
      const slice = packed.slices[index];
      if (!slice) return;
      const entry = slicesByItem.get(step.itemIndex) ?? {};
      const location: PackedSliceLocation = {
        bundleMessageId,
        byteOffset: slice.byteOffset,
        byteLength: slice.byteLength,
      };
      if (step.thumb) entry.thumb = location;
      else entry.origin = location;
      slicesByItem.set(step.itemIndex, entry);
    });

    const entries: MediaBundleEntry[] = batch.map((item, index) => {
      const slices = slicesByItem.get(index);
      if (!slices?.origin) throw new Error('Bundle packing lost an item.');
      return {
        meta: item.meta,
        origin: slices.origin,
        thumb: slices.thumb ?? null,
      };
    });

    const indexDocument: MediaBundleIndex = {
      v: 1,
      bundleId,
      channelId,
      createdAt: Date.now(),
      bundleMessageId,
      entries,
    };
    const indexBytes = new TextEncoder().encode(JSON.stringify(indexDocument));
    const sealedIndex = await cryptoClient.encryptBytes(
      indexBytes.buffer as ArrayBuffer,
      channelId,
    );

    options.onBundleProgress?.('Uploading sealed bundle index…', 0.95);
    const indexMessageId = await telegramService.uploadEncrypted({
      channelId,
      bytes: sealedIndex,
      fileName: `index_${bundleId}.enc`,
      caption: bundleIndexCaption(bundleId),
      signal,
      onFloodWait: options.onFloodWait,
    });

    batch.forEach((item, index) => {
      const entry = entries[index];
      if (!entry) return;
      results[item.resultIndex] = {
        file: item.file,
        outcome: {
          packed: entry.origin,
          ...(entry.thumb ? { packedThumb: entry.thumb } : {}),
          bundleIndexMessageId: indexMessageId,
        },
      };
      options.onItemProgress?.(item.resultIndex, 1);
    });
    options.onBundleProgress?.('Bundle sealed', 1);
  };

  const flushSafely = async (): Promise<void> => {
    const batch = pending;
    try {
      await flush();
    } catch (caught) {
      for (const item of batch) {
        results[item.resultIndex] = { file: item.file, error: describeError(caught) };
      }
    }
  };

  /* ------------------------------------------------------------------ */
  /* Direct Mode: Album grouping (sendMediaGroup, max 10) + Pacing       */
  /* ------------------------------------------------------------------ */
  if (!encrypt) {
    let index = 0;
    while (index < files.length) {
      if (signal?.aborted) {
        for (let i = index; i < files.length; i += 1) {
          const f = files[i];
          if (f) results[i] = { file: f, error: 'Upload cancelled.' };
        }
        break;
      }

      // Collect consecutive photos/videos to batch into an album (max 10 items)
      const albumChunk: { file: File; originalIndex: number; prepared: PreparedMedia }[] = [];

      while (index < files.length && albumChunk.length < 10) {
        const file = files[index];
        if (!file) {
          index += 1;
          continue;
        }

        try {
          const prepared = await prepareFile(file);
          if (prepared.kind === 'photo' || prepared.kind === 'video') {
            albumChunk.push({ file, originalIndex: index, prepared });
            index += 1;
          } else {
            // Non-photo/video file: if we already have an album chunk, flush it first
            if (albumChunk.length > 0) break;

            // Otherwise upload this individual document
            options.onItemStart?.(index, file);
            const outcome = await uploadFile({
              channelId,
              file,
              encrypt: false,
              signal,
              onFloodWait: options.onFloodWait,
              onProgress: (frac) => options.onItemProgress?.(index, frac),
            });
            results[index] = { file, outcome };
            index += 1;

            if (index < files.length) {
              await sleep(5000 + Math.random() * 5000, signal);
            }
          }
        } catch (err) {
          results[index] = { file, error: describeError(err) };
          index += 1;
        }
      }

      // If we collected an album chunk (up to 10 photos/videos):
      if (albumChunk.length > 0) {
        for (const item of albumChunk) {
          options.onItemStart?.(item.originalIndex, item.file);
        }

        try {
          const messageIds = await telegramService.uploadDirectAlbum({
            channelId,
            items: albumChunk.map((item) => ({
              file: item.file,
              kind: item.prepared.kind === 'video' ? 'video' : 'photo',
              width: item.prepared.width || undefined,
              height: item.prepared.height || undefined,
              duration: item.prepared.duration,
            })),
            signal,
            onFloodWait: options.onFloodWait,
            onProgress: (fraction) => {
              albumChunk.forEach((item) => {
                options.onItemProgress?.(item.originalIndex, fraction);
              });
            },
          });

          albumChunk.forEach((item, idx) => {
            results[item.originalIndex] = {
              file: item.file,
              outcome: { messageId: messageIds[idx] },
            };
            options.onItemProgress?.(item.originalIndex, 1);
          });
        } catch (caught) {
          for (const item of albumChunk) {
            results[item.originalIndex] = {
              file: item.file,
              error: describeError(caught),
            };
          }
        }

        // Pacing delay (5s - 12s) before the next album/batch
        if (index < files.length) {
          await sleep(5000 + Math.random() * 7000, signal);
        }
      }
    }

    return results;
  }

  /* ------------------------------------------------------------------ */
  /* Vault Mode: Bundled encrypted containers + Pacing                  */
  /* ------------------------------------------------------------------ */
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    if (!file) continue;
    if (signal?.aborted) {
      results[index] = { file, error: 'Upload cancelled.' };
      continue;
    }

    options.onItemStart?.(index, file);
    options.onItemProgress?.(index, 0);

    try {
      const prepared = await prepareFile(file);
      // A lone small file is cheaper as one standalone document; packing pays
      // off once at least two items can share the bundle/index overhead.
      const packable =
        files.length > 1 && file.size <= MAX_PACKABLE_FILE_SIZE;

      if (!packable) {
        const outcome = await uploadFile({
          channelId,
          file,
          encrypt,
          signal,
          onFloodWait: options.onFloodWait,
          onProgress: (fraction) => options.onItemProgress?.(index, 0.05 + fraction * 0.95),
        });
        results[index] = { file, outcome };
        if (index + 1 < files.length) {
          await sleep(4000 + Math.random() * 4000, signal);
        }
        continue;
      }

      const estimated = prepared.original.byteLength + (prepared.thumb?.bytes.byteLength ?? 0);
      if (pending.length > 0 && pendingBytes + estimated > TARGET_BUNDLE_SIZE) {
        await flushSafely();
        if (index < files.length) {
          await sleep(4000 + Math.random() * 4000, signal);
        }
      }

      pending.push({
        resultIndex: index,
        file,
        meta: buildMeta(file, prepared, undefined),
        origin: prepared.original,
        thumb: prepared.thumb?.bytes ?? null,
      });
      pendingBytes += estimated;
      options.onItemProgress?.(index, 0.15);
      options.onBundleProgress?.(
        `Queued ${pending.length} item${pending.length === 1 ? '' : 's'} for packing…`,
        0.05,
      );
    } catch (caught) {
      results[index] = { file, error: describeError(caught) };
    }
  }

  await flushSafely();
  return results;
}
