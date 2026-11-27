/**
 * WhatsApp backup engine: plan → encrypt → upload → manifest, plus restore.
 * The manifest layout matches the web app so both clients share one backup.
 */
import { Directory, File, Paths } from 'expo-file-system';
import { vault, type VaultMetadata } from '../crypto/vault';
import { telegramService } from '../telegram/service';
import { backupChunkCaption, backupManifestCaption } from '../telegram/captions';
import {
  getBackupRow,
  listWhatsAppFiles,
  putWhatsAppFile,
  saveBackupRow,
  type BackupRow,
  type WhatsAppFileRow,
} from '../db';
import {
  isWhatsAppBackupManifest,
  mediaSelectionIncludes,
  NO_MEDIA_SELECTION,
  type BackupChunkRef,
  type BackupDatabaseInfo,
  type BackupMediaRef,
  type BackupProgress,
  type DirectoryScan,
  type ScannedFile,
  type SyncPlanSummary,
  type WhatsAppBackupManifest,
  type WhatsAppMediaSelection,
} from './types';

const CHUNK_BYTES = 16 * 1024 * 1024;
const MANIFEST_FILE_NAME = 'whatsapp_backup_manifest.enc';

const noop = (): void => undefined;

const abortIfNeeded = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted) throw new DOMException('Backup cancelled.', 'AbortError');
};

const randomBackupId = (): string =>
  crypto.randomUUID().replace(/-/g, '').slice(0, 20);

const sizeOfSignature = (signature: string): string => signature.split(':')[0] ?? signature;

/** Web rows carry `size:lastModified`; matching on size keeps them deduped. */
const sameFile = (previous: string | undefined, next: string): boolean =>
  previous !== undefined &&
  (previous === next || sizeOfSignature(previous) === sizeOfSignature(next));

const mimeFor = (name: string, category: string): string => {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (category === 'image') {
    if (ext === 'png') return 'image/png';
    if (ext === 'webp') return 'image/webp';
    if (ext === 'gif') return 'image/gif';
    return 'image/jpeg';
  }
  if (category === 'video') return ext === '3gp' ? 'video/3gpp' : 'video/mp4';
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'txt') return 'text/plain';
  return 'application/octet-stream';
};

const kindFor = (category: string): VaultMetadata['kind'] =>
  category === 'image' ? 'photo' : category === 'video' ? 'video' : 'file';

interface Plan {
  readonly previous: BackupRow | null;
  readonly database: BackupDatabaseInfo | null;
  readonly databaseChanged: boolean;
  readonly pendingMedia: readonly ScannedFile[];
  readonly existingRows: Map<string, WhatsAppFileRow>;
}

const parseDbInfo = (row: BackupRow | null): BackupDatabaseInfo | null => {
  if (!row?.dbInfo) return null;
  try {
    const parsed = JSON.parse(row.dbInfo) as BackupDatabaseInfo;
    return parsed && typeof parsed.name === 'string' ? parsed : null;
  } catch {
    return null;
  }
};

async function planSync(
  channelId: string,
  scan: DirectoryScan,
  media: WhatsAppMediaSelection,
): Promise<Plan> {
  const [previous, rows] = await Promise.all([
    getBackupRow(channelId),
    listWhatsAppFiles(channelId),
  ]);
  const existingRows = new Map(rows.map((row) => [row.path, row]));
  const previousDb = parseDbInfo(previous);
  const candidate = scan.latestDatabase;

  const pendingMedia = scan.media.filter((entry) => {
    if (!mediaSelectionIncludes(media, entry.category)) return false;
    return !sameFile(existingRows.get(entry.path)?.signature, entry.signature);
  });

  const databaseChanged =
    candidate !== null &&
    (previousDb === null ||
      !sameFile(previous?.dbSignature ?? undefined, candidate.signature) ||
      previous?.dbPath !== candidate.path ||
      previousDb.path !== candidate.path);

  return {
    previous,
    database: databaseChanged ? null : previousDb,
    databaseChanged,
    pendingMedia,
    existingRows,
  };
}

export async function previewWhatsAppSync(
  channelId: string,
  scan: DirectoryScan,
  media: WhatsAppMediaSelection,
): Promise<SyncPlanSummary> {
  const plan = await planSync(channelId, scan, media);
  return {
    pendingMediaCount: plan.pendingMedia.length,
    pendingBytes: plan.pendingMedia.reduce((sum, entry) => sum + entry.size, 0),
    databaseChanged: plan.databaseChanged,
    databaseName: scan.latestDatabase?.name ?? plan.database?.name ?? null,
    databaseSize: scan.latestDatabase?.size ?? plan.database?.size ?? 0,
  };
}

/** Streams one chunk of the database off disk without loading the whole file. */
async function* readDatabaseChunks(
  file: File,
  onChunk: (bytes: Uint8Array, index: number, total: number) => void,
): AsyncGenerator<{ bytes: Uint8Array; size: number; total: number }> {
  const total = Math.max(1, Math.ceil((typeof file.size === 'number' ? file.size : 0) / CHUNK_BYTES));
  try {
    const handle = file.open();
    try {
      for (let index = 0; index < total; index += 1) {
        const bytes = await handle.readBytes(CHUNK_BYTES);
        if (bytes.byteLength === 0) break;
        onChunk(bytes, index, total);
        yield { bytes, size: bytes.byteLength, total };
      }
    } finally {
      handle.close();
    }
  } catch (error) {
    // SAF folders occasionally refuse a handle; fall back to one full read.
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    const all = await file.bytes();
    const totalChunks = Math.max(1, Math.ceil(all.byteLength / CHUNK_BYTES));
    for (let index = 0; index < totalChunks; index += 1) {
      const bytes = all.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES);
      onChunk(bytes, index, totalChunks);
      yield { bytes, size: bytes.byteLength, total: totalChunks };
    }
  }
}

async function uploadDatabaseChunks(
  channelId: string,
  backupId: string,
  entry: ScannedFile,
  onProgress: (chunksDone: number, chunksTotal: number, bytesDone: number) => void,
  signal?: AbortSignal,
  onFloodWait?: (seconds: number) => void,
): Promise<BackupDatabaseInfo> {
  const chunks: BackupChunkRef[] = [];
  let done = 0;
  let bytesDone = 0;
  for await (const chunk of readDatabaseChunks(entry.file, (bytes, index, total) => {
    void bytes;
    void index;
    void total;
  })) {
    abortIfNeeded(signal);
    const sealed = vault.encryptChunk(chunk.bytes);
    const messageId = await telegramService.uploadEncrypted({
      channelId,
      bytes: sealed,
      fileName: `${backupId}.db.${String(done).padStart(4, '0')}.bin`,
      caption: backupChunkCaption(backupId, done, chunk.total),
      ...(signal ? { signal } : {}),
      ...(onFloodWait ? { onFloodWait } : {}),
    });
    chunks.push({ index: done, messageId, size: chunk.size });
    done += 1;
    bytesDone += chunk.size;
    onProgress(done, chunk.total, bytesDone);
  }

  if (chunks.length === 0) throw new Error('The chat database could not be read.');
  return {
    name: entry.name,
    path: entry.path,
    size: entry.size,
    lastModified: 0,
    chunks,
  };
}

async function uploadManifest(manifest: WhatsAppBackupManifest, signal?: AbortSignal): Promise<number> {
  const json = new TextEncoder().encode(JSON.stringify(manifest));
  return telegramService.uploadEncrypted({
    channelId: manifest.channelId,
    bytes: vault.encryptChunk(json),
    fileName: MANIFEST_FILE_NAME,
    caption: backupManifestCaption(manifest.backupId),
    ...(signal ? { signal } : {}),
  });
}

export interface SyncOptions {
  readonly channelId: string;
  readonly scan: DirectoryScan;
  readonly media?: WhatsAppMediaSelection;
  readonly onProgress?: (progress: BackupProgress) => void;
  readonly signal?: AbortSignal;
}

export interface SyncResult {
  readonly manifest: WhatsAppBackupManifest;
  readonly uploadedMedia: number;
  readonly uploadedChunks: number;
  readonly databaseUploaded: boolean;
}

export async function syncWhatsAppBackup(options: SyncOptions): Promise<SyncResult> {
  const { channelId, scan, signal } = options;
  const mediaSelection = options.media ?? NO_MEDIA_SELECTION;
  const onProgress = options.onProgress ?? noop;
  const plan = await planSync(channelId, scan, mediaSelection);
  const backupId = randomBackupId();
  const createdAt = Date.now();
  const candidate = scan.latestDatabase;

  let database = plan.database;
  let databaseUploaded = false;
  let uploadedChunks = 0;
  let bytesDone = database?.size ?? 0;
  const bytesTotal =
    (candidate?.size ?? database?.size ?? 0) +
    plan.pendingMedia.reduce((sum, entry) => sum + entry.size, 0);

  if (candidate && plan.databaseChanged) {
    database = await uploadDatabaseChunks(
      channelId,
      backupId,
      candidate,
      (done, total, chunkBytes) => {
        uploadedChunks = done;
        bytesDone = chunkBytes;
        onProgress({
          phase: 'database',
          fraction: done / total,
          label: `Encrypting ${candidate.name} — chunk ${done} of ${total}`,
          chunksDone: done,
          chunksTotal: total,
          filesDone: 0,
          filesTotal: plan.pendingMedia.length,
          bytesDone,
          bytesTotal,
        });
      },
      signal,
      (seconds) => {
        onProgress({
          phase: 'database',
          fraction: 0,
          label: `Telegram rate limit — resuming in ${seconds}s`,
          chunksDone: uploadedChunks,
          chunksTotal: 0,
          filesDone: 0,
          filesTotal: plan.pendingMedia.length,
          bytesDone,
          bytesTotal,
        });
      },
    );
    databaseUploaded = true;
    bytesDone = candidate.size;
    await saveBackupRow(channelId, {
      dbSignature: candidate.signature,
      dbName: candidate.name,
      dbPath: candidate.path,
      dbInfo: JSON.stringify(database),
      mediaCount: plan.existingRows.size,
      totalBytes: database.size,
      updatedAt: Date.now(),
    });
  } else if (database) {
    onProgress({
      phase: 'database',
      fraction: 1,
      label: 'Chat database unchanged — reusing the existing chunks',
      chunksDone: database.chunks.length,
      chunksTotal: database.chunks.length,
      filesDone: 0,
      filesTotal: plan.pendingMedia.length,
      bytesDone,
      bytesTotal,
    });
  }

  let uploadedMedia = 0;
  for (const entry of plan.pendingMedia) {
    abortIfNeeded(signal);
    const meta: VaultMetadata = {
      v: 1,
      mid: `${createdAt}-${uploadedMedia}`,
      name: entry.name,
      mime: mimeFor(entry.name, entry.category),
      kind: kindFor(entry.category),
      width: 0,
      height: 0,
      takenAt: 0,
      size: entry.size,
    };
    const plain = await entry.file.bytes();
    const sealed = vault.encryptBytes(plain, channelId);
    const messageId = await telegramService.uploadEncrypted({
      channelId,
      bytes: sealed,
      fileName: entry.name,
      caption: vault.encryptMeta(meta, channelId),
      ...(signal ? { signal } : {}),
      onProgress: (fraction) => {
        onProgress({
          phase: 'media',
          fraction: (uploadedMedia + fraction) / Math.max(1, plan.pendingMedia.length),
          label: `Uploading ${entry.name} (${uploadedMedia + 1} of ${plan.pendingMedia.length})`,
          chunksDone: 0,
          chunksTotal: 0,
          filesDone: uploadedMedia,
          filesTotal: plan.pendingMedia.length,
          bytesDone: bytesDone + entry.size * fraction,
          bytesTotal,
        });
      },
    });
    await putWhatsAppFile(channelId, {
      path: entry.path,
      signature: entry.signature,
      category: entry.category,
      size: entry.size,
      lastModified: 0,
      messageId,
    });
    uploadedMedia += 1;
    bytesDone += entry.size;
    onProgress({
      phase: 'media',
      fraction: uploadedMedia / Math.max(1, plan.pendingMedia.length),
      label: `Uploaded ${entry.name} (${uploadedMedia} of ${plan.pendingMedia.length})`,
      chunksDone: 0,
      chunksTotal: 0,
      filesDone: uploadedMedia,
      filesTotal: plan.pendingMedia.length,
      bytesDone,
      bytesTotal,
    });
  }

  const rows = await listWhatsAppFiles(channelId);
  const mediaRefs: BackupMediaRef[] = rows
    .map((row) => ({
      path: row.path,
      category: row.category as BackupMediaRef['category'],
      size: row.size,
      lastModified: row.lastModified,
      ...(row.messageId !== undefined ? { messageId: row.messageId } : {}),
    }))
    .filter((ref) => ref.messageId !== undefined)
    .sort((a, b) => a.path.localeCompare(b.path));

  const manifest: WhatsAppBackupManifest = {
    v: 1,
    backupId,
    channelId,
    createdAt,
    database,
    media: mediaRefs,
    totalBytes: (database?.size ?? 0) + mediaRefs.reduce((sum, ref) => sum + ref.size, 0),
  };

  onProgress({
    phase: 'manifest',
    fraction: 0.6,
    label: 'Sealing the backup index',
    chunksDone: 0,
    chunksTotal: 0,
    filesDone: uploadedMedia,
    filesTotal: plan.pendingMedia.length,
    bytesDone,
    bytesTotal,
  });
  const manifestId = await uploadManifest(manifest, signal);

  await saveBackupRow(channelId, {
    dbSignature: candidate?.signature ?? plan.previous?.dbSignature ?? null,
    dbName: database?.name ?? null,
    dbPath: database?.path ?? null,
    dbInfo: database ? JSON.stringify(database) : (plan.previous?.dbInfo ?? null),
    mediaCount: mediaRefs.length,
    totalBytes: manifest.totalBytes,
    updatedAt: Date.now(),
  });

  onProgress({
    phase: 'done',
    fraction: 1,
    label: `Backup complete — ${mediaRefs.length} media files, index message ${manifestId}`,
    chunksDone: database?.chunks.length ?? 0,
    chunksTotal: database?.chunks.length ?? 0,
    filesDone: uploadedMedia,
    filesTotal: plan.pendingMedia.length,
    bytesDone: bytesTotal,
    bytesTotal,
  });

  return { manifest, uploadedMedia, uploadedChunks, databaseUploaded };
}

/** Newest sealed manifest found in the channel, or null. */
export async function loadRemoteWhatsAppBackup(
  channelId: string,
): Promise<WhatsAppBackupManifest | null> {
  const ids = await telegramService.findBackupManifests(channelId);
  for (const messageId of [...ids].sort((a, b) => b - a)) {
    try {
      const raw = await telegramService.downloadOriginal(channelId, messageId);
      const plain = vault.decryptChunk(raw);
      const parsed: unknown = JSON.parse(new TextDecoder().decode(plain));
      if (isWhatsAppBackupManifest(parsed)) return parsed;
    } catch {
      // A corrupt manifest must not block an older one.
    }
  }
  return null;
}

export interface RestoreOutcome {
  readonly fileName: string;
  readonly bytes: number;
  readonly location: 'whatsapp' | 'cache';
}

/**
 * Downloads the sealed database back into the WhatsApp `Databases` folder. The
 * chunks are streamed into the cache first, then copied to the picked folder.
 */
export async function restoreWhatsAppDatabase(
  manifest: WhatsAppBackupManifest,
  target: Directory | null,
  options: { signal?: AbortSignal; onProgress?: (progress: BackupProgress) => void } = {},
): Promise<RestoreOutcome> {
  const database = manifest.database;
  if (!database) throw new Error('This backup does not contain a chat database.');
  const onProgress = options.onProgress ?? noop;
  const chunks = [...database.chunks].sort((a, b) => a.index - b.index);
  if (chunks.length === 0) throw new Error('The backup lists no database chunks.');

  const cacheFile = new File(Paths.cache, `restore-${manifest.backupId}.crypt`);
  if (cacheFile.exists) cacheFile.delete();
  cacheFile.create({ intermediates: true });
  const handle = cacheFile.open();
  let bytesDone = 0;

  try {
    for (let index = 0; index < chunks.length; index += 1) {
      abortIfNeeded(options.signal);
      const chunk = chunks[index];
      if (!chunk) continue;
      const raw = await telegramService.downloadOriginal(manifest.channelId, chunk.messageId, {
        ...(options.signal ? { signal: options.signal } : {}),
        onProgress: (fraction) => {
          onProgress({
            phase: 'restore',
            fraction: (index + fraction) / chunks.length,
            label: `Downloading database chunk ${index + 1} of ${chunks.length}`,
            chunksDone: index,
            chunksTotal: chunks.length,
            filesDone: 0,
            filesTotal: 0,
            bytesDone: bytesDone + chunk.size * fraction,
            bytesTotal: database.size,
          });
        },
      });
      const plain = vault.decryptChunk(raw);
      await handle.writeBytes(plain);
      bytesDone += plain.byteLength;
      onProgress({
        phase: 'restore',
        fraction: (index + 1) / chunks.length,
        label: `Restored database chunk ${index + 1} of ${chunks.length}`,
        chunksDone: index + 1,
        chunksTotal: chunks.length,
        filesDone: 0,
        filesTotal: 0,
        bytesDone,
        bytesTotal: database.size,
      });
    }
  } finally {
    handle.close();
  }

  if (!target) {
    return { fileName: cacheFile.name, bytes: bytesDone, location: 'cache' };
  }

  let destination: File;
  try {
    destination = target.createFile(database.name, 'application/octet-stream');
  } catch {
    // The file already exists in that folder: overwrite it in place.
    destination = new File(target, database.name);
    if (!destination.exists) destination.create();
  }
  try {
    await cacheFile.copy(destination);
  } catch {
    await destination.write(await cacheFile.bytes());
  }
  if (cacheFile.exists) cacheFile.delete();
  return { fileName: database.name, bytes: bytesDone, location: 'whatsapp' };
}

/** Rebuilds the local index from a manifest (used after restoring on a new phone). */
export async function adoptRemoteManifest(manifest: WhatsAppBackupManifest): Promise<void> {
  for (const ref of manifest.media) {
    await putWhatsAppFile(manifest.channelId, {
      path: ref.path,
      signature: `${ref.size}:${ref.lastModified}`,
      category: ref.category,
      size: ref.size,
      lastModified: ref.lastModified,
      ...(ref.messageId !== undefined ? { messageId: ref.messageId } : {}),
    });
  }
}
