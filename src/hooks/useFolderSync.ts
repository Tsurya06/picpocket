import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  FolderSyncConfig,
  FolderSyncPhase,
  FolderSyncProgress,
  FolderLibraryEntry,
} from '../types/folderSync';
import {
  FolderPermissionError,
  clearFolderConfig,
  folderPermission,
  loadFolderConfig,
  pickFolder,
  requestFolderPermission,
  saveFolderConfig,
  scanFolderLibrary,
  supportsFolderSync,
  syncFolder,
  uploadFolderEntries,
  type FolderUploadResult,
} from '../services/media/folderSync';
import {
  startSyncKeepAlive,
  stopSyncKeepAlive,
  subscribeSyncKeepAlive,
} from '../services/media/syncKeepAlive';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface FolderSyncApi {
  readonly supported: boolean;
  readonly folderName: string | null;
  readonly lastSyncAt: number | null;
  readonly phase: FolderSyncPhase;
  readonly progress: FolderSyncProgress | null;
  readonly error: string | null;
  readonly syncing: boolean;
  readonly keepAlive: boolean;
  readonly autoSync: boolean;
  readonly setAutoSync: (value: boolean) => void;
  readonly listLocalFiles: () => Promise<readonly FolderLibraryEntry[]>;
  readonly uploadLocalFiles: (
    entries: readonly FolderLibraryEntry[],
  ) => Promise<FolderUploadResult>;
  readonly chooseFolder: () => Promise<void>;
  readonly syncNow: () => Promise<void>;
  readonly disconnect: () => Promise<void>;
}

interface UseFolderSyncOptions {
  readonly enabled: boolean;
  readonly channelId: string | null;
  readonly encrypt: boolean;
  readonly onUploaded: () => void;
}

const describeError = (caught: unknown): string => {
  if (caught instanceof FolderPermissionError) {
    return caught.message;
  }
  if (caught instanceof DOMException && caught.name === 'AbortError') return 'Cancelled.';
  if (caught instanceof Error && caught.message) return caught.message;
  return 'Folder sync failed. Please try again.';
};

/**
 * Syncs one local folder into the selected vault channel.
 *
 * The folder is checked when the app opens, at most once per day, and only
 * when the browser still grants read permission. Uploads normally run while
 * the app is open. A keep-alive loop starts automatically with each sync so
 * Chromium does not throttle a backgrounded PWA; closing the app still stops it.
 */
export function useFolderSync({
  enabled,
  channelId,
  encrypt,
  onUploaded,
}: UseFolderSyncOptions): FolderSyncApi {
  const [config, setConfig] = useState<FolderSyncConfig | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [phase, setPhase] = useState<FolderSyncPhase>('idle');
  const [progress, setProgress] = useState<FolderSyncProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [keepAlive, setKeepAliveState] = useState(false);
  const [autoSync, setAutoSyncState] = useState(true);
  const syncingRef = useRef(false);
  const entryUploadRef = useRef(false);
  const autoAttemptedRef = useRef(false);
  const runRef = useRef<((target: FolderSyncConfig, askPermission: boolean) => Promise<void>) | null>(null);

  useEffect(() => subscribeSyncKeepAlive(setKeepAliveState), []);

  // Locking the vault disables folder sync; do not leave the keep-alive audio running.
  useEffect(() => {
    if (!enabled) stopSyncKeepAlive();
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void loadFolderConfig()
      .then((value) => {
        if (cancelled) return;
        setConfig(value);
        setAutoSyncState(value?.autoSync ?? true);
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  const run = useCallback(
    async (target: FolderSyncConfig, askPermission: boolean): Promise<void> => {
      if (syncingRef.current || entryUploadRef.current) return;
      const activeChannel = channelId;
      if (!activeChannel) return;

      syncingRef.current = true;
      setError(null);
      setPhase('scanning');
      try {
        await startSyncKeepAlive();
        if (askPermission && !(await requestFolderPermission(target.handle))) {
          setPhase('needs-permission');
          setError(new FolderPermissionError().message);
          return;
        }

        const result = await syncFolder(target, activeChannel, encrypt, (next) => {
          setPhase(next.phase);
          setProgress(next);
        });
        setConfig((current) =>
          current ? { ...current, lastSyncAt: result.completedAt } : current,
        );
        setPhase('done');
        if (result.failed > 0) {
          setError(
            `${result.failed} item${result.failed === 1 ? '' : 's'} could not be uploaded. They will be retried on the next sync.`,
          );
        }
        if (result.uploaded > 0) onUploaded();
      } catch (caught) {
        setPhase(caught instanceof FolderPermissionError ? 'needs-permission' : 'error');
        setError(describeError(caught));
      } finally {
        stopSyncKeepAlive();
        syncingRef.current = false;
      }
    },
    [channelId, encrypt, onUploaded],
  );

  useEffect(() => {
    runRef.current = run;
  }, [run]);

  // Once per app session, and only if the last successful check is over a day old.
  // This deliberately does not depend on `run`: the timeline callback changes
  // after ordinary renders, and cancelling the pending permission check would
  // silently skip the automatic sync.
  useEffect(() => {
    if (!enabled || !loaded || !config || !channelId || !autoSync || autoAttemptedRef.current) return;
    if (config.lastSyncAt !== null && Date.now() - config.lastSyncAt < DAY_MS) return;

    autoAttemptedRef.current = true;
    let cancelled = false;
    void (async () => {
      const permission = await folderPermission(config.handle);
      if (cancelled) return;
      if (permission !== 'granted') {
        setPhase('needs-permission');
        setError(
          'Folder access needs renewing. Open Settings and sync the folder once to reconnect it.',
        );
        return;
      }
      await runRef.current?.(config, false);
    })();

    return () => {
      cancelled = true;
    };
  }, [autoSync, channelId, config, enabled, loaded]);

  const chooseFolder = useCallback(async (): Promise<void> => {
    if (syncingRef.current) return;
    if (!channelId) {
      setPhase('error');
      setError('Choose a vault channel before adding a folder.');
      return;
    }
    setError(null);
    try {
      const next = await pickFolder();
      setConfig(next);
      setAutoSyncState(true);
      setProgress(null);
      setPhase('idle');
      await run(next, false);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      setPhase(caught instanceof FolderPermissionError ? 'needs-permission' : 'error');
      setError(describeError(caught));
    }
  }, [channelId, run]);

  const syncNow = useCallback(async (): Promise<void> => {
    if (config) await run(config, true);
  }, [config, run]);

  const setAutoSync = useCallback(
    (value: boolean): void => {
      setAutoSyncState(value);
      setConfig((current) => (current ? { ...current, autoSync: value } : current));
      if (config) void saveFolderConfig({ ...config, autoSync: value });
    },
    [config],
  );

  const listLocalFiles = useCallback(async (): Promise<readonly FolderLibraryEntry[]> => {
    if (!config || !channelId) return [];
    return scanFolderLibrary(config, channelId);
  }, [channelId, config]);

  const uploadLocalFiles = useCallback(
    async (entries: readonly FolderLibraryEntry[]): Promise<FolderUploadResult> => {
      if (!config || !channelId) {
        throw new Error('Choose a folder and vault channel first.');
      }
      if (syncingRef.current || entryUploadRef.current) {
        throw new Error('Another folder upload is already running.');
      }

      entryUploadRef.current = true;
      try {
        const result = await uploadFolderEntries(config, channelId, encrypt, entries);
        if (result.uploaded > 0) onUploaded();
        return result;
      } finally {
        entryUploadRef.current = false;
      }
    },
    [channelId, config, encrypt, onUploaded],
  );

  const disconnect = useCallback(async (): Promise<void> => {
    stopSyncKeepAlive();
    await clearFolderConfig();
    setConfig(null);
    setAutoSyncState(true);
    setProgress(null);
    setPhase('idle');
    setError(null);
  }, []);

  return {
    supported: supportsFolderSync(),
    folderName: config?.name ?? null,
    lastSyncAt: config?.lastSyncAt ?? null,
    phase,
    progress,
    error,
    syncing: syncingRef.current || phase === 'scanning' || phase === 'uploading',
    keepAlive,
    autoSync,
    setAutoSync,
    listLocalFiles,
    uploadLocalFiles,
    chooseFolder,
    syncNow,
    disconnect,
  };
}