import type {
  FolderLibraryEntry,
  FolderSyncConfig,
  FolderSyncProgress,
} from '../../types/folderSync';
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

export interface FolderUploadResult {
  readonly uploaded: number;
  readonly failed: number;
  readonly failures: readonly string[];
}

export type FolderSelectionMode = 'handle' | 'input' | 'none';

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
  return folderSelectionMode() !== 'none';
}

/** Some Android browsers expose folder upload through <input webkitdirectory>. */
export function folderSelectionMode(): FolderSelectionMode {
  if (typeof window === 'undefined') return 'none';
  if (typeof (window as unknown as PickerWindow).showDirectoryPicker === 'function') return 'handle';
  if (typeof document === 'undefined') return 'none';
  const input = document.createElement('input');
  return 'webkitdirectory' in input ? 'input' : 'none';
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

/** The root folder name from a webkitdirectory selection. */
export function folderNameFromFiles(files: readonly File[]): string {
  for (const file of files) {
    const root = file.webkitRelativePath.split('/')[0];
    if (root) return root;
  }
  return 'Selected folder';
}

/** Builds the same scanned-entry shape from a webkitdirectory FileList. */
export function scanFolderFiles(files: readonly File[]): ScannedFolderFile[] {
  const entries = new Map<string, ScannedFolderFile>();
  for (const file of files) {
    if (entries.size >= MAX_FILES) break;
    if (shouldSkip(file.name, file) || !isMediaFile(file)) continue;

    const parts = (file.webkitRelativePath || file.name).split('/').filter(Boolean);
    if (parts.length > 1) parts.shift();
    if (parts.some((part) => part.startsWith('.') || part === '__MACOSX')) continue;
    const path = parts.join('/');
    if (!path) continue;
    entries.set(path, {
      file,
      path,
      signature: `${file.size}:${file.lastModified}`,
    });
  }
  return [...entries.values()];
}

/** Scans the folder and marks each file that is already in the vault. */
export async function scanFolderLibrary(
  config: FolderSyncConfig,
  channelId: string,
): Promise<FolderLibraryEntry[]> {
  if ((await folderPermission(config.handle)) !== 'granted') {
    throw new FolderPermissionError();
  }
  const [files, rows] = await Promise.all([
    scanFolder(config.handle),
    getFolderSyncFiles(channelId),
  ]);
  const known = new Map(rows.map((row) => [row.path, row.signature]));
  return files.map((entry) => ({
    ...entry,
    synced: known.get(entry.path) === entry.signature,
  }));
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
    autoSync: candidate.autoSync !== false,
    savedAt: typeof candidate.savedAt === 'number' ? candidate.savedAt : Date.now(),
  };
}

export async function saveFolderConfig(config: FolderSyncConfig): Promise<void> {
  await setSetting(CONFIG_KEY, config);
}

const FALLBACK_CONFIG_KEY = 'folder.sync.fallback_config';

export interface FallbackFolderConfig {
  readonly name: string;
  readonly lastSyncAt: number | null;
  readonly fileCount: number;
}

export async function loadFallbackFolderConfig(): Promise<FallbackFolderConfig | null> {
  const candidate = await getSetting<FallbackFolderConfig | null>(FALLBACK_CONFIG_KEY, null);
  if (!candidate || typeof candidate !== 'object' || typeof candidate.name !== 'string') return null;
  return {
    name: candidate.name,
    lastSyncAt: typeof candidate.lastSyncAt === 'number' ? candidate.lastSyncAt : null,
    fileCount: typeof candidate.fileCount === 'number' ? candidate.fileCount : 0,
  };
}

export async function saveFallbackFolderConfig(config: FallbackFolderConfig): Promise<void> {
  await setSetting(FALLBACK_CONFIG_KEY, config);
}

export async function clearFallbackFolderConfig(): Promise<void> {
  await setSetting(FALLBACK_CONFIG_KEY, null);
}

export async function clearFolderConfig(): Promise<void> {
  await setSetting(CONFIG_KEY, null);
  await setSetting(FALLBACK_CONFIG_KEY, null);
}

export async function pickFolder(): Promise<FolderSyncConfig> {
  const picker = (window as unknown as PickerWindow).showDirectoryPicker;
  if (!picker) {
    throw new Error(
      'This browser cannot open a folder picker. Use desktop Chrome/Edge or a recent Chrome on Android.',
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
    autoSync: true,
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

  const files = await scanFolder(config.handle);
  const result = await runFolderEntries(
    config.name,
    files,
    channelId,
    encrypt,
    onProgress,
  );
  await saveFolderConfig({ ...config, lastSyncAt: result.completedAt });
  return result;
}

/** Uploads a folder selected through <input webkitdirectory>; persists folder state across sessions. */
export async function uploadSelectedFolder(
  files: readonly File[],
  channelId: string,
  encrypt: boolean,
  onProgress: (progress: FolderSyncProgress) => void,
): Promise<FolderSyncResult> {
  const result = await runFolderEntries(
    folderNameFromFiles(files),
    scanFolderFiles(files),
    channelId,
    encrypt,
    onProgress,
  );
  await saveFallbackFolderConfig({
    name: folderNameFromFiles(files),
    lastSyncAt: result.completedAt,
    fileCount: files.length,
  });
  return result;
}

async function runFolderEntries(
  name: string,
  files: readonly ScannedFolderFile[],
  channelId: string,
  encrypt: boolean,
  onProgress: (progress: FolderSyncProgress) => void,
): Promise<FolderSyncResult> {
  onProgress({
    phase: 'scanning',
    label: `Checking ${name}…`,
    found: 0,
    pending: 0,
    uploaded: 0,
    failed: 0,
    bytes: 0,
  });

  const rows = await getFolderSyncFiles(channelId);
  const known = new Map(rows.map((row) => [row.path, row.signature]));
  const pending = files.filter((entry) => known.get(entry.path) !== entry.signature);
  const bytes = pending.reduce((sum, entry) => sum + entry.file.size, 0);

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

  const uploadedResult = await uploadScannedEntries({
    channelId,
    encrypt,
    entries: pending,
    found: files.length,
    pending: pending.length,
    bytes,
    onProgress,
  });

  const completedAt = Date.now();
  return {
    found: files.length,
    pending: pending.length,
    uploaded: uploadedResult.uploaded,
    failed: uploadedResult.failed,
    completedAt,
    failures: uploadedResult.failures,
  };
}

interface UploadScannedEntriesInput {
  readonly channelId: string;
  readonly encrypt: boolean;
  readonly entries: readonly ScannedFolderFile[];
  readonly found: number;
  readonly pending: number;
  readonly bytes: number;
  readonly onProgress: (progress: FolderSyncProgress) => void;
}

async function uploadScannedEntries({
  channelId,
  encrypt,
  entries,
  found,
  pending,
  bytes,
  onProgress,
}: UploadScannedEntriesInput): Promise<FolderUploadResult> {
  const failures: string[] = [];
  let uploaded = 0;

  for (let start = 0; start < entries.length; start += BATCH_SIZE) {
    const batch = entries.slice(start, start + BATCH_SIZE);
    const byFile = new Map(batch.map((entry) => [entry.file, entry]));
    const results = await uploadBatch({
      channelId,
      files: batch.map((entry) => entry.file),
      encrypt,
      onItemStart: (_index, file) => {
        onProgress({
          phase: 'uploading',
          label: `Uploading ${file.name}`,
          found,
          pending,
          uploaded,
          failed: failures.length,
          bytes,
        });
      },
      onBundleProgress: (label) => {
        onProgress({
          phase: 'uploading',
          label,
          found,
          pending,
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
      phase: start + batch.length >= entries.length ? 'done' : 'uploading',
      label:
        start + batch.length >= entries.length
          ? `Synced ${uploaded} item${uploaded === 1 ? '' : 's'}${failures.length > 0 ? `, ${failures.length} failed` : ''}`
          : `Uploaded ${uploaded} of ${pending}`,
      found,
      pending,
      uploaded,
      failed: failures.length,
      bytes,
    });
  }

  return { uploaded, failed: failures.length, failures };
}

/** Uploads only the files the user picked in the folder browser. */
export async function uploadFolderEntries(
  config: FolderSyncConfig,
  channelId: string,
  encrypt: boolean,
  entries: readonly FolderLibraryEntry[],
): Promise<FolderUploadResult> {
  if ((await folderPermission(config.handle)) !== 'granted') {
    throw new FolderPermissionError();
  }

  const pending = entries.filter((entry) => !entry.synced);
  const bytes = pending.reduce((sum, entry) => sum + entry.file.size, 0);
  return uploadScannedEntries({
    channelId,
    encrypt,
    entries: pending,
    found: entries.length,
    pending: pending.length,
    bytes,
    onProgress: () => undefined,
  });
}