/**
 * WhatsApp Backup & Sync
 *
 * Lets a user point at their local `WhatsApp/` folder, discovers chat databases
 * and media, and uploads only what changed to a Telegram channel:
 *
 *  - `msgstore*.db.crypt15` (fallback `.crypt14`) is sliced into 16 MB blobs,
 *    each encrypted separately with AES-256-GCM and uploaded as a document.
 *  - media files flow through the regular vault pipeline (sanitised thumbs for
 *    images/videos, sealed originals), and only new/changed files are uploaded.
 *  - a sealed `whatsapp_backup_manifest.enc` document records the ordered chunk
 *    message ids and media references, so a fresh install can restore.
 *
 * Dedupe uses `path + size + lastModified` signatures against the local Dexie
 * manifest (`whatsappFiles`). Nothing is uploaded twice unless it changed.
 */
import type {
  BackupChunkRef,
  BackupDatabaseInfo,
  BackupMediaRef,
  BackupProgress,
  DirectoryScan,
  RestoreResult,
  ScannedWhatsAppFile,
  SyncPlanSummary,
  WhatsAppBackupManifest,
  WhatsAppCategory,
  WhatsAppLocalSummary,
} from '../../types/whatsapp';
import { isWhatsAppBackupManifest } from '../../types/whatsapp';
import {
  getWhatsAppBackup,
  getWhatsAppFiles,
  putWhatsAppBackup,
  putWhatsAppFiles,
  type WhatsAppBackupRow,
  type WhatsAppFileRow,
} from '../cache/db';
import { cryptoClient } from '../crypto/cryptoClient';
import { uploadBatch } from '../media/uploader';
import { backupChunkCaption, backupManifestCaption } from '../telegram/captions';
import { telegramService } from '../telegram/mtprotoClient';

export const WHATSAPP_CHUNK_BYTES = 16 * 1024 * 1024;
const MAX_SCAN_FILES = 60_000;
const MAX_SCAN_DEPTH = 16;
const MANIFEST_FILE_NAME = 'whatsapp_backup_manifest.enc';

const DATABASE_PATTERN = /^msgstore.*\.db\.crypt1[45]$/i;
const IGNORED_NAME = /^(\.|thumbs\.db$|desktop\.ini$)/i;
const IGNORED_EXTENSION = /\.(tmp|nomedia|part|log)$/i;

const noop = (): void => undefined;

/* ------------------------------------------------------------------ */
/* Scanning                                                           */
/* ------------------------------------------------------------------ */

export function supportsDirectoryPicker(): boolean {
  if (typeof window === 'undefined') return false;
  return typeof (window as unknown as PickerWindow).showDirectoryPicker === 'function';
}

interface PickerWindow {
  showDirectoryPicker?: (options?: {
    id?: string;
    mode?: 'read' | 'readwrite';
  }) => Promise<FileSystemDirectoryHandle>;
}

interface RawEntry {
  readonly file: File;
  readonly path: string;
}

const normalisePath = (path: string): string => path.replace(/\\/g, '/').replace(/^\/+/, '');

const shouldSkip = (path: string, file: File): boolean => {
  const name = file.name;
  if (file.size === 0) return true;
  if (IGNORED_NAME.test(name) || IGNORED_EXTENSION.test(name)) return true;
  return path.split('/').some((segment) => segment === '__MACOSX');
};

export function signatureFor(file: File): string {
  return `${file.size}:${file.lastModified}`;
}

/**
 * Categorises by folder first (WhatsApp's own folder names) and falls back to
 * MIME type, so a user who picks `Android/media/com.whatsapp/WhatsApp` gets
 * the same result as one who picks a copied backup tree.
 */
export function categorizeWhatsAppFile(path: string, file: File): WhatsAppCategory {
  const lower = normalisePath(path).toLowerCase();
  const segments = lower.split('/');
  const name = file.name.toLowerCase();
  const hasSegment = (needle: string): boolean =>
    segments.some((segment) => segment.includes(needle));

  if (DATABASE_PATTERN.test(name) || /^wa\.db$/.test(name) || segments.includes('databases')) {
    return 'database';
  }
  if (hasSegment('voice notes') || hasSegment('voice')) return 'voice';
  if (hasSegment('whatsapp images') || segments.includes('images')) return 'image';
  if (hasSegment('whatsapp video') || segments.includes('video')) return 'video';
  if (hasSegment('whatsapp documents') || segments.includes('documents')) return 'document';
  if (hasSegment('whatsapp audio') || segments.includes('audio')) return 'audio';
  if (hasSegment('animated gifs') || hasSegment('stickers') || hasSegment('profile photos')) {
    return 'image';
  }

  const mime = file.type;
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';

  if (file.name.includes('.')) return 'other';
  return 'other';
}

function buildScan(rootName: string, raw: readonly RawEntry[], skipped: number): DirectoryScan {
  const files: ScannedWhatsAppFile[] = raw.map((entry) => ({
    file: entry.file,
    path: normalisePath(entry.path),
    category: categorizeWhatsAppFile(entry.path, entry.file),
    signature: signatureFor(entry.file),
  }));

  const candidates = files
    .filter((entry) => entry.category === 'database' && DATABASE_PATTERN.test(entry.file.name))
    .sort((a, b) => {
      const a15 = /crypt15$/i.test(a.file.name) ? 1 : 0;
      const b15 = /crypt15$/i.test(b.file.name) ? 1 : 0;
      if (a15 !== b15) return b15 - a15;
      if (b.file.lastModified !== a.file.lastModified) {
        return b.file.lastModified - a.file.lastModified;
      }
      return b.file.size - a.file.size;
    });

  const media = files.filter((entry) => entry.category !== 'database');
  const totalBytes = files.reduce((sum, entry) => sum + entry.file.size, 0);

  return {
    rootName,
    files,
    latestDatabase: candidates[0] ?? null,
    media,
    totalBytes,
    skipped,
  };
}

interface WalkState {
  skipped: number;
}

/** `values()` exists in browsers but is missing from this TypeScript DOM lib. */
interface WalkableDirectory extends FileSystemDirectoryHandle {
  values(): AsyncIterableIterator<FileSystemDirectoryHandle | FileSystemFileHandle>;
}

async function walkDirectory(
  directory: FileSystemDirectoryHandle,
  prefix: string,
  out: RawEntry[],
  depth: number,
  state: WalkState,
): Promise<void> {
  if (depth > MAX_SCAN_DEPTH || out.length >= MAX_SCAN_FILES) return;

  for await (const entry of (directory as WalkableDirectory).values()) {
    if (out.length >= MAX_SCAN_FILES) return;
    if (entry.kind === 'directory') {
      await walkDirectory(
        entry as FileSystemDirectoryHandle,
        `${prefix}${entry.name}/`,
        out,
        depth + 1,
        state,
      );
      continue;
    }

    const handle = entry as FileSystemFileHandle;
    const file = await handle.getFile();
    const path = `${prefix}${file.name}`;
    if (shouldSkip(path, file)) {
      state.skipped += 1;
      continue;
    }
    out.push({ file, path });
  }
}

/** Opens the native folder picker (Chromium/Edge desktop) and walks the tree. */
export async function pickWhatsAppDirectory(): Promise<DirectoryScan> {
  const picker = (window as unknown as PickerWindow).showDirectoryPicker;
  if (!picker) {
    throw new Error(
      'This browser cannot open a folder picker. Use the file fallback and select the WhatsApp folder instead.',
    );
  }

  const handle = await picker.call(window, { id: 'whatsapp-vault', mode: 'read' });
  const raw: RawEntry[] = [];
  const state: WalkState = { skipped: 0 };
  await walkDirectory(handle, '', raw, 0, state);
  return buildScan(handle.name, raw, state.skipped);
}

/**
 * Fallback for browsers without `showDirectoryPicker`: `<input webkitdirectory>`.
 * `File.webkitRelativePath` preserves the folder structure we categorise on.
 */
export function scanWhatsAppFiles(files: FileList | readonly File[]): DirectoryScan {
  const raw: RawEntry[] = [];
  let skipped = 0;

  for (const file of Array.from(files)) {
    const path = normalisePath(file.webkitRelativePath || file.name);
    if (shouldSkip(path, file)) {
      skipped += 1;
      continue;
    }
    raw.push({ file, path });
    if (raw.length >= MAX_SCAN_FILES) break;
  }

  const rootName = raw[0]?.path.split('/')[0] ?? 'WhatsApp';
  return buildScan(rootName, raw, skipped);
}

/* ------------------------------------------------------------------ */
/* Differential plan                                                  */
/* ------------------------------------------------------------------ */

interface SyncPlan {
  readonly previous: WhatsAppBackupRow | undefined;
  readonly database: BackupDatabaseInfo | null;
  readonly databaseChanged: boolean;
  readonly pendingMedia: ScannedWhatsAppFile[];
  readonly existingRows: Map<string, WhatsAppFileRow>;
}

const parseDbInfo = (row: WhatsAppBackupRow | undefined): BackupDatabaseInfo | null => {
  if (!row?.dbInfoJson) return null;
  try {
    const parsed = JSON.parse(row.dbInfoJson) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const db = parsed as Record<string, unknown>;
    if (
      typeof db.name !== 'string' ||
      typeof db.path !== 'string' ||
      typeof db.size !== 'number' ||
      typeof db.lastModified !== 'number' ||
      !Array.isArray(db.chunks)
    ) {
      return null;
    }
    const chunks: BackupChunkRef[] = [];
    for (const raw of db.chunks) {
      if (typeof raw !== 'object' || raw === null) continue;
      const chunk = raw as Record<string, unknown>;
      if (
        typeof chunk.index === 'number' &&
        typeof chunk.messageId === 'number' &&
        typeof chunk.size === 'number'
      ) {
        chunks.push({ index: chunk.index, messageId: chunk.messageId, size: chunk.size });
      }
    }
    return {
      name: db.name,
      path: db.path,
      size: db.size,
      lastModified: db.lastModified,
      chunks,
    };
  } catch {
    return null;
  }
};

async function planSync(channelId: string, scan: DirectoryScan): Promise<SyncPlan> {
  const [previous, rows] = await Promise.all([
    getWhatsAppBackup(channelId),
    getWhatsAppFiles(channelId),
  ]);
  const existingRows = new Map(rows.map((row) => [row.path, row]));
  const previousDb = parseDbInfo(previous);
  const candidate = scan.latestDatabase;

  const pendingMedia = scan.media.filter((entry) => {
    const row = existingRows.get(entry.path);
    return !row || row.signature !== entry.signature;
  });

  const databaseChanged =
    candidate !== null &&
    (previousDb === null ||
      previous?.dbSignature !== candidate.signature ||
      previous.dbName !== candidate.path ||
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
): Promise<SyncPlanSummary> {
  const plan = await planSync(channelId, scan);
  return {
    pendingMediaCount: plan.pendingMedia.length,
    pendingBytes: plan.pendingMedia.reduce((sum, entry) => sum + entry.file.size, 0),
    databaseChanged: plan.databaseChanged,
    databaseName: scan.latestDatabase?.file.name ?? plan.database?.name ?? null,
    databaseSize: scan.latestDatabase?.file.size ?? plan.database?.size ?? 0,
  };
}

/* ------------------------------------------------------------------ */
/* Uploading                                                          */
/* ------------------------------------------------------------------ */

const throwIfAborted = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted) throw new DOMException('Backup cancelled.', 'AbortError');
};

const randomBackupId = (): string =>
  crypto.randomUUID().replace(/-/g, '').slice(0, 20);

async function uploadDatabaseChunks(
  channelId: string,
  backupId: string,
  entry: ScannedWhatsAppFile,
  onProgress: (chunksDone: number, chunksTotal: number) => void,
  signal?: AbortSignal,
  onFloodWait?: (seconds: number) => void,
): Promise<BackupDatabaseInfo> {
  const total = Math.max(1, Math.ceil(entry.file.size / WHATSAPP_CHUNK_BYTES));
  const chunks: BackupChunkRef[] = [];

  for (let index = 0; index < total; index += 1) {
    throwIfAborted(signal);
    const start = index * WHATSAPP_CHUNK_BYTES;
    const end = Math.min(entry.file.size, start + WHATSAPP_CHUNK_BYTES);
    const slice = entry.file.slice(start, end);
    const plain = await slice.arrayBuffer();
    const sealed = await cryptoClient.encryptChunk(plain);
    const messageId = await telegramService.uploadEncrypted({
      channelId,
      bytes: sealed,
      fileName: `${backupId}.db.${String(index).padStart(4, '0')}.bin`,
      caption: backupChunkCaption(backupId, index, total),
      signal,
      onFloodWait,
    });
    chunks.push({ index, messageId, size: slice.size });
    onProgress(index + 1, total);
  }

  return {
    name: entry.file.name,
    path: entry.path,
    size: entry.file.size,
    lastModified: entry.file.lastModified,
    chunks,
  };
}

async function uploadManifest(
  manifest: WhatsAppBackupManifest,
  signal?: AbortSignal,
): Promise<number> {
  const json = new TextEncoder().encode(JSON.stringify(manifest));
  const sealed = await cryptoClient.encryptChunk(json.buffer);
  return telegramService.uploadEncrypted({
    channelId: manifest.channelId,
    bytes: sealed,
    fileName: MANIFEST_FILE_NAME,
    caption: backupManifestCaption(manifest.backupId),
    signal,
  });
}

const mediaRefFromRow = (row: WhatsAppFileRow): BackupMediaRef | null => {
  const base = {
    path: row.path,
    category: row.category,
    size: row.size,
    lastModified: row.lastModified,
    ...(row.bundleIndexMessageId !== undefined
      ? { bundleIndexMessageId: row.bundleIndexMessageId }
      : {}),
  };

  if (row.messageId !== undefined) {
    return {
      ...base,
      messageId: row.messageId,
      ...(row.thumbMessageId !== undefined ? { thumbMessageId: row.thumbMessageId } : {}),
    };
  }
  if (!row.packed) return null;
  return {
    ...base,
    packed: row.packed,
    ...(row.packedThumb ? { packedThumb: row.packedThumb } : {}),
  };
};

const collectMediaRefs = (rows: Iterable<WhatsAppFileRow>): BackupMediaRef[] => {
  const refs: BackupMediaRef[] = [];
  for (const row of rows) {
    const ref = mediaRefFromRow(row);
    if (ref) refs.push(ref);
  }
  return refs.sort((a, b) => a.path.localeCompare(b.path));
};

const deleteSuperseded = (channelId: string, row: WhatsAppFileRow | undefined): void => {
  if (!row) return;
  // A packed file shares its message with other files; removing one slice
  // would destroy unrelated entries, so those bundles are left in place.
  if (row.packed) return;
  const ids = [row.messageId, row.thumbMessageId].filter(
    (id): id is number => typeof id === 'number',
  );
  if (ids.length === 0) return;
  void telegramService.deleteMessages(channelId, ids).catch(() => undefined);
};

export interface SyncOptions {
  readonly channelId: string;
  readonly scan: DirectoryScan;
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
  const onProgress = options.onProgress ?? noop;
  const plan = await planSync(channelId, scan);
  const backupId = randomBackupId();
  const createdAt = Date.now();
  const candidate = scan.latestDatabase;

  let database = plan.database;
  let databaseUploaded = false;
  let uploadedChunks = 0;
  let bytesDone = database?.size ?? 0;
  const bytesTotal = scan.totalBytes;

  if (candidate && plan.databaseChanged) {
    database = await uploadDatabaseChunks(
      channelId,
      backupId,
      candidate,
      (chunksDone, total) => {
        uploadedChunks = chunksDone;
        bytesDone = candidate.file.size * (chunksDone / total);
        onProgress({
          phase: 'database',
          fraction: chunksDone / total,
          label: `Encrypting ${candidate.file.name} — chunk ${chunksDone} of ${total}`,
          chunksDone,
          chunksTotal: total,
          filesDone: 0,
          filesTotal: plan.pendingMedia.length,
          bytesDone,
          bytesTotal,
        });
      },
      signal,
      (seconds) => {
        const totalChunks = Math.max(1, Math.ceil(candidate.file.size / WHATSAPP_CHUNK_BYTES));
        onProgress({
          phase: 'database',
          fraction: uploadedChunks / totalChunks,
          label: `Telegram rate limit — resuming in ${seconds}s`,
          chunksDone: uploadedChunks,
          chunksTotal: totalChunks,
          filesDone: 0,
          filesTotal: plan.pendingMedia.length,
          bytesDone,
          bytesTotal,
        });
      },
    );
    databaseUploaded = true;
    bytesDone = candidate.file.size;
  } else if (database) {
    onProgress({
      phase: 'database',
      fraction: 1,
      label: 'Chat database unchanged — reusing the existing chunks',
      chunksDone: database.chunks.length,
      chunksTotal: database.chunks.length,
      filesDone: 0,
      filesTotal: plan.pendingMedia.length,
      bytesDone: database.size,
      bytesTotal,
    });
  }

  const totalPending = plan.pendingMedia.length;
  let uploadedMedia = 0;

  if (totalPending > 0) {
    const results = await uploadBatch({
      channelId,
      files: plan.pendingMedia.map((entry) => entry.file),
      encrypt: true,
      signal,
      onItemStart: (index) => {
        const entry = plan.pendingMedia[index];
        if (!entry) return;
        onProgress({
          phase: 'media',
          fraction: index / totalPending,
          label: `Encrypting ${entry.file.name}`,
          chunksDone: uploadedChunks,
          chunksTotal: database?.chunks.length ?? 0,
          filesDone: index,
          filesTotal: totalPending,
          bytesDone,
          bytesTotal,
        });
      },
      onItemProgress: (index, fraction) => {
        const entry = plan.pendingMedia[index];
        if (!entry) return;
        onProgress({
          phase: 'media',
          fraction: (index + fraction) / totalPending,
          label: `Encrypting ${entry.file.name}`,
          chunksDone: uploadedChunks,
          chunksTotal: database?.chunks.length ?? 0,
          filesDone: index,
          filesTotal: totalPending,
          bytesDone: bytesDone + entry.file.size * fraction,
          bytesTotal,
        });
      },
      onBundleProgress: (label, fraction) => {
        onProgress({
          phase: 'media',
          fraction,
          label,
          chunksDone: uploadedChunks,
          chunksTotal: database?.chunks.length ?? 0,
          filesDone: uploadedMedia,
          filesTotal: totalPending,
          bytesDone,
          bytesTotal,
        });
      },
      onFloodWait: (seconds) => {
        onProgress({
          phase: 'media',
          fraction: uploadedMedia / totalPending,
          label: `Telegram rate limit — resuming in ${seconds}s`,
          chunksDone: uploadedChunks,
          chunksTotal: database?.chunks.length ?? 0,
          filesDone: uploadedMedia,
          filesTotal: totalPending,
          bytesDone,
          bytesTotal,
        });
      },
    });

    const failures: string[] = [];
    for (let index = 0; index < totalPending; index += 1) {
      throwIfAborted(signal);
      const entry = plan.pendingMedia[index];
      const result = results[index];
      if (!entry) continue;
      if (!result?.outcome) {
        failures.push(`${entry.file.name}: ${result?.error ?? 'upload failed'}`);
        continue;
      }

      const outcome = result.outcome;
      const previousRow = plan.existingRows.get(entry.path);
      const row: WhatsAppFileRow = {
        channelId,
        path: entry.path,
        category: entry.category,
        signature: entry.signature,
        size: entry.file.size,
        lastModified: entry.file.lastModified,
        uploadedAt: Date.now(),
        ...(outcome.messageId !== undefined ? { messageId: outcome.messageId } : {}),
        ...(outcome.thumbMessageId !== undefined
          ? { thumbMessageId: outcome.thumbMessageId }
          : {}),
        ...(outcome.packed ? { packed: outcome.packed } : {}),
        ...(outcome.packedThumb ? { packedThumb: outcome.packedThumb } : {}),
        ...(outcome.bundleIndexMessageId !== undefined
          ? { bundleIndexMessageId: outcome.bundleIndexMessageId }
          : {}),
      };
      await putWhatsAppFiles([row]);
      if (previousRow && previousRow.signature !== row.signature) {
        deleteSuperseded(channelId, previousRow);
      }
      plan.existingRows.set(entry.path, row);

      uploadedMedia += 1;
      bytesDone += entry.file.size;
      onProgress({
        phase: 'media',
        fraction: (index + 1) / totalPending,
        label: `Encrypted ${entry.file.name}`,
        chunksDone: uploadedChunks,
        chunksTotal: database?.chunks.length ?? 0,
        filesDone: index + 1,
        filesTotal: totalPending,
        bytesDone,
        bytesTotal,
      });
    }

    if (failures.length > 0) {
      throw new Error(
        `${failures.length} WhatsApp file${failures.length === 1 ? '' : 's'} could not be backed up: ${failures
          .slice(0, 3)
          .join('; ')}`,
      );
    }
  }

  throwIfAborted(signal);
  const media = collectMediaRefs(plan.existingRows.values());
  const manifest: WhatsAppBackupManifest = {
    v: 1,
    backupId,
    channelId,
    createdAt,
    database,
    media,
    totalBytes: (database?.size ?? 0) + media.reduce((sum, ref) => sum + ref.size, 0),
  };

  onProgress({
    phase: 'manifest',
    fraction: 0,
    label: 'Sealing the backup manifest',
    chunksDone: uploadedChunks,
    chunksTotal: database?.chunks.length ?? 0,
    filesDone: totalPending,
    filesTotal: totalPending,
    bytesDone: manifest.totalBytes,
    bytesTotal: manifest.totalBytes,
  });

  const manifestMessageId = await uploadManifest(manifest, signal);

  await putWhatsAppBackup({
    channelId,
    backupId,
    createdAt,
    dbName: database?.name ?? null,
    dbSize: database?.size ?? 0,
    dbSignature: candidate?.signature ?? plan.previous?.dbSignature ?? null,
    dbInfoJson: database ? JSON.stringify(database) : null,
    mediaCount: media.length,
    totalBytes: manifest.totalBytes,
    manifestMessageId,
  });

  // The new manifest is durable and locally recorded: retire superseded
  // database chunks and the previous manifest so storage does not grow forever.
  const previousDb = parseDbInfo(plan.previous);
  if (databaseUploaded && previousDb) {
    void telegramService
      .deleteMessages(
        channelId,
        previousDb.chunks.map((chunk) => chunk.messageId),
      )
      .catch(() => undefined);
  }
  if (plan.previous?.manifestMessageId && plan.previous.manifestMessageId !== manifestMessageId) {
    void telegramService
      .deleteMessages(channelId, [plan.previous.manifestMessageId])
      .catch(() => undefined);
  }

  onProgress({
    phase: 'done',
    fraction: 1,
    label: uploadedMedia > 0 || databaseUploaded ? 'Backup complete' : 'Everything was already up to date',
    chunksDone: uploadedChunks,
    chunksTotal: database?.chunks.length ?? 0,
    filesDone: totalPending,
    filesTotal: totalPending,
    bytesDone: manifest.totalBytes,
    bytesTotal: manifest.totalBytes,
  });

  return { manifest, uploadedMedia, uploadedChunks, databaseUploaded };
}

/**
 * Backs up files handed to the PWA by the OS share sheet (WhatsApp's
 * "Export chat" produces a .zip) and refreshes the manifest.
 */
export async function backupSharedFiles(
  channelId: string,
  files: readonly File[],
  onProgress: (progress: BackupProgress) => void = noop,
): Promise<{ uploaded: number; manifest: WhatsAppBackupManifest }> {
  const [previous, rows] = await Promise.all([
    getWhatsAppBackup(channelId),
    getWhatsAppFiles(channelId),
  ]);
  const existing = new Map(rows.map((row) => [row.path, row]));
  const database = parseDbInfo(previous);
  const bytesTotal = files.reduce((sum, file) => sum + file.size, 0);
  let bytesDone = 0;
  let uploaded = 0;

  const pendingShared = files.flatMap((file) => {
    const path = `Shared/${file.name}`;
    const signature = signatureFor(file);
    const existingRow = existing.get(path);
    if (existingRow?.signature === signature) return [];
    return [{ file, path, signature, existingRow }];
  });

  if (pendingShared.length > 0) {
    const results = await uploadBatch({
      channelId,
      files: pendingShared.map((entry) => entry.file),
      encrypt: true,
      onItemStart: (index) => {
        const entry = pendingShared[index];
        if (!entry) return;
        onProgress({
          phase: 'media',
          fraction: index / pendingShared.length,
          label: `Encrypting shared file ${entry.file.name}`,
          chunksDone: 0,
          chunksTotal: 0,
          filesDone: index,
          filesTotal: files.length,
          bytesDone,
          bytesTotal,
        });
      },
      onItemProgress: (index, fraction) => {
        const entry = pendingShared[index];
        if (!entry) return;
        onProgress({
          phase: 'media',
          fraction: (index + fraction) / pendingShared.length,
          label: `Encrypting shared file ${entry.file.name}`,
          chunksDone: 0,
          chunksTotal: 0,
          filesDone: index,
          filesTotal: files.length,
          bytesDone: bytesDone + entry.file.size * fraction,
          bytesTotal,
        });
      },
      onBundleProgress: (label, fraction) => {
        onProgress({
          phase: 'media',
          fraction,
          label,
          chunksDone: 0,
          chunksTotal: 0,
          filesDone: 0,
          filesTotal: files.length,
          bytesDone,
          bytesTotal,
        });
      },
      onFloodWait: (seconds) => {
        onProgress({
          phase: 'media',
          fraction: 0,
          label: `Telegram rate limit — resuming in ${seconds}s`,
          chunksDone: 0,
          chunksTotal: 0,
          filesDone: 0,
          filesTotal: files.length,
          bytesDone,
          bytesTotal,
        });
      },
    });

    const failures: string[] = [];
    for (let index = 0; index < pendingShared.length; index += 1) {
      const entry = pendingShared[index];
      const result = results[index];
      if (!entry) continue;
      if (!result?.outcome) {
        failures.push(`${entry.file.name}: ${result?.error ?? 'upload failed'}`);
        continue;
      }

      const outcome = result.outcome;
      const row: WhatsAppFileRow = {
        channelId,
        path: entry.path,
        category: categorizeWhatsAppFile(entry.path, entry.file),
        signature: entry.signature,
        size: entry.file.size,
        lastModified: entry.file.lastModified,
        uploadedAt: Date.now(),
        ...(outcome.messageId !== undefined ? { messageId: outcome.messageId } : {}),
        ...(outcome.thumbMessageId !== undefined
          ? { thumbMessageId: outcome.thumbMessageId }
          : {}),
        ...(outcome.packed ? { packed: outcome.packed } : {}),
        ...(outcome.packedThumb ? { packedThumb: outcome.packedThumb } : {}),
        ...(outcome.bundleIndexMessageId !== undefined
          ? { bundleIndexMessageId: outcome.bundleIndexMessageId }
          : {}),
      };
      await putWhatsAppFiles([row]);
      if (entry.existingRow) deleteSuperseded(channelId, entry.existingRow);
      existing.set(entry.path, row);
      uploaded += 1;
    }

    if (failures.length > 0) {
      throw new Error(
        `${failures.length} shared file${failures.length === 1 ? '' : 's'} could not be backed up: ${failures
          .slice(0, 3)
          .join('; ')}`,
      );
    }
  }

  bytesDone = files.reduce((sum, file) => sum + file.size, 0);

  const media = collectMediaRefs(existing.values());
  const manifest: WhatsAppBackupManifest = {
    v: 1,
    backupId: randomBackupId(),
    channelId,
    createdAt: Date.now(),
    database,
    media,
    totalBytes: (database?.size ?? 0) + media.reduce((sum, ref) => sum + ref.size, 0),
  };
  const manifestMessageId = await uploadManifest(manifest);

  await putWhatsAppBackup({
    channelId,
    backupId: manifest.backupId,
    createdAt: manifest.createdAt,
    dbName: database?.name ?? previous?.dbName ?? null,
    dbSize: database?.size ?? previous?.dbSize ?? 0,
    dbSignature: previous?.dbSignature ?? null,
    dbInfoJson: database ? JSON.stringify(database) : null,
    mediaCount: media.length,
    totalBytes: manifest.totalBytes,
    manifestMessageId,
  });

  if (previous?.manifestMessageId && previous.manifestMessageId !== manifestMessageId) {
    void telegramService
      .deleteMessages(channelId, [previous.manifestMessageId])
      .catch(() => undefined);
  }

  onProgress({
    phase: 'done',
    fraction: 1,
    label: uploaded > 0 ? 'Shared files backed up' : 'Shared files were already backed up',
    chunksDone: 0,
    chunksTotal: 0,
    filesDone: files.length,
    filesTotal: files.length,
    bytesDone,
    bytesTotal,
  });

  return { uploaded, manifest };
}

/* ------------------------------------------------------------------ */
/* Remote manifest + restore                                          */
/* ------------------------------------------------------------------ */

export interface RemoteBackup {
  readonly manifest: WhatsAppBackupManifest;
  readonly messageId: number;
}

export async function loadRemoteWhatsAppBackup(
  channelId: string,
): Promise<RemoteBackup | null> {
  const manifests = await telegramService.findBackupManifests(channelId);

  for (const ref of manifests) {
    try {
      const raw = await telegramService.downloadOriginal(channelId, ref.messageId);
      const plain = await cryptoClient.decryptBytes(raw.bytes);
      const parsed = JSON.parse(new TextDecoder().decode(plain)) as unknown;
      if (isWhatsAppBackupManifest(parsed)) {
        return { manifest: parsed, messageId: ref.messageId };
      }
    } catch {
      // A corrupt or older manifest should not block the next candidate.
    }
  }
  return null;
}

interface SavePickerWindow {
  showSaveFilePicker?: (options?: {
    suggestedName?: string;
    types?: Array<{ description: string; accept: Record<string, string[]> }>;
  }) => Promise<FileSystemFileHandle>;
}

const triggerDownload = (blob: Blob, fileName: string): void => {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
};

export interface RestoreOptions {
  readonly onProgress?: (progress: BackupProgress) => void;
  readonly signal?: AbortSignal;
}

/**
 * Streams the sealed database chunks in order, decrypts each one and writes it
 * straight to disk through the File System Access API. Browsers without it fall
 * back to assembling a Blob (needs enough free RAM) and a normal download.
 */
export async function restoreWhatsAppDatabase(
  backup: WhatsAppBackupManifest,
  options: RestoreOptions = {},
): Promise<RestoreResult> {
  const onProgress = options.onProgress ?? noop;
  const database = backup.database;
  if (!database) throw new Error('This backup does not contain a chat database.');

  const chunks = [...database.chunks].sort((a, b) => a.index - b.index);
  if (chunks.length === 0) throw new Error('The backup manifest lists no database chunks.');

  const picker = (window as unknown as SavePickerWindow).showSaveFilePicker;
  let writable: FileSystemWritableFileStream | null = null;

  if (picker) {
    const handle = await picker.call(window, {
      suggestedName: database.name,
      types: [
        {
          description: 'WhatsApp database',
          accept: { 'application/octet-stream': ['.crypt15', '.crypt14', '.db'] },
        },
      ],
    });
    writable = await handle.createWritable();
  }

  const blobParts: BlobPart[] = [];
  let bytesDone = 0;

  try {
    for (let index = 0; index < chunks.length; index += 1) {
      throwIfAborted(options.signal);
      const chunk = chunks[index];
      if (!chunk) continue;

      const raw = await telegramService.downloadOriginal(backup.channelId, chunk.messageId, {
        signal: options.signal,
        onProgress: (fraction) => {
          onProgress({
            phase: 'restore',
            fraction: (index + fraction) / chunks.length,
            label: `Downloading database chunk ${index + 1} of ${chunks.length}`,
            chunksDone: index,
            chunksTotal: chunks.length,
            filesDone: 0,
            filesTotal: 0,
            bytesDone: bytesDone + Math.round(chunk.size * fraction),
            bytesTotal: database.size,
          });
        },
      });

      const plain = await cryptoClient.decryptBytes(raw.bytes);
      const bytes = new Uint8Array(plain);
      if (writable) {
        await writable.write(bytes);
      } else {
        blobParts.push(bytes);
      }
      bytesDone += chunk.size;

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

    if (writable) {
      await writable.close();
      writable = null;
      return { method: 'saved', bytes: bytesDone };
    }

    triggerDownload(new Blob(blobParts, { type: 'application/octet-stream' }), database.name);
    return { method: 'downloaded', bytes: bytesDone };
  } catch (error) {
    if (writable) {
      try {
        await writable.abort();
      } catch {
        // Ignore abort failures; the original error is what matters.
      }
    }
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* Local summaries                                                    */
/* ------------------------------------------------------------------ */

export async function getLocalWhatsAppSummary(
  channelId: string,
): Promise<WhatsAppLocalSummary | null> {
  const [backup, files] = await Promise.all([
    getWhatsAppBackup(channelId),
    getWhatsAppFiles(channelId),
  ]);
  if (!backup) return null;

  const mediaCount = files.filter(
    (row) =>
      row.category !== 'database' && (row.messageId !== undefined || row.packed !== undefined),
  ).length;

  return {
    backupId: backup.backupId,
    createdAt: backup.createdAt,
    database: backup.dbName ? { name: backup.dbName, size: backup.dbSize } : null,
    mediaCount,
    totalBytes: backup.totalBytes,
  };
}
