import Dexie, { type Table } from 'dexie';
import type {
  ChannelSummary,
  MediaItem,
  PackedSliceLocation,
  VaultProfile,
} from '../../types/media';
import type { WhatsAppCategory } from '../../types/whatsapp';

/** Cached decrypted preview. Stored as a Blob so it survives reloads. */
export interface ThumbRow {
  /** `${channelId}:${messageId}` */
  key: string;
  channelId: string;
  messageId: number;
  bytes: Blob;
  byteSize: number;
  lastUsed: number;
}

/** Gallery row, cached so the timeline paints before the network answers. */
export interface MediaRow extends MediaItem {
  lastUsed: number;
}

export interface ChannelRow {
  id: string;
  title: string;
  username?: string;
  kind: ChannelSummary['kind'];
  memberCount?: number;
  isCreator: boolean;
  isSelected: boolean;
  lastUsed: number;
}

export interface AvatarRow {
  key: string;
  blob: Blob;
  lastUsed: number;
}

export interface SettingRow {
  key: string;
  value: unknown;
}

/**
 * The MTProto session, sealed with the vault key. Nothing can read this row
 * without the passphrase, so a stolen laptop or an XSS payload cannot hijack
 * the Telegram account from IndexedDB.
 */
export interface SessionRow {
  id: 'primary';
  /** Sealed JSON: { session, apiId, apiHash }. */
  ciphertext: string;
  createdAt: number;
}

export interface SessionSecret {
  session: string;
  apiId: number;
  apiHash: string;
}

/** One synced WhatsApp file per channel path; the local dedupe manifest. */
export interface WhatsAppFileRow {
  channelId: string;
  path: string;
  category: WhatsAppCategory;
  signature: string;
  size: number;
  lastModified: number;
  messageId?: number;
  thumbMessageId?: number;
  /** Present instead of `messageId` when the file lives in a packed bundle. */
  packed?: PackedSliceLocation;
  packedThumb?: PackedSliceLocation;
  bundleIndexMessageId?: number;
  uploadedAt: number;
}

/** Latest WhatsApp backup per channel. */
export interface WhatsAppBackupRow {
  channelId: string;
  backupId: string;
  createdAt: number;
  dbName: string | null;
  dbSize: number;
  dbSignature: string | null;
  /** JSON-encoded BackupDatabaseInfo, including ordered chunk message ids. */
  dbInfoJson: string | null;
  mediaCount: number;
  totalBytes: number;
  manifestMessageId: number | null;
}

class PicPocketDatabase extends Dexie {
  thumbs!: Table<ThumbRow, string>;
  media!: Table<MediaRow, [string, number]>;
  /** Packed items share a message id, so the gallery cache is keyed by item id. */
  mediaIndex!: Table<MediaRow, string>;
  channels!: Table<ChannelRow, string>;
  avatars!: Table<AvatarRow, string>;
  settings!: Table<SettingRow, string>;
  sessions!: Table<SessionRow, string>;
  whatsappFiles!: Table<WhatsAppFileRow, [string, string]>;
  whatsappBackups!: Table<WhatsAppBackupRow, string>;

  constructor() {
    super('vault-photos');
    this.version(1).stores({
      thumbs: 'key, channelId, lastUsed, byteSize',
      media: '[channelId+messageId], channelId, takenAt, lastUsed',
      channels: 'id, isSelected, lastUsed',
      avatars: 'key, lastUsed',
      settings: 'key',
      sessions: 'id',
    });
    this.version(2).stores({
      whatsappFiles: '[channelId+path], channelId, category, uploadedAt',
      whatsappBackups: 'channelId, createdAt',
    });
    // Packed items share a Telegram message but are distinct gallery rows.
    // Dexie cannot change an existing primary key, so use a new cache table.
    this.version(3).stores({
      mediaIndex: 'id, channelId, takenAt, lastUsed',
    });
  }
}

export const db = new PicPocketDatabase();

export const THUMB_CACHE_MAX_BYTES = 160 * 1024 * 1024; // 160 MB
export const THUMB_CACHE_MAX_ENTRIES = 4000;

export const thumbKey = (channelId: string, messageId: number): string => `${channelId}:${messageId}`;



/* ------------------------------------------------------------------ */
/* Thumbnails (LRU)                                                     */
/* ------------------------------------------------------------------ */

export async function getCachedThumb(key: string): Promise<Blob | undefined> {
  const row = await db.thumbs.get(key);
  if (!row) return undefined;
  // Touch lazily; not awaiting keeps the render path fast.
  void db.thumbs.update(key, { lastUsed: Date.now() }).catch(() => undefined);
  return row.bytes;
}

export async function putCachedThumb(row: Omit<ThumbRow, 'lastUsed'>): Promise<void> {
  await db.thumbs.put({ ...row, lastUsed: Date.now() });
}

export async function deleteCachedThumb(key: string): Promise<void> {
  await db.thumbs.delete(key);
}

/** Evicts least-recently-used previews once either budget is exceeded. */
export async function evictThumbs(
  maxBytes = THUMB_CACHE_MAX_BYTES,
  maxEntries = THUMB_CACHE_MAX_ENTRIES,
): Promise<number> {
  const count = await db.thumbs.count();
  let bytes = 0;
  await db.thumbs.each((row) => {
    bytes += row.byteSize;
  });

  if (count <= maxEntries && bytes <= maxBytes) return 0;

  let removed = 0;
  const excessEntries = Math.max(0, count - maxEntries);
  const targetBytes = maxBytes * 0.85;
  let remainingBytes = bytes;
  const rows = await db.thumbs.orderBy('lastUsed').toArray();

  for (const row of rows) {
    if (removed >= excessEntries && remainingBytes <= targetBytes) break;
    await db.thumbs.delete(row.key);
    remainingBytes -= row.byteSize;
    removed += 1;
  }
  return removed;
}

export async function getCacheStats(): Promise<{ entries: number; bytes: number }> {
  let bytes = 0;
  let entries = 0;
  await db.thumbs.each((row) => {
    bytes += row.byteSize;
    entries += 1;
  });
  return { entries, bytes };
}

/* ------------------------------------------------------------------ */
/* Media index                                                         */
/* ------------------------------------------------------------------ */

export async function getCachedMedia(channelIds: readonly string[]): Promise<MediaItem[]> {
  if (channelIds.length === 0) return [];
  const rows = await db.mediaIndex.where('channelId').anyOf([...channelIds]).toArray();
  return rows
    .sort((a, b) => b.takenAt - a.takenAt)
    .map(({ lastUsed: _lastUsed, ...item }) => item);
}

export async function putCachedMedia(items: readonly MediaItem[]): Promise<void> {
  if (items.length === 0) return;
  const now = Date.now();
  await db.mediaIndex.bulkPut(items.map((item) => ({ ...item, lastUsed: now })));
}

export async function deleteCachedMedia(id: string): Promise<void> {
  await db.mediaIndex.delete(id);
}

export async function clearChannelCache(channelId: string): Promise<void> {
  await db.mediaIndex.where('channelId').equals(channelId).delete();
  await db.thumbs.where('channelId').equals(channelId).delete();
}

export async function clearAllMediaCache(): Promise<void> {
  await Promise.all([db.mediaIndex.clear(), db.thumbs.clear()]);
}

/* ------------------------------------------------------------------ */
/* Channels & avatars                                                  */
/* ------------------------------------------------------------------ */

export async function getChannelRows(): Promise<ChannelRow[]> {
  return db.channels.toArray();
}

export async function putChannelRows(
  channels: readonly Omit<ChannelRow, 'lastUsed'>[],
): Promise<void> {
  const now = Date.now();
  await db.channels.bulkPut(channels.map((channel) => ({ ...channel, lastUsed: now })));
}

export async function getCachedAvatar(key: string): Promise<Blob | undefined> {
  const row = await db.avatars.get(key);
  if (!row) return undefined;
  void db.avatars.update(key, { lastUsed: Date.now() }).catch(() => undefined);
  return row.blob;
}

export async function putCachedAvatar(key: string, blob: Blob): Promise<void> {
  await db.avatars.put({ key, blob, lastUsed: Date.now() });
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const row = await db.settings.get(key);
  return row ? (row.value as T) : fallback;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await db.settings.put({ key, value });
}

export const loadVaultProfile = (): Promise<VaultProfile | undefined> =>
  getSetting<VaultProfile | undefined>('vault.profile', undefined);

export const saveVaultProfile = (profile: VaultProfile): Promise<void> =>
  setSetting('vault.profile', profile);

/* ------------------------------------------------------------------ */
/* Encrypted MTProto session                                           */
/* ------------------------------------------------------------------ */

export async function loadSealedSession(): Promise<string | undefined> {
  const row = await db.sessions.get('primary');
  return row?.ciphertext;
}

export async function saveSealedSession(ciphertext: string): Promise<void> {
  await db.sessions.put({ id: 'primary', ciphertext, createdAt: Date.now() });
}

export async function clearSealedSession(): Promise<void> {
  await db.sessions.delete('primary');
}

/* ------------------------------------------------------------------ */
/* WhatsApp sync manifest                                             */
/* ------------------------------------------------------------------ */

export async function getWhatsAppFiles(channelId: string): Promise<WhatsAppFileRow[]> {
  return db.whatsappFiles.where('channelId').equals(channelId).toArray();
}

export async function putWhatsAppFiles(rows: readonly WhatsAppFileRow[]): Promise<void> {
  if (rows.length === 0) return;
  await db.whatsappFiles.bulkPut([...rows]);
}

export async function deleteWhatsAppFile(
  channelId: string,
  path: string,
): Promise<void> {
  await db.whatsappFiles.delete([channelId, path]);
}

export async function getWhatsAppBackup(channelId: string): Promise<WhatsAppBackupRow | undefined> {
  return db.whatsappBackups.get(channelId);
}

export async function putWhatsAppBackup(row: WhatsAppBackupRow): Promise<void> {
  await db.whatsappBackups.put(row);
}

export async function clearWhatsAppManifest(channelId: string): Promise<void> {
  await Promise.all([
    db.whatsappFiles.where('channelId').equals(channelId).delete(),
    db.whatsappBackups.delete(channelId),
  ]);
}

/** Full local reset: session, profile, caches. Channel content stays in Telegram. */
export async function resetLocalData(): Promise<void> {
  await db.transaction(
    'rw',
    [db.sessions, db.settings, db.thumbs, db.media, db.mediaIndex, db.avatars, db.channels, db.whatsappFiles, db.whatsappBackups],
    async () => {
      await Promise.all([
        db.sessions.clear(),
        db.settings.clear(),
        db.thumbs.clear(),
        db.media.clear(),
        db.mediaIndex.clear(),
        db.avatars.clear(),
        db.channels.clear(),
        db.whatsappFiles.clear(),
        db.whatsappBackups.clear(),
      ]);
    },
  );
}
