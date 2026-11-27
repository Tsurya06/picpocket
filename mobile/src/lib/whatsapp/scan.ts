/**
 * Walks the user-picked WhatsApp folder through Android's Storage Access
 * Framework. Unlike the browser, `list()` already returns each file's size, so
 * a 7k-file folder is read without a per-file permission round trip.
 */
import { Directory, File } from 'expo-file-system';
import type { DirectoryScan, ScannedFile, WhatsAppCategory } from './types';

const MAX_FILES = 60_000;
const MAX_DEPTH = 16;
const YIELD_EVERY = 400;

const IGNORED_NAME = /^(\.|thumbs\.db$|desktop\.ini$)/i;
const IGNORED_EXTENSION = /\.(tmp|nomedia|part|log)$/i;
const DATABASE_PATTERN = /^msgstore.*\.db\.crypt1[45]$/i;

export interface ScanProgress {
  readonly files: number;
  readonly directories: number;
  readonly path: string;
}

export interface ScanOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: ScanProgress) => void;
}

const normalise = (path: string): string => path.replace(/\\/g, '/').replace(/^\/+/, '');

export const categorizeWhatsAppFile = (
  path: string,
  name: string,
  mime: string,
): WhatsAppCategory => {
  const segments = normalise(path).toLowerCase().split('/');
  const lowerName = name.toLowerCase();
  const hasSegment = (needle: string): boolean => segments.some((segment) => segment.includes(needle));

  if (DATABASE_PATTERN.test(lowerName) || /^wa\.db$/.test(lowerName) || segments.includes('databases')) {
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

  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf' || /\.(pdf|docx?|xlsx?|pptx?|txt|csv)$/i.test(lowerName)) {
    return 'document';
  }
  return 'other';
};

const shouldSkip = (name: string, path: string): boolean => {
  if (IGNORED_NAME.test(name) || IGNORED_EXTENSION.test(name)) return true;
  return normalise(path).split('/').some((segment) => segment === '__MACOSX');
};

export const signatureFor = (size: number): string => `${size}:0`;

/**
 * The active history file is `msgstore.db.crypt15`; dated copies are backups
 * of it, so an exact name match always wins.
 */
const pickLatestDatabase = (files: readonly ScannedFile[]): ScannedFile | null => {
  const candidates = files.filter(
    (entry) => entry.category === 'database' && DATABASE_PATTERN.test(entry.name),
  );
  if (candidates.length === 0) return null;
  const byRank = (a: ScannedFile, b: ScannedFile): number => {
    const rank = (entry: ScannedFile): number => {
      if (/^msgstore\.db\.crypt15$/i.test(entry.name)) return 0;
      if (/^msgstore\.db\.crypt14$/i.test(entry.name)) return 1;
      if (/crypt15$/i.test(entry.name)) return 2;
      return 3;
    };
    const diff = rank(a) - rank(b);
    if (diff !== 0) return diff;
    return b.size - a.size;
  };
  return [...candidates].sort(byRank)[0] ?? null;
};

const abortIfNeeded = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted) throw new DOMException('Folder scan cancelled.', 'AbortError');
};

const yieldToUi = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

export async function scanWhatsAppDirectory(
  root: Directory,
  options: ScanOptions = {},
): Promise<DirectoryScan> {
  const collected: ScannedFile[] = [];
  let skipped = 0;
  let directories = 0;
  let sinceYield = 0;

  const walk = async (directory: Directory, prefix: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || collected.length >= MAX_FILES) return;
    abortIfNeeded(options.signal);
    directories += 1;

    let entries: (Directory | File)[];
    try {
      entries = directory.list();
    } catch {
      skipped += 1;
      return;
    }

    for (const entry of entries) {
      if (collected.length >= MAX_FILES) return;
      const name = entry.name;

      if (entry instanceof Directory) {
        await walk(entry, `${prefix}${name}/`, depth + 1);
        continue;
      }

      const path = `${prefix}${name}`;
      if (shouldSkip(name, path)) {
        skipped += 1;
        continue;
      }
      const size = typeof entry.size === 'number' ? entry.size : 0;
      const mime = typeof entry.type === 'string' ? entry.type : '';
      collected.push({
        file: entry,
        name,
        path,
        size,
        category: categorizeWhatsAppFile(path, name, mime),
        signature: signatureFor(size),
      });
      sinceYield += 1;

      if (sinceYield >= YIELD_EVERY) {
        sinceYield = 0;
        options.onProgress?.({ files: collected.length, directories, path: prefix });
        await yieldToUi();
        abortIfNeeded(options.signal);
      }
    }

    options.onProgress?.({ files: collected.length, directories, path: prefix });
  };

  await walk(root, '', 0);
  abortIfNeeded(options.signal);

  const latestDatabase = pickLatestDatabase(collected);
  return {
    rootName: root.name || 'WhatsApp',
    files: collected,
    latestDatabase,
    media: collected.filter((entry) => entry.category !== 'database'),
    totalBytes: collected.reduce((sum, entry) => sum + entry.size, 0),
    skipped,
  };
}

/** Re-creates a Directory instance from a stored SAF uri. */
export const directoryFromUri = (uri: string): Directory => new Directory(uri);
