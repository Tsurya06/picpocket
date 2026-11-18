/** Daily wall-clock time used by both folder and WhatsApp auto-sync. */
export const DEFAULT_SYNC_TIME = '03:00';

const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export function normalizeSyncTime(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_SYNC_TIME;
  const trimmed = value.trim();
  if (!/^\d{1,2}:\d{2}$/.test(trimmed)) return DEFAULT_SYNC_TIME;
  const [hours, minutes] = trimmed.split(':').map(Number);
  if (hours === undefined || minutes === undefined) return DEFAULT_SYNC_TIME;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return DEFAULT_SYNC_TIME;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

export function isValidSyncTime(value: string): boolean {
  return TIME_PATTERN.test(value);
}

/** The most recent occurrence of the daily schedule, including today's. */
export function lastScheduleOccurrence(time: string, now = Date.now()): number {
  const [hours = 3, minutes = 0] = normalizeSyncTime(time).split(':').map(Number);
  const today = new Date(now);
  today.setHours(hours, minutes, 0, 0);
  if (today.getTime() <= now) return today.getTime();

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(hours, minutes, 0, 0);
  return yesterday.getTime();
}

/** True when a daily check is due, or when the feature has never run. */
export function isSyncDue(lastSyncAt: number | null, time: string, now = Date.now()): boolean {
  return lastSyncAt === null || lastSyncAt < lastScheduleOccurrence(time, now);
}
