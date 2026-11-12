/**
 * Reads files that `src/sw.ts` stored when the OS share sheet POSTed to
 * `/share-target`. CacheStorage is same-origin, so the page can read the
 * stashed blobs directly. The stash is deleted after a successful read.
 */

export const SHARE_CACHE = 'vault-share-target';
const SHARE_PREFIX = '/__share/';

interface SharedFileEntry {
  readonly name: string;
  readonly type: string;
  readonly size: number;
  readonly key: string;
}

interface SharedMeta {
  readonly id: string;
  readonly createdAt: number;
  readonly title: string;
  readonly text: string;
  readonly files: readonly SharedFileEntry[];
}

export interface SharedPayload {
  readonly id: string;
  readonly createdAt: number;
  readonly title: string;
  readonly text: string;
  readonly files: File[];
}

const isSharedEntry = (value: unknown): value is SharedFileEntry => {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.name === 'string' &&
    typeof entry.type === 'string' &&
    typeof entry.size === 'number' &&
    typeof entry.key === 'string'
  );
};

const parseMeta = (value: unknown): SharedMeta | null => {
  if (typeof value !== 'object' || value === null) return null;
  const meta = value as Record<string, unknown>;
  if (
    typeof meta.id !== 'string' ||
    typeof meta.createdAt !== 'number' ||
    typeof meta.title !== 'string' ||
    typeof meta.text !== 'string' ||
    !Array.isArray(meta.files) ||
    !meta.files.every(isSharedEntry)
  ) {
    return null;
  }
  return {
    id: meta.id,
    createdAt: meta.createdAt,
    title: meta.title,
    text: meta.text,
    files: meta.files,
  };
};

const safeId = (id: string): string => id.replace(/[^a-zA-Z0-9-]/g, '');

export async function readSharedPayload(id: string): Promise<SharedPayload | null> {
  if (!('caches' in window)) return null;
  const safe = safeId(id);
  if (!safe) return null;

  try {
    const cache = await caches.open(SHARE_CACHE);
    const base = new URL(`${SHARE_PREFIX}${safe}/`, window.location.origin).toString();
    const metaResponse = await cache.match(`${base}meta`);
    if (!metaResponse) return null;

    const meta = parseMeta(await metaResponse.json());
    if (!meta) return null;

    const files: File[] = [];
    for (const entry of meta.files) {
      const response = await cache.match(entry.key);
      if (!response) continue;
      const blob = await response.blob();
      files.push(
        new File([blob], entry.name, {
          type: entry.type || 'application/octet-stream',
          lastModified: meta.createdAt,
        }),
      );
    }

    await clearSharedPayload(safe, meta);
    return { id: meta.id, createdAt: meta.createdAt, title: meta.title, text: meta.text, files };
  } catch {
    return null;
  }
}

export async function clearSharedPayload(id: string, meta?: SharedMeta): Promise<void> {
  if (!('caches' in window)) return;
  const cache = await caches.open(SHARE_CACHE);
  const base = new URL(`${SHARE_PREFIX}${safeId(id)}/`, window.location.origin).toString();
  await cache.delete(`${base}meta`);
  if (meta) {
    for (const entry of meta.files) await cache.delete(entry.key);
  }
}

/** Removes stale share stashes that were never opened (older than 2 days). */
export async function pruneShareCache(): Promise<void> {
  if (!('caches' in window)) return;
  try {
    const cache = await caches.open(SHARE_CACHE);
    const requests = await cache.keys();
    const cutoff = Date.now() - 2 * 86_400_000;
    for (const request of requests) {
      if (!request.url.includes(SHARE_PREFIX)) continue;
      const response = await cache.match(request);
      const dateHeader = response?.headers.get('date');
      const timestamp = dateHeader ? Date.parse(dateHeader) : Number.NaN;
      if (Number.isFinite(timestamp) && timestamp < cutoff) {
        await cache.delete(request);
      }
    }
  } catch {
    // Cache pruning is best-effort.
  }
}
