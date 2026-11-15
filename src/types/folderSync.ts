/** A folder the user chose for local-library sync. */
export interface FolderSyncConfig {
  readonly name: string;
  readonly handle: FileSystemDirectoryHandle;
  /** Epoch ms of the last completed scan/upload run. */
  readonly lastSyncAt: number | null;
  readonly savedAt: number;
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