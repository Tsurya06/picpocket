import type { File } from 'expo-file-system';

export type WhatsAppCategory =
  | 'database'
  | 'image'
  | 'video'
  | 'voice'
  | 'document'
  | 'audio'
  | 'other';

export type WhatsAppMediaKind = 'photos' | 'videos' | 'documents';
export type WhatsAppMediaSelection = Readonly<Record<WhatsAppMediaKind, boolean>>;

export const NO_MEDIA_SELECTION: WhatsAppMediaSelection = {
  photos: false,
  videos: false,
  documents: false,
};

export const ALL_MEDIA_SELECTION: WhatsAppMediaSelection = {
  photos: true,
  videos: true,
  documents: true,
};

export const hasAnyMedia = (selection: WhatsAppMediaSelection): boolean =>
  selection.photos || selection.videos || selection.documents;

export const normalizeMediaSelection = (value: unknown): WhatsAppMediaSelection => {
  if (typeof value !== 'object' || value === null) return NO_MEDIA_SELECTION;
  const candidate = value as Record<string, unknown>;
  return {
    photos: candidate.photos === true,
    videos: candidate.videos === true,
    documents: candidate.documents === true,
  };
};

export const mediaSelectionIncludes = (
  selection: WhatsAppMediaSelection,
  category: WhatsAppCategory,
): boolean => {
  switch (category) {
    case 'image':
      return selection.photos;
    case 'video':
      return selection.videos;
    case 'document':
      return selection.documents;
    default:
      return false;
  }
};

export interface ScannedFile {
  readonly file: File;
  readonly name: string;
  readonly path: string;
  readonly category: WhatsAppCategory;
  readonly signature: string;
  readonly size: number;
}

export interface DirectoryScan {
  readonly rootName: string;
  readonly files: readonly ScannedFile[];
  readonly latestDatabase: ScannedFile | null;
  readonly media: readonly ScannedFile[];
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
  readonly messageId?: number;
}

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

export interface SyncPlanSummary {
  readonly pendingMediaCount: number;
  readonly pendingBytes: number;
  readonly databaseChanged: boolean;
  readonly databaseName: string | null;
  readonly databaseSize: number;
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

const isMediaRef = (value: unknown): value is BackupMediaRef => {
  if (typeof value !== 'object' || value === null) return false;
  const media = value as Record<string, unknown>;
  return (
    typeof media.path === 'string' &&
    typeof media.category === 'string' &&
    typeof media.size === 'number' &&
    typeof media.lastModified === 'number' &&
    typeof media.messageId === 'number'
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
