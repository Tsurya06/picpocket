import type { DayGroup, MediaItem, MonthGroup } from '../types/media';
import { formatMonthLabel, humanDayLabel } from './format';

const dayKey = (timestamp: number): string => {
  const date = new Date(timestamp);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
};

const monthKey = (timestamp: number): string => {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
};

/** Groups a sorted-desc list into sticky month sections with day subheaders. */
export function groupTimeline(items: readonly MediaItem[]): MonthGroup[] {
  const months = new Map<string, Map<string, MediaItem[]>>();

  for (const item of items) {
    const month = monthKey(item.takenAt);
    const day = dayKey(item.takenAt);
    let days = months.get(month);
    if (!days) {
      days = new Map();
      months.set(month, days);
    }
    const bucket = days.get(day);
    if (bucket) bucket.push(item);
    else days.set(day, [item]);
  }

  const groups: MonthGroup[] = [];
  for (const [key, days] of months) {
    const dayGroups: DayGroup[] = [];
    let count = 0;
    for (const [day, dayItems] of days) {
      count += dayItems.length;
      dayGroups.push({
        key: day,
        label: humanDayLabel(dayItems[0]?.takenAt ?? Date.now()),
        items: dayItems,
      });
    }
    const first = dayGroups[0]?.items[0];
    groups.push({
      key,
      label: formatMonthLabel(first?.takenAt ?? Date.now()),
      count,
      days: dayGroups,
    });
  }
  return groups;
}

export function filterMedia(items: readonly MediaItem[], query: string): MediaItem[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...items];
  return items.filter((item) => {
    const haystack = `${item.fileName} ${item.caption ?? ''} ${item.channelTitle}`.toLowerCase();
    return haystack.includes(needle);
  });
}
