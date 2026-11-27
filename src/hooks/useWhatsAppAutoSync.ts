import { useCallback, useEffect, useRef, useState } from 'react';
import type { BackupProgress, WhatsAppFolderConfig } from '../types/whatsapp';
import { DEFAULT_SYNC_TIME, isSyncDue, normalizeSyncTime } from '../lib/syncSchedule';
import {
  loadWhatsAppFolderConfig,
  markWhatsAppFolderSynced,
  requestWhatsAppFolderPermission,
  saveWhatsAppFolderConfig,
  scanWhatsAppDirectory,
  syncWhatsAppBackup,
  whatsAppFolderPermission,
} from '../services/whatsapp/whatsappSync';
import { startSyncKeepAlive, stopSyncKeepAlive } from '../services/media/syncKeepAlive';

export type WhatsAppAutoPhase = 'idle' | 'scanning' | 'uploading' | 'done' | 'error' | 'permission';

export interface WhatsAppAutoSyncApi {
  readonly config: WhatsAppFolderConfig | null;
  readonly autoSync: boolean;
  readonly scheduleTime: string;
  readonly phase: WhatsAppAutoPhase;
  readonly progress: BackupProgress | null;
  readonly error: string | null;
  readonly lastSyncAt: number | null;
  /** True while a due backup waits for the tap that re-grants folder access. */
  readonly awaitingTap: boolean;
  /** Increments after an automatic backup so the view can refresh its summary. */
  readonly version: number;
  readonly refresh: () => Promise<void>;
  readonly setAutoSync: (value: boolean) => Promise<void>;
  readonly setScheduleTime: (value: string) => Promise<void>;
  readonly markSynced: (at?: number) => Promise<void>;
  /**
   * Reserves the single sync slot for a manual run. Returns null when a backup
   * is already running, so manual and automatic backups never overlap.
   */
  readonly claimSync: () => (() => void) | null;
}

const describeError = (caught: unknown): string => {
  if (caught instanceof DOMException && caught.name === 'AbortError') return 'Cancelled.';
  if (caught instanceof Error && caught.message) return caught.message;
  return 'Automatic WhatsApp backup failed. Please try again.';
};

/**
 * Runs a daily WhatsApp backup while PicPocket is open. The folder handle is
 * persisted, but browsers cannot wake a closed PWA, so the chosen time is a
 * check time rather than a guaranteed background alarm.
 */
export function useWhatsAppAutoSync(options: {
  readonly enabled: boolean;
  readonly channelId: string | null;
}): WhatsAppAutoSyncApi {
  const { enabled, channelId } = options;
  const [config, setConfig] = useState<WhatsAppFolderConfig | null>(null);
  const [autoSync, setAutoSyncState] = useState(false);
  const [scheduleTime, setScheduleTimeState] = useState(DEFAULT_SYNC_TIME);
  const [phase, setPhase] = useState<WhatsAppAutoPhase>('idle');
  const [progress, setProgress] = useState<BackupProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [awaitingTap, setAwaitingTap] = useState(false);
  const [tick, setTick] = useState(0);
  const runningRef = useRef(false);
  const attemptedRef = useRef(false);

  const applyConfig = useCallback((next: WhatsAppFolderConfig | null): void => {
    setConfig(next);
    setAutoSyncState(next?.autoSync === true);
    setScheduleTimeState(next?.scheduleTime ?? DEFAULT_SYNC_TIME);
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    const next = await loadWhatsAppFolderConfig();
    applyConfig(next);
    attemptedRef.current = false;
  }, [applyConfig]);

  useEffect(() => {
    if (!enabled) {
      applyConfig(null);
      setAwaitingTap(false);
      stopSyncKeepAlive();
      return;
    }
    void refresh().catch(() => undefined);
  }, [applyConfig, enabled, refresh]);

  useEffect(() => {
    attemptedRef.current = false;
  }, [autoSync, channelId, scheduleTime]);

  useEffect(() => {
    attemptedRef.current = false;
  }, [config?.lastSyncAt]);

  useEffect(() => {
    if (!enabled || !config?.autoSync) return;
    const timer = setInterval(() => setTick((value) => value + 1), 60_000);
    return () => clearInterval(timer);
  }, [config?.autoSync, enabled]);

  const setAutoSync = useCallback(
    async (value: boolean): Promise<void> => {
      const current = config ? { ...config, autoSync: value } : null;
      if (!current) return;
      applyConfig(current);
      await saveWhatsAppFolderConfig(current);
    },
    [applyConfig, config],
  );

  const setScheduleTime = useCallback(
    async (value: string): Promise<void> => {
      const nextTime = normalizeSyncTime(value);
      setScheduleTimeState(nextTime);
      if (!config) return;
      const next = { ...config, scheduleTime: nextTime };
      setConfig(next);
      await saveWhatsAppFolderConfig(next);
    },
    [config],
  );

  const markSynced = useCallback(
    async (at = Date.now()): Promise<void> => {
      await markWhatsAppFolderSynced(at);
      setConfig((current) => (current ? { ...current, lastSyncAt: at } : current));
      setAwaitingTap(false);
      setVersion((value) => value + 1);
    },
    [],
  );

  const claimSync = useCallback((): (() => void) | null => {
    if (runningRef.current) return null;
    runningRef.current = true;
    return () => {
      runningRef.current = false;
    };
  }, []);

  /** Scans the remembered folder and uploads whatever changed. */
  const runBackup = useCallback(
    async (handle: FileSystemDirectoryHandle, targetChannelId: string): Promise<void> => {
      const release = claimSync();
      if (!release) return;
      setError(null);
      setProgress(null);
      setPhase('scanning');
      await startSyncKeepAlive();

      try {
        const scan = await scanWhatsAppDirectory(handle, {
          onProgress: (next) => {
            setProgress({
              phase: 'scanning',
              fraction: 0,
              label: `Reading the WhatsApp folder… ${next.files.toLocaleString()} files found`,
              chunksDone: 0,
              chunksTotal: 0,
              filesDone: next.files,
              filesTotal: 0,
              bytesDone: 0,
              bytesTotal: 0,
            });
          },
        });
        setPhase('uploading');
        await syncWhatsAppBackup({
          channelId: targetChannelId,
          scan,
          onProgress: (next) => setProgress(next),
        });
        await markSynced(Date.now());
        setPhase('done');
        setError(null);
      } catch (caught) {
        setPhase('error');
        setError(describeError(caught));
      } finally {
        stopSyncKeepAlive();
        release();
      }
    },
    [claimSync, markSynced],
  );

  // A due backup starts on its own when the browser still remembers the folder
  // grant. Permissions are lost between sessions in most browsers, so the rest
  // of the time it waits for the next tap instead of failing.
  useEffect(() => {
    if (!enabled || !channelId || !config || !autoSync || runningRef.current) return;
    if (attemptedRef.current || !isSyncDue(config.lastSyncAt, scheduleTime)) return;

    attemptedRef.current = true;
    const handle = config.handle;
    let cancelled = false;

    void (async () => {
      const permission = await whatsAppFolderPermission(handle);
      if (cancelled) return;
      if (permission === 'granted') {
        setAwaitingTap(false);
        await runBackup(handle, channelId);
        return;
      }
      setPhase('permission');
      setError(null);
      setAwaitingTap(true);
    })();

    return () => {
      cancelled = true;
    };
  }, [autoSync, channelId, config, enabled, runBackup, scheduleTime, tick]);

  // `requestPermission()` only works inside a real gesture, so the first tap or
  // key press anywhere in the app renews access and then starts the backup.
  useEffect(() => {
    if (!enabled || !channelId || !config || !awaitingTap || runningRef.current) return;
    const handle = config.handle;
    const targetChannelId = channelId;

    function stopListening(): void {
      window.removeEventListener('pointerdown', resume, true);
      window.removeEventListener('keydown', resume, true);
    }

    async function resume(): Promise<void> {
      stopListening();
      setAwaitingTap(false);
      if (runningRef.current) return;
      const granted = await requestWhatsAppFolderPermission(handle);
      if (!granted) {
        setPhase('error');
        setError(
          'Folder access was not allowed. Open WhatsApp Vault and allow the WhatsApp folder once to resume automatic backups.',
        );
        return;
      }
      await runBackup(handle, targetChannelId);
    }

    window.addEventListener('pointerdown', resume, true);
    window.addEventListener('keydown', resume, true);
    return stopListening;
  }, [awaitingTap, channelId, config, enabled, runBackup]);

  return {
    config,
    autoSync,
    scheduleTime,
    phase,
    progress,
    error,
    lastSyncAt: config?.lastSyncAt ?? null,
    awaitingTap,
    version,
    refresh,
    setAutoSync,
    setScheduleTime,
    markSynced,
    claimSync,
  };
}
