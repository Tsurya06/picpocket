/** Small SQLite layer: settings, WhatsApp file index, backup bookkeeping. */
import * as SQLite from 'expo-sqlite';

export interface WhatsAppFileRow {
  readonly path: string;
  readonly signature: string;
  readonly category: string;
  readonly size: number;
  readonly lastModified: number;
  readonly messageId?: number;
}

export interface BackupRow {
  readonly dbSignature: string | null;
  readonly dbName: string | null;
  readonly dbPath: string | null;
  readonly dbInfo: string | null;
  readonly mediaCount: number;
  readonly totalBytes: number;
  readonly updatedAt: number;
}

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

const open = async (): Promise<SQLite.SQLiteDatabase> => {
  dbPromise ??= (async () => {
    const db = await SQLite.openDatabaseAsync('picpocket.db');
    await db.execAsync(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS whatsapp_files (
        channelId TEXT NOT NULL,
        path TEXT NOT NULL,
        signature TEXT NOT NULL,
        category TEXT NOT NULL,
        size INTEGER NOT NULL,
        lastModified INTEGER NOT NULL,
        messageId INTEGER,
        PRIMARY KEY (channelId, path)
      );
      CREATE TABLE IF NOT EXISTS whatsapp_backups (
        channelId TEXT PRIMARY KEY NOT NULL,
        dbSignature TEXT,
        dbName TEXT,
        dbPath TEXT,
        dbInfo TEXT,
        mediaCount INTEGER NOT NULL DEFAULT 0,
        totalBytes INTEGER NOT NULL DEFAULT 0,
        updatedAt INTEGER NOT NULL
      );
    `);
    return db;
  })();
  return dbPromise;
};

export async function getSetting(key: string): Promise<string | null> {
  const db = await open();
  const row = await db.getFirstAsync<{ value: string }>(
    'SELECT value FROM settings WHERE key = ?',
    key,
  );
  return row?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  const db = await open();
  await db.runAsync(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key,
    value,
  );
}

export async function removeSetting(key: string): Promise<void> {
  const db = await open();
  await db.runAsync('DELETE FROM settings WHERE key = ?', key);
}

export async function getJsonSetting<T>(key: string): Promise<T | null> {
  const raw = await getSetting(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function setJsonSetting(key: string, value: unknown): Promise<void> {
  await setSetting(key, JSON.stringify(value));
}

export async function listWhatsAppFiles(channelId: string): Promise<WhatsAppFileRow[]> {
  const db = await open();
  const rows = await db.getAllAsync<{
    path: string;
    signature: string;
    category: string;
    size: number;
    lastModified: number;
    messageId: number | null;
  }>('SELECT * FROM whatsapp_files WHERE channelId = ?', channelId);
  return rows.map((row) => ({
    path: row.path,
    signature: row.signature,
    category: row.category,
    size: row.size,
    lastModified: row.lastModified,
    ...(row.messageId !== null ? { messageId: row.messageId } : {}),
  }));
}

export async function putWhatsAppFile(
  channelId: string,
  row: WhatsAppFileRow,
): Promise<void> {
  const db = await open();
  await db.runAsync(
    `INSERT INTO whatsapp_files (channelId, path, signature, category, size, lastModified, messageId)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(channelId, path) DO UPDATE SET
       signature = excluded.signature, category = excluded.category, size = excluded.size,
       lastModified = excluded.lastModified, messageId = excluded.messageId`,
    channelId,
    row.path,
    row.signature,
    row.category,
    row.size,
    row.lastModified,
    row.messageId ?? null,
  );
}

export async function deleteWhatsAppFiles(channelId: string): Promise<void> {
  const db = await open();
  await db.runAsync('DELETE FROM whatsapp_files WHERE channelId = ?', channelId);
}

export async function getBackupRow(channelId: string): Promise<BackupRow | null> {
  const db = await open();
  const row = await db.getFirstAsync<{
    dbSignature: string | null;
    dbName: string | null;
    dbPath: string | null;
    dbInfo: string | null;
    mediaCount: number;
    totalBytes: number;
    updatedAt: number;
  }>('SELECT * FROM whatsapp_backups WHERE channelId = ?', channelId);
  if (!row) return null;
  return {
    dbSignature: row.dbSignature,
    dbName: row.dbName,
    dbPath: row.dbPath,
    dbInfo: row.dbInfo,
    mediaCount: row.mediaCount,
    totalBytes: row.totalBytes,
    updatedAt: row.updatedAt,
  };
}

export async function saveBackupRow(channelId: string, row: BackupRow): Promise<void> {
  const db = await open();
  await db.runAsync(
    `INSERT INTO whatsapp_backups
       (channelId, dbSignature, dbName, dbPath, dbInfo, mediaCount, totalBytes, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(channelId) DO UPDATE SET
       dbSignature = excluded.dbSignature, dbName = excluded.dbName, dbPath = excluded.dbPath,
       dbInfo = excluded.dbInfo, mediaCount = excluded.mediaCount,
       totalBytes = excluded.totalBytes, updatedAt = excluded.updatedAt`,
    channelId,
    row.dbSignature,
    row.dbName,
    row.dbPath,
    row.dbInfo,
    row.mediaCount,
    row.totalBytes,
    row.updatedAt,
  );
}
