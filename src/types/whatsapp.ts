import type { PackedSliceLocation } from './media';

/** Domain types for the WhatsApp backup & sync module. */

export type WhatsAppCategory =
  | 'database'
  | 'image'
  | 'video'
  | 'voice'
  | 'document'
  | 'audio'
  | 'other';

export interface ScannedWhatsAppFile {
  readonly file: File;
  /** Path relative to the picked WhatsApp root, using `/` separators. */
  readonly path: string;
  readonly category: WhatsAppCategory;
  /** Fast dedupe signature: `size:lastModified`. */
  readonly signature: string;
}

export interface DirectoryScan {
  readonly rootName: string;
  readonly files: readonly ScannedWhatsAppFile[];
  readonly latestDatabase: ScannedWhatsAppFile | null;
  readonly media: readonly ScannedWhatsAppFile[];
  readonly totalBytes: number;
  readonly skipped: number;
}

export interface BackupChunkRef {
  readonly index: number;
  readonly messageId: number;
  readonly size: number;
}

export interface BackupDatabaseInfo {
  readonly name: string;
  readonly path: string;
  readonly size: number;
  readonly lastModified: number;
  readonly chunks: readonly BackupChunkRef[];
}

export interface BackupMediaRef {
  readonly path: string;
  readonly category: WhatsAppCategory;
  readonly size: number;
  readonly lastModified: number;
  /** Standalone origin message, absent for packed media. */
  readonly messageId?: number;
  readonly thumbMessageId?: number;
  /** Byte range inside a packed bundle when the media was ≤ 10 MB. */
  readonly packed?: PackedSliceLocation;
  readonly packedThumb?: PackedSliceLocation;
  readonly bundleIndexMessageId?: number;
}

/** Sealed JSON stored as `whatsapp_backup_manifest.enc` in the channel. */
export interface WhatsAppBackupManifest {
  readonly v: 1;
  readonly backupId: string;
  readonly channelId: string;
  readonly createdAt: number;
  readonly database: BackupDatabaseInfo | null;
  readonly media: readonly BackupMediaRef[];
  readonly totalBytes: number;
}

export type BackupPhase =
  | 'idle'
  | 'scanning'
  | 'database'
  | 'media'
  | 'manifest'
  | 'restore'
  | 'done';

export interface BackupProgress {
  readonly phase: BackupPhase;
  readonly fraction: number;
  readonly label: string;
  readonly chunksDone: number;
  readonly chunksTotal: number;
  readonly filesDone: number;
  readonly filesTotal: number;
  readonly bytesDone: number;
  readonly bytesTotal: number;
}

export interface WhatsAppLocalSummary {
  readonly backupId: string;
  readonly createdAt: number;
  readonly database: { readonly name: string; readonly size: number } | null;
  readonly mediaCount: number;
  readonly totalBytes: number;
}

export interface SyncPlanSummary {
  readonly pendingMediaCount: number;
  readonly pendingBytes: number;
  readonly databaseChanged: boolean;
  readonly databaseName: string | null;
  readonly databaseSize: number;
}

export interface RestoreResult {
  readonly method: 'saved' | 'downloaded';
  readonly bytes: number;
}

const isChunkRef = (value: unknown): value is BackupChunkRef => {
  if (typeof value !== 'object' || value === null) return false;
  const chunk = value as Record<string, unknown>;
  return (
    typeof chunk.index === 'number' &&
    typeof chunk.messageId === 'number' &&
    typeof chunk.size === 'number'
  );
};

const isSlice = (value: unknown): value is PackedSliceLocation => {
  if (typeof value !== 'object' || value === null) return false;
  const slice = value as Record<string, unknown>;
  return (
    typeof slice.bundleMessageId === 'number' &&
    typeof slice.byteOffset === 'number' &&
    slice.byteOffset >= 0 &&
    typeof slice.byteLength === 'number' &&
    slice.byteLength > 0
  );
};

const isMediaRef = (value: unknown): value is BackupMediaRef => {
  if (typeof value !== 'object' || value === null) return false;
  const media = value as Record<string, unknown>;
  return (
    typeof media.path === 'string' &&
    typeof media.category === 'string' &&
    typeof media.size === 'number' &&
    typeof media.lastModified === 'number' &&
    (typeof media.messageId === 'number' || isSlice(media.packed))
  );
};

export function isWhatsAppBackupManifest(value: unknown): value is WhatsAppBackupManifest {
  if (typeof value !== 'object' || value === null) return false;
  const manifest = value as Record<string, unknown>;
  if (
    manifest.v !== 1 ||
    typeof manifest.backupId !== 'string' ||
    typeof manifest.channelId !== 'string' ||
    typeof manifest.createdAt !== 'number' ||
    typeof manifest.totalBytes !== 'number' ||
    !Array.isArray(manifest.media) ||
    !manifest.media.every(isMediaRef)
  ) {
    return false;
  }

  if (manifest.database === null) return true;
  if (typeof manifest.database !== 'object' || manifest.database === null) return false;
  const database = manifest.database as Record<string, unknown>;
  return (
    typeof database.name === 'string' &&
    typeof database.path === 'string' &&
    typeof database.size === 'number' &&
    typeof database.lastModified === 'number' &&
    Array.isArray(database.chunks) &&
    database.chunks.every(isChunkRef)
  );
}
