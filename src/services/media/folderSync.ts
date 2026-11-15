import type { FolderSyncConfig, FolderSyncProgress } from '../../types/folderSync';
import { getFolderSyncFiles, getSetting, putFolderSyncFiles, setSetting } from '../cache/db';
import { uploadBatch } from './uploader';

/**
 * Local folder sync for the PWA.
 *
 * This uses the File System Access API, so it works on Chromium desktop and
 * Android Chromium builds. The browser only lets us read the folder after the
 * user grants permission; that handle is persisted in IndexedDB. Folder checks
 * run when the user opens the app (at most once a day) and uploads only files
 * whose relative path, size, or last-modified time changed.
 */

const CONFIG_KEY = 'folder.sync.config';
const MAX_FILES = 20_000;
const MAX_DEPTH = 12;
const BATCH_SIZE = 12;
const MEDIA_EXTENSION =
  /\.(?:3gp|avi|avif|bmp|gif|heic|heif|jpe?g|m4v|mkv|mov|mp4|mpe?g|ogv|png|tiff?|webm|webp)$/i;

interface PickerWindow {
  showDirectoryPicker?: (options?: {
    id?: string;
    mode?: 'read' | 'readwrite';
  }) => Promise<FileSystemDirectoryHandle>;
}

interface PermissionHandle extends FileSystemDirectoryHandle {
  queryPermission?: (descriptor: { mode: 'read' }) => Promise<PermissionState>;
  requestPermission?: (descriptor: { mode: 'read' }) => Promise<PermissionState>;
}

interface WalkableDirectory extends FileSystemDirectoryHandle {
  values(): AsyncIterableIterator<FileSystemDirectoryHandle | FileSystemFileHandle>;
}

export interface ScannedFolderFile {
  readonly file: File;
  /** Path relative to the picked folder, always using `/`. */
  readonly path: string;
  /** Fast dedupe key: size plus last-modified time. */
  readonly signature: string;
}

export interface FolderSyncResult {
  readonly found: number;
  readonly pending: number;
  readonly uploaded: number;
  readonly failed: number;
  readonly completedAt: number;
  readonly failures: readonly string[];
}

export class FolderPermissionError extends Error {
  constructor() {
    super(
      'PicPocket needs permission to read this folder again. Choose the folder to reconnect it.',
    );
    this.name = 'FolderPermissionError';
  }
}

export function supportsFolderSync(): boolean {
  if (typeof window === 'undefined') return false;
  return typeof (window as unknown as PickerWindow).showDirectoryPicker === 'function';
}

const isMediaFile = (file: File): boolean =>
  file.type.startsWith('image/') ||
  file.type.startsWith('video/') ||
  MEDIA_EXTENSION.test(file.name);

const shouldSkip = (name: string, file: File): boolean => {
  if (name.startsWith('.') || file.size === 0) return true;
  return /\.(?:tmp|part|log|nomedia)$/i.test(name);
};

async function walkDirectory(
  directory: FileSystemDirectoryHandle,
  prefix: string,
  out: ScannedFolderFile[],
  depth: number,
): Promise<void> {
  if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;

  for await (const entry of (directory as WalkableDirectory).values()) {
    if (out.length >= MAX_FILES) return;
    if (entry.kind === 'directory') {
      if (entry.name.startsWith('.') || entry.name === '__MACOSX') continue;
      await walkDirectory(
        entry as FileSystemDirectoryHandle,
        `${prefix}${entry.name}/`,
        out,
        depth + 1,
      );
      continue;
    }

    const handle = entry as FileSystemFileHandle;
    const file = await handle.getFile().catch(() => null);
    if (!file || shouldSkip(file.name, file) || !isMediaFile(file)) continue;
    out.push({
      file,
      path: `${prefix}${file.name}`,
      signature: `${file.size}:${file.lastModified}`,
    });
  }
}

export async function scanFolder(
  directory: FileSystemDirectoryHandle,
): Promise<ScannedFolderFile[]> {
  const files: ScannedFolderFile[] = [];
  await walkDirectory(directory, '', files, 0);
  return files;
}

export async function folderPermission(
  directory: FileSystemDirectoryHandle,
): Promise<PermissionState> {
  const handle = directory as PermissionHandle;
  if (typeof handle.queryPermission !== 'function') return 'granted';
  return handle.queryPermission({ mode: 'read' });
}

export async function requestFolderPermission(
  directory: FileSystemDirectoryHandle,
): Promise<boolean> {
  if ((await folderPermission(directory)) === 'granted') return true;
  const handle = directory as PermissionHandle;
  if (typeof handle.requestPermission !== 'function') return false;
  return (await handle.requestPermission({ mode: 'read' })) === 'granted';
}

export async function loadFolderConfig(): Promise<FolderSyncConfig | null> {
  const value = await getSetting<FolderSyncConfig | null>(CONFIG_KEY, null);
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<FolderSyncConfig>;
  if (
    typeof candidate.name !== 'string' ||
    candidate.name.length === 0 ||
    !candidate.handle ||
    typeof candidate.handle !== 'object'
  ) {
    return null;
  }
  return {
    name: candidate.name,
    handle: candidate.handle,
    lastSyncAt: typeof candidate.lastSyncAt === 'number' ? candidate.lastSyncAt : null,
    savedAt: typeof candidate.savedAt === 'number' ? candidate.savedAt : Date.now(),
  };
}

export async function saveFolderConfig(config: FolderSyncConfig): Promise<void> {
  await setSetting(CONFIG_KEY, config);
}

export async function clearFolderConfig(): Promise<void> {
  await setSetting(CONFIG_KEY, null);
}

export async function pickFolder(): Promise<FolderSyncConfig> {
  const picker = (window as unknown as PickerWindow).showDirectoryPicker;
  if (!picker) {
    throw new Error(
      'This browser cannot open a folder picker. Folder sync is available in Chromium-based browsers.',
    );
  }

  const handle = await picker.call(window, {
    id: 'picpocket-folder-sync',
    mode: 'read',
  });
  if (!(await requestFolderPermission(handle))) {
    throw new FolderPermissionError();
  }

  const config: FolderSyncConfig = {
    name: handle.name,
    handle,
    lastSyncAt: null,
    savedAt: Date.now(),
  };
  await saveFolderConfig(config);
  return config;
}

export async function syncFolder(
  config: FolderSyncConfig,
  channelId: string,
  encrypt: boolean,
  onProgress: (progress: FolderSyncProgress) => void,
): Promise<FolderSyncResult> {
  if ((await folderPermission(config.handle)) !== 'granted') {
    throw new FolderPermissionError();
  }

  onProgress({
    phase: 'scanning',
    label: `Checking ${config.name}…`,
    found: 0,
    pending: 0,
    uploaded: 0,
    failed: 0,
    bytes: 0,
  });

  const files = await scanFolder(config.handle);
  const rows = await getFolderSyncFiles(channelId);
  const known = new Map(rows.map((row) => [row.path, row.signature]));
  const pending = files.filter((entry) => known.get(entry.path) !== entry.signature);
  const bytes = pending.reduce((sum, entry) => sum + entry.file.size, 0);
  const failures: string[] = [];
  let uploaded = 0;

  onProgress({
    phase: pending.length > 0 ? 'uploading' : 'done',
    label:
      pending.length > 0
        ? `${pending.length} new item${pending.length === 1 ? '' : 's'} to upload`
        : 'Everything in this folder is already in your vault',
    found: files.length,
    pending: pending.length,
    uploaded: 0,
    failed: 0,
    bytes,
  });

  for (let start = 0; start < pending.length; start += BATCH_SIZE) {
    const batch = pending.slice(start, start + BATCH_SIZE);
    const byFile = new Map(batch.map((entry) => [entry.file, entry]));
    const results = await uploadBatch({
      channelId,
      files: batch.map((entry) => entry.file),
      encrypt,
      onItemStart: (_index, file) => {
        onProgress({
          phase: 'uploading',
          label: `Uploading ${file.name}`,
          found: files.length,
          pending: pending.length,
          uploaded,
          failed: failures.length,
          bytes,
        });
      },
      onBundleProgress: (label) => {
        onProgress({
          phase: 'uploading',
          label,
          found: files.length,
          pending: pending.length,
          uploaded,
          failed: failures.length,
          bytes,
        });
      },
    });

    const completed = results.flatMap((result) => {
      const entry = byFile.get(result.file);
      if (!entry) return [];
      if (result.outcome) {
        return [
          {
            id: `${channelId}:${entry.path}`,
            channelId,
            path: entry.path,
            signature: entry.signature,
            uploadedAt: Date.now(),
          },
        ];
      }
      failures.push(`${entry.path}: ${result.error ?? 'Upload failed.'}`);
      return [];
    });

    await putFolderSyncFiles(completed);
    uploaded += completed.length;
    onProgress({
      phase: start + batch.length >= pending.length ? 'done' : 'uploading',
      label:
        start + batch.length >= pending.length
          ? `Synced ${uploaded} item${uploaded === 1 ? '' : 's'}${failures.length > 0 ? `, ${failures.length} failed` : ''}`
          : `Uploaded ${uploaded} of ${pending.length}`,
      found: files.length,
      pending: pending.length,
      uploaded,
      failed: failures.length,
      bytes,
    });
  }

  const completedAt = Date.now();
  await saveFolderConfig({ ...config, lastSyncAt: completedAt });
  return {
    found: files.length,
    pending: pending.length,
    uploaded,
    failed: failures.length,
    completedAt,
    failures,
  };
}