export const DEFAULT_SYNC_TIME = '03:00';

/** Accepts `H:MM` or `HH:MM` and always returns `HH:MM`. */
export function normalizeSyncTime(value: string): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return DEFAULT_SYNC_TIME;
  const hour = Math.min(23, Math.max(0, Number(match[1])));
  const minute = Math.min(59, Math.max(0, Number(match[2])));
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/**
 * The app cannot wake itself up, so this only answers "should the check run
 * the next time the app is open?".
 */
export function isSyncDue(lastSyncAt: number | null, time: string, now = Date.now()): boolean {
  const [hour, minute] = normalizeSyncTime(time).split(':').map(Number);
  const scheduled = new Date(now);
  scheduled.setHours(hour ?? 0, minute ?? 0, 0, 0);
  if (now < scheduled.getTime()) return false;
  if (lastSyncAt === null) return true;
  return lastSyncAt < scheduled.getTime();
}
