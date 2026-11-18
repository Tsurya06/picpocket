/** A folder the user chose for local-library sync. */
export interface FolderSyncConfig {
  readonly name: string;
  readonly handle: FileSystemDirectoryHandle;
  /** Epoch ms of the last completed scan/upload run. */
  readonly lastSyncAt: number | null;
  /** When false, the folder is only uploaded from the folder browser. */
  readonly autoSync: boolean;
  /** Local wall-clock time for the once-a-day automatic check. */
  readonly scheduleTime: string;
  readonly savedAt: number;
}

/** One local media file and whether this device has already uploaded it. */
export interface FolderLibraryEntry {
  readonly file: File;
  readonly path: string;
  readonly signature: string;
  readonly synced: boolean;
}

export interface FolderSyncProgress {
  readonly phase: 'scanning' | 'uploading' | 'done';
  readonly label: string;
  readonly found: number;
  readonly pending: number;
  readonly uploaded: number;
  readonly failed: number;
  readonly bytes: number;
}

export type FolderSyncPhase =
  | 'idle'
  | 'scanning'
  | 'uploading'
  | 'done'
  | 'error'
  | 'needs-permission';