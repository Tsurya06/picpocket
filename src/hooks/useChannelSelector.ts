import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChannelSummary } from '../types/media';
import { getChannelRows, getSetting, putChannelRows, setSetting, type ChannelRow } from '../services/cache/db';
import { describeError, telegramService } from '../services/telegram/mtprotoClient';

const SELECTION_KEY = 'channels.selected';

const rowToSummary = (row: ChannelRow, selected: ReadonlySet<string>): ChannelSummary => ({
  id: row.id,
  title: row.title,
  username: row.username,
  memberCount: row.memberCount,
  kind: row.kind,
  isCreator: row.isCreator,
  isSelected: selected.has(row.id),
});

export interface ChannelSelectorApi {
  channels: ChannelSummary[];
  selectedIds: readonly string[];
  selectedChannels: ChannelSummary[];
  loading: boolean;
  error: string | null;
  needsSelection: boolean;
  refresh: () => Promise<void>;
  toggleChannel: (id: string) => void;
  clearSelection: () => void;
  createVaultChannel: (title: string) => Promise<ChannelSummary | null>;
}

export function useChannelSelector(options: {
  readonly enabled: boolean;
  readonly accountId: string | null;
}): ChannelSelectorApi {
  const { enabled, accountId } = options;
  const [channels, setChannels] = useState<ChannelSummary[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedRef = useRef<string[]>([]);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const persist = useCallback((ids: readonly string[]) => {
    selectedRef.current = [...ids];
    void setSetting(SELECTION_KEY, [...ids]);
  }, []);

  const applySelection = useCallback(
    (ids: readonly string[]) => {
      setSelectedIds([...ids]);
      setChannels((current) =>
        current.map((channel) => ({ ...channel, isSelected: ids.includes(channel.id) })),
      );
    },
    [],
  );

  const refresh = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    setError(null);

    try {
      const [rows, stored] = await Promise.all([
        getChannelRows(),
        getSetting<string[]>(SELECTION_KEY, []),
      ]);
      if (!mountedRef.current) return;

      const storedSet = new Set(stored);
      if (rows.length > 0 && channels.length === 0) {
        setChannels(rows.map((row) => rowToSummary(row, storedSet)));
      }
      if (selectedRef.current.length === 0 && stored.length > 0) {
        selectedRef.current = stored;
        setSelectedIds(stored);
      }

      const fresh = await telegramService.listChannels();
      if (!mountedRef.current) return;

      const selection = new Set(selectedRef.current.length > 0 ? selectedRef.current : stored);
      const merged = fresh.map((channel) => ({ ...channel, isSelected: selection.has(channel.id) }));
      const stillValid = merged.filter((channel) => selection.has(channel.id)).map((c) => c.id);

      setChannels(merged);
      applySelection(stillValid);
      persist(stillValid);
      await putChannelRows(merged);
    } catch (caught) {
      if (mountedRef.current) setError(describeError(caught));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [applySelection, channels.length, enabled, persist]);

  useEffect(() => {
    if (!enabled) {
      setChannels([]);
      setSelectedIds([]);
      selectedRef.current = [];
      return;
    }
    void refresh();
    // `refresh` intentionally excluded: it is recreated when the list length changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, accountId]);

  const toggleChannel = useCallback(
    (id: string) => {
      const current = selectedRef.current;
      const next = current.includes(id)
        ? current.filter((value) => value !== id)
        : [...current, id];
      applySelection(next);
      persist(next);
    },
    [applySelection, persist],
  );

  const clearSelection = useCallback(() => {
    applySelection([]);
    persist([]);
  }, [applySelection, persist]);

  const createVaultChannel = useCallback(
    async (title: string): Promise<ChannelSummary | null> => {
      try {
        const created = await telegramService.createVaultChannel(title.trim());
        const next = [...selectedRef.current, created.id];
        setChannels((current) =>
          [...current.filter((channel) => channel.id !== created.id), { ...created, isSelected: true }].sort(
            (a, b) => a.title.localeCompare(b.title),
          ),
        );
        applySelection(next);
        persist(next);
        void putChannelRows([created]);
        return created;
      } catch (caught) {
        setError(describeError(caught));
        return null;
      }
    },
    [applySelection, persist],
  );

  const selectedChannels = useMemo(
    () => channels.filter((channel) => selectedIds.includes(channel.id)),
    [channels, selectedIds],
  );

  return {
    channels,
    selectedIds,
    selectedChannels,
    loading,
    error,
    needsSelection: channels.length > 0 && selectedIds.length === 0,
    refresh,
    toggleChannel,
    clearSelection,
    createVaultChannel,
  };
}
