import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Clock3,
  CloudUpload,
  Database,
  Download,
  FileArchive,
  FolderOpen,
  Loader2,
  MessageCircle,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Square,
  UploadCloud,
} from 'lucide-react';
import { createSpeedTracker, formatBytes, formatFullDate, formatSpeed, humanDayLabel } from '../lib/format';
import type {
  BackupProgress,
  DirectoryScan,
  RestoreResult,
  SyncPlanSummary,
  WhatsAppLocalSummary,
  WhatsAppMediaKind,
  WhatsAppMediaSelection,
} from '../types/whatsapp';
import { hasAnyMedia } from '../types/whatsapp';
import {
  backupSharedFiles,
  clearWhatsAppFolderConfig,
  getLocalWhatsAppSummary,
  loadRemoteWhatsAppBackup,
  pickWhatsAppDirectory,
  previewWhatsAppSync,
  rescanWhatsAppFolder,
  restoreWhatsAppDatabase,
  scanWhatsAppFiles,
  supportsDirectoryPicker,
  syncWhatsAppBackup,
  WhatsAppFolderPermissionError,
  type RemoteBackup,
  type ScanProgress,
  type SyncResult,
} from '../services/whatsapp/whatsappSync';
import { Button } from './ui/Button';
import type { WhatsAppAutoSyncApi } from '../hooks/useWhatsAppAutoSync';

export interface WhatsAppBackupViewProps {
  readonly channelId: string | null;
  readonly channelTitle: string | null;
  readonly onChooseChannel: () => void;
  readonly autoSync: WhatsAppAutoSyncApi;
  readonly sharedFiles: readonly File[];
  readonly onSharedConsumed: () => void;
}

type Busy = 'scan' | 'sync' | 'restore' | 'shared' | null;

const EMPTY_PROGRESS: BackupProgress = {
  phase: 'idle',
  fraction: 0,
  label: '',
  chunksDone: 0,
  chunksTotal: 0,
  filesDone: 0,
  filesTotal: 0,
  bytesDone: 0,
  bytesTotal: 0,
};

const MEDIA_TOGGLES: ReadonlyArray<{ key: WhatsAppMediaKind; label: string }> = [
  { key: 'photos', label: 'Photos' },
  { key: 'videos', label: 'Videos' },
  { key: 'documents', label: 'PDFs & docs' },
];

/** Human-readable list of the media switches that are on. */
const mediaSummary = (media: WhatsAppMediaSelection): string =>
  MEDIA_TOGGLES.filter((toggle) => media[toggle.key])
    .map((toggle) => toggle.label.toLowerCase())
    .join(', ');

const describeError = (error: unknown): string => {
  if (error instanceof DOMException && error.name === 'AbortError') return 'Cancelled.';
  if (error instanceof Error && error.message) return error.message;
  return 'Something went wrong. Please try again.';
};

const RESTORE_STEPS = [
  {
    title: 'Save the database on your phone',
    detail: 'Put the restored file in /Android/media/com.whatsapp/WhatsApp/Databases/.',
  },
  {
    title: 'Install WhatsApp, do not open it',
    detail: 'Use the same phone number as the backup, then force-stop WhatsApp before restoring.',
  },
  {
    title: 'Copy the file and open WhatsApp',
    detail: 'WhatsApp detects msgstore.db.crypt15 locally and offers to restore the chat history.',
  },
] as const;

function ProgressBar({ progress }: { progress: BackupProgress }) {
  const percent = Math.round(Math.max(0, Math.min(1, progress.fraction)) * 100);
  // A folder walk has no known total, so a 0% bar looks frozen; show activity instead.
  const scanning = progress.phase === 'scanning';
  const trackerRef = useRef(createSpeedTracker());
  const [speedBytesPerSec, setSpeedBytesPerSec] = useState(0);

  useEffect(() => {
    if (progress.phase !== 'database' && progress.phase !== 'media' && progress.phase !== 'restore') {
      trackerRef.current.reset();
      setSpeedBytesPerSec(0);
      return;
    }
    const next = trackerRef.current.update(progress.bytesDone);
    if (next > 0) setSpeedBytesPerSec(next);
  }, [progress.bytesDone, progress.phase]);

  const speedLabel = formatSpeed(speedBytesPerSec);

  return (
    <div className="space-y-2" aria-live="polite">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="flex min-w-0 items-center gap-2">
          {scanning ? <Loader2 size={13} className="shrink-0 animate-spin text-accent" /> : null}
          <span className="truncate text-ink">{progress.label}</span>
        </span>
        <span className="shrink-0 font-medium tabular-nums text-muted">
          {scanning
            ? `${progress.filesDone.toLocaleString()} files`
            : speedLabel
              ? `${speedLabel} · ${percent}%`
              : `${percent}%`}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-surface">
        {scanning ? (
          <div className="h-full w-full animate-pulse rounded-full bg-accent/50" />
        ) : (
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-300"
            style={{ width: `${percent}%` }}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          />
        )}
      </div>
      {progress.chunksTotal > 0 ? (
        <p className="text-[11px] text-muted">
          Chat database: {progress.chunksDone} of {progress.chunksTotal} parts
          {progress.filesTotal > 0
            ? ` · media: ${progress.filesDone} of ${progress.filesTotal}`
            : ''}
        </p>
      ) : progress.filesTotal > 0 ? (
        <p className="text-[11px] text-muted">
          Media {progress.filesDone} of {progress.filesTotal}
          {progress.bytesTotal > 0
            ? ` · ${formatBytes(progress.bytesDone)} of ${formatBytes(progress.bytesTotal)}`
            : ''}
        </p>
      ) : progress.bytesTotal > 0 ? (
        <p className="text-[11px] text-muted">
          {formatBytes(progress.bytesDone)} of {formatBytes(progress.bytesTotal)}
        </p>
      ) : null}
    </div>
  );
}

function StatCard({
  label,
  value,
  detail,
  icon,
  loading,
}: {
  readonly label: string;
  readonly value: string;
  readonly detail: string;
  readonly icon: ReactNode;
  readonly loading?: boolean;
}) {
  return (
    <div className="rounded-2xl border border-line bg-elevated p-4">
      <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-muted">
        <span className="text-accent">{icon}</span>
        {label}
      </div>
      {loading ? (
        <div className="mt-3 h-6 w-24 animate-pulse rounded bg-surface" />
      ) : (
        <p className="mt-2 truncate text-lg font-semibold tracking-tight text-ink">{value}</p>
      )}
      <p className="mt-0.5 truncate text-[11px] text-muted">{detail}</p>
    </div>
  );
}

export function WhatsAppBackupView({
  channelId,
  channelTitle,
  onChooseChannel,
  autoSync,
  sharedFiles,
  onSharedConsumed,
}: WhatsAppBackupViewProps) {
  const [summary, setSummary] = useState<WhatsAppLocalSummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [scan, setScan] = useState<DirectoryScan | null>(null);
  const [plan, setPlan] = useState<SyncPlanSummary | null>(null);
  const [remote, setRemote] = useState<RemoteBackup | null>(null);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [progress, setProgress] = useState<BackupProgress>(EMPTY_PROGRESS);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [restoreResult, setRestoreResult] = useState<RestoreResult | null>(null);
  const [lastSync, setLastSync] = useState<{ result: SyncResult; at: number } | null>(null);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const archiveInputRef = useRef<HTMLInputElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const pickerAvailable = supportsDirectoryPicker();

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.setAttribute('webkitdirectory', '');
    input.setAttribute('directory', '');
  }, []);

  const refreshSummary = useCallback(async (): Promise<void> => {
    if (!channelId) {
      setSummary(null);
      return;
    }
    setSummaryLoading(true);
    try {
      setSummary(await getLocalWhatsAppSummary(channelId));
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setSummaryLoading(false);
    }
  }, [channelId]);

  const loadRemote = useCallback(async (): Promise<void> => {
    if (!channelId) {
      setRemote(null);
      return;
    }
    setRemoteLoading(true);
    try {
      setRemote(await loadRemoteWhatsAppBackup(channelId));
    } catch (caught) {
      setRemote(null);
      setError(describeError(caught));
    } finally {
      setRemoteLoading(false);
    }
  }, [channelId]);

  useEffect(() => {
    setScan(null);
    setPlan(null);
    setRemote(null);
    setError(null);
    setNotice(null);
    setRestoreResult(null);
    setLastSync(null);
    setProgress(EMPTY_PROGRESS);
    void refreshSummary();
    void loadRemote();
  }, [refreshSummary, loadRemote]);

  useEffect(() => {
    if (autoSync.version === 0) return;
    void refreshSummary();
    void loadRemote();
  }, [autoSync.version, loadRemote, refreshSummary]);

  const applyScan = async (result: DirectoryScan): Promise<void> => {
    setScan(result);
    setPlan(null);
    if (result.latestDatabase === null && result.media.length === 0) {
      setNotice('No WhatsApp databases or media were found in that folder.');
      return;
    }
    if (!channelId) return;
    try {
      setPlan(await previewWhatsAppSync(channelId, result, autoSync.media));
    } catch (caught) {
      setError(describeError(caught));
    }
  };

  const onScanProgress = (next: ScanProgress): void => {
    setProgress({
      ...EMPTY_PROGRESS,
      phase: 'scanning',
      label: `Reading the WhatsApp folder… ${next.files.toLocaleString()} files found`,
      filesDone: next.files,
    });
  };

  /**
   * Manual runs take the same slot as the automatic backup, so tapping Re-sync
   * while an automatic check is due can never start two uploads at once.
   */
  const runLocked = async (task: () => Promise<void>): Promise<void> => {
    const release = autoSync.claimSync();
    if (!release) {
      setNotice('A WhatsApp backup is already running. Wait for it to finish, then check again.');
      return;
    }
    setNotice(null);
    try {
      await task();
    } finally {
      release();
    }
  };

  // Turning a media type on or off changes what is pending, so the preview is
  // recalculated instead of showing the old counts.
  const media = autoSync.media;
  const mediaKey = `${media.photos ? 1 : 0}${media.videos ? 1 : 0}${media.documents ? 1 : 0}`;
  const mediaPrefRef = useRef(mediaKey);
  useEffect(() => {
    if (mediaPrefRef.current === mediaKey) return;
    mediaPrefRef.current = mediaKey;
    if (!scan || !channelId) return;
    void previewWhatsAppSync(channelId, scan, autoSync.media)
      .then(setPlan)
      .catch(() => undefined);
  }, [autoSync.media, channelId, mediaKey, scan]);

  const pickFolder = async (): Promise<void> => {
    setError(null);
    setNotice(null);
    setLastSync(null);
    if (!pickerAvailable) {
      inputRef.current?.click();
      return;
    }
    await runLocked(async () => {
      const controller = new AbortController();
      abortRef.current = controller;
      setBusy('scan');
      setProgress({ ...EMPTY_PROGRESS, phase: 'scanning', label: 'Reading the WhatsApp folder…' });
      try {
        const result = await pickWhatsAppDirectory({
          signal: controller.signal,
          onProgress: onScanProgress,
        });
        await applyScan(result);
        await autoSync.refresh();
      } catch (caught) {
        if (controller.signal.aborted) {
          setNotice('Folder scan cancelled. Choose the folder again to retry.');
        } else if (!(caught instanceof DOMException && caught.name === 'AbortError')) {
          setError(describeError(caught));
        }
      } finally {
        abortRef.current = null;
        setBusy(null);
        setProgress(EMPTY_PROGRESS);
      }
    });
  };

  /**
   * Re-reads the remembered folder without the picker. Only when the browser
   * refuses permission do we fall back to choosing the folder again.
   */
  const rescanFolder = async (
    handle: FileSystemDirectoryHandle | null,
  ): Promise<DirectoryScan | null> => {
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy('scan');
    setError(null);
    setNotice(null);
    setLastSync(null);
    setProgress({
      ...EMPTY_PROGRESS,
      phase: 'scanning',
      label: 'Checking the WhatsApp folder for new files…',
    });
    try {
      if (handle) {
        try {
          return await rescanWhatsAppFolder(handle, {
            signal: controller.signal,
            onProgress: onScanProgress,
          });
        } catch (caught) {
          if (!(caught instanceof WhatsAppFolderPermissionError)) throw caught;
          // Access was revoked: the user approves the folder picker once more.
        }
      }
      return await pickWhatsAppDirectory({
        signal: controller.signal,
        onProgress: onScanProgress,
      });
    } catch (caught) {
      if (controller.signal.aborted) {
        setNotice('Folder check cancelled.');
      } else if (!(caught instanceof DOMException && caught.name === 'AbortError')) {
        setError(describeError(caught));
      }
      return null;
    } finally {
      abortRef.current = null;
      setBusy(null);
      setProgress(EMPTY_PROGRESS);
    }
  };

  const onDirectoryInput = (event: ChangeEvent<HTMLInputElement>): void => {
    const list = event.target.files;
    if (!list || list.length === 0) return;
    const result = scanWhatsAppFiles(list);
    event.target.value = '';
    void clearWhatsAppFolderConfig().then(() => autoSync.refresh());
    void applyScan(result);
  };

  const uploadScan = async (result: DirectoryScan): Promise<void> => {
    if (!channelId || busy !== null) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy('sync');
    setError(null);
    setNotice(null);
    setLastSync(null);
    setProgress({ ...EMPTY_PROGRESS, phase: 'database', label: 'Preparing the backup…' });
    try {
      const outcome = await syncWhatsAppBackup({
        channelId,
        scan: result,
        media: autoSync.media,
        onProgress: setProgress,
        signal: controller.signal,
      });
      const finishedAt = Date.now();
      setScan(null);
      setPlan(null);
      setLastSync({ result: outcome, at: finishedAt });
      await autoSync.markSynced(finishedAt);
      await refreshSummary();
      await loadRemote();
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(null);
      setProgress(EMPTY_PROGRESS);
      abortRef.current = null;
    }
  };

  /** One tap: check the remembered folder and upload only what changed. */
  const resync = async (): Promise<void> => {
    if (busy !== null || !channelId) return;
    if (!pickerAvailable) {
      setNotice('Select the WhatsApp folder to check for new files.');
      inputRef.current?.click();
      return;
    }
    await runLocked(async () => {
      const result = await rescanFolder(autoSync.config?.handle ?? null);
      if (!result) return;
      await autoSync.refresh();
      await applyScan(result);
      if (result.latestDatabase === null && result.media.length === 0) return;
      await uploadScan(result);
    });
  };

  const restore = async (): Promise<void> => {
    if (!remote || busy !== null) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy('restore');
    setError(null);
    setNotice(null);
    setRestoreResult(null);
    setProgress({ ...EMPTY_PROGRESS, phase: 'restore', label: 'Preparing download…' });
    try {
      const result = await restoreWhatsAppDatabase(remote.manifest, {
        onProgress: setProgress,
        signal: controller.signal,
      });
      setRestoreResult(result);
      setNotice(
        result.method === 'saved'
          ? `Database restored (${formatBytes(result.bytes)}). Copy it into the Databases folder before opening WhatsApp.`
          : `Database downloaded (${formatBytes(result.bytes)}). Move it into the Databases folder before opening WhatsApp.`,
      );
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(null);
      setProgress(EMPTY_PROGRESS);
      abortRef.current = null;
    }
  };

  const backupFiles = async (files: readonly File[], fromShareSheet: boolean): Promise<void> => {
    if (!channelId || files.length === 0 || busy !== null) return;
    setBusy('shared');
    setError(null);
    setNotice(null);
    setProgress({ ...EMPTY_PROGRESS, phase: 'media', label: 'Encrypting shared files…' });
    try {
      const result = await backupSharedFiles(channelId, files, setProgress);
      if (fromShareSheet) onSharedConsumed();
      await refreshSummary();
      await loadRemote();
      setNotice(
        result.uploaded > 0
          ? `Backed up ${result.uploaded} file${result.uploaded === 1 ? '' : 's'} into the WhatsApp vault.`
          : 'Those files were already backed up.',
      );
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(null);
      setProgress(EMPTY_PROGRESS);
    }
  };

  const backupShared = (): void => {
    void backupFiles(sharedFiles, true);
  };

  const onArchiveInput = (event: ChangeEvent<HTMLInputElement>): void => {
    const list = event.target.files;
    if (!list || list.length === 0) return;
    const files = Array.from(list);
    event.target.value = '';
    void backupFiles(files, false);
  };

  const cancel = (): void => {
    abortRef.current?.abort();
  };

  const autoRunning = autoSync.phase === 'scanning' || autoSync.phase === 'uploading';

  const stopAutoBackup = (): void => {
    autoSync.stop();
    setNotice(
      'Automatic backup stopped. Tap Re-sync now whenever you want to run it again.',
    );
  };

  const working = busy === 'sync' || busy === 'restore' || busy === 'scan';
  const lastSyncedAt = lastSync?.at ?? autoSync.config?.lastSyncAt ?? summary?.createdAt ?? null;
  const syncedParts: string[] = [];
  if (lastSync?.result.databaseUploaded) syncedParts.push('the chat database');
  if (lastSync && lastSync.result.uploadedMedia > 0) {
    syncedParts.push(
      `${lastSync.result.uploadedMedia} new media file${lastSync.result.uploadedMedia === 1 ? '' : 's'}`,
    );
  }
  const syncSummary = !lastSync
    ? ''
    : syncedParts.length > 0
      ? `${syncedParts.join(' and ')} uploaded to Telegram.`
      : 'No new or changed files were found in the folder — your backup is up to date.';

  return (
    <section className="mx-auto w-full max-w-4xl px-4 pb-28 pt-6 sm:px-6 md:pb-10">
      <div className="flex items-start gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-sm">
          <MessageCircle size={21} />
        </span>
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-ink sm:text-2xl">
            WhatsApp Vault
          </h1>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted">
            Keep a copy of your WhatsApp chats and media in a private Telegram channel. Nothing
            goes through Google Drive or a server — files are encrypted on this device before they
            are uploaded.
          </p>
        </div>
      </div>

      <div className="mt-5 flex flex-col gap-2 rounded-2xl border border-line bg-elevated px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-2.5">
          <Database size={16} className="shrink-0 text-accent" />
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">
              Backup channel
            </p>
            <p className="truncate text-sm font-medium text-ink">
              {channelTitle ?? 'No channel selected'}
            </p>
          </div>
        </div>
        <Button variant="secondary" size="sm" onClick={onChooseChannel} className="shrink-0">
          {channelTitle ? 'Change channel' : 'Choose channel'}
        </Button>
      </div>

      {!channelId ? (
        <div className="mt-3 flex items-start gap-2.5 rounded-2xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-xs leading-relaxed text-muted">
          <AlertCircle size={16} className="mt-0.5 shrink-0 text-amber-500" />
          <p>
            Pick a channel above. Backups are saved there as encrypted files, and nothing else in
            Telegram is touched.
          </p>
        </div>
      ) : null}

      {error ? (
        <div
          role="alert"
          className="mt-4 flex items-start gap-2.5 rounded-2xl border border-red-500/30 bg-red-500/5 px-4 py-3 text-xs leading-relaxed text-red-500"
        >
          <AlertCircle size={16} className="mt-0.5 shrink-0" />
          <p>{error}</p>
        </div>
      ) : null}

      {notice ? (
        <div className="mt-4 flex items-start gap-2.5 rounded-2xl border border-emerald-500/25 bg-emerald-500/5 px-4 py-3 text-xs leading-relaxed text-muted">
          <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-emerald-500" />
          <p>{notice}</p>
        </div>
      ) : null}

      <div className="mt-6 overflow-hidden rounded-3xl border border-line bg-elevated">
        <div className="flex items-center gap-2 border-b border-line px-5 py-4">
          <FolderOpen size={17} className="text-accent" />
          <h2 className="text-sm font-semibold text-ink">Sync WhatsApp folder</h2>
        </div>

        <div className="space-y-4 p-5">
          {autoSync.config ? (
            <div className="rounded-2xl border border-line bg-surface/50 p-4">
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <div className="flex min-w-0 items-center gap-2">
                  <FolderOpen size={15} className="shrink-0 text-accent" />
                  <p className="truncate text-sm font-medium text-ink">{autoSync.config.name}</p>
                  <span className="shrink-0 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-600">
                    Connected
                  </span>
                </div>
                <p className="text-[11px] text-muted">
                  {lastSyncedAt ? `Last synced ${formatFullDate(lastSyncedAt)}` : 'Not synced yet'}
                </p>
              </div>
              <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
                This folder stays remembered. Tap Re-sync now to send new messages and media — the
                browser only asks for a one-tap “Allow” to read it again.
              </p>
            </div>
          ) : (
            <p className="text-xs leading-relaxed text-muted">
              Choose your WhatsApp folder once — usually{' '}
              <code className="text-[11px]">/Android/media/com.whatsapp/WhatsApp</code>. PicPocket
              remembers it, so later you only tap Re-sync now. Only new or changed files are
              uploaded; WhatsApp encrypts its database itself and PicPocket adds another layer.
            </p>
          )}

          {lastSync ? (
            <div
              role="status"
              className="rounded-2xl border border-emerald-500/30 bg-emerald-500/5 p-4"
            >
              <p className="flex items-center gap-2 text-sm font-medium text-ink">
                <CheckCircle2 size={16} className="shrink-0 text-emerald-500" />
                {syncedParts.length > 0 ? 'Sync complete — backup updated' : 'Already up to date'}
              </p>
              <p className="mt-1 text-[11px] leading-relaxed text-muted">{syncSummary}</p>
              <p className="mt-0.5 text-[11px] text-muted">Checked {formatFullDate(lastSync.at)}</p>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              onClick={() => void (scan ? runLocked(() => uploadScan(scan)) : resync())}
              disabled={busy !== null || !channelId || autoRunning}
              leadingIcon={
                busy === 'sync' || busy === 'scan' ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : (
                  <UploadCloud size={16} />
                )
              }
            >
              {autoRunning
                ? 'Automatic backup running…'
                : busy === 'sync'
                  ? 'Syncing…'
                  : busy === 'scan'
                  ? 'Checking for new files…'
                  : scan
                    ? 'Sync now'
                    : 'Re-sync now'}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void pickFolder()}
              disabled={busy !== null}
              leadingIcon={<FolderOpen size={15} />}
            >
              {autoSync.config ? 'Choose a different folder' : 'Choose WhatsApp folder'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => archiveInputRef.current?.click()}
              disabled={busy !== null || !channelId}
              leadingIcon={<FileArchive size={15} />}
            >
              Import chat export
            </Button>
            {working ? (
              <Button variant="ghost" size="sm" onClick={cancel}>
                {busy === 'scan' ? 'Stop checking' : 'Cancel'}
              </Button>
            ) : null}
            {autoRunning ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={stopAutoBackup}
                data-auto-sync-control=""
                leadingIcon={<Square size={13} />}
              >
                Stop backup
              </Button>
            ) : null}
          </div>

          {!pickerAvailable ? (
            <p className="text-[11px] leading-relaxed text-muted">
              This browser can't open folders directly, so a file picker opens instead. On iOS, use{' '}
              <span className="font-medium text-ink">Import chat export</span> to pick the .zip that
              WhatsApp saved to Files.
            </p>
          ) : null}

          <div className="rounded-2xl border border-line bg-surface/50 p-4">
            <p className="flex items-center gap-2 text-xs font-medium text-ink">
              <FileArchive size={15} className="text-accent" /> What gets backed up
            </p>
            <p className="mt-1 text-[11px] leading-relaxed text-muted">
              {hasAnyMedia(media)
                ? `Chats plus ${mediaSummary(media)}. Slower and uses more Telegram storage.`
                : `Chats only — the encrypted chat database${scan?.latestDatabase ? ` (${formatBytes(scan.latestDatabase.file.size)})` : ''}, which is everything WhatsApp needs to restore your messages. Turn on photos, videos or PDFs below to add them.`}
            </p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {MEDIA_TOGGLES.map((toggle) => {
                const on = media[toggle.key];
                return (
                  <button
                    key={toggle.key}
                    type="button"
                    role="switch"
                    aria-checked={on}
                    aria-label={`Include WhatsApp ${toggle.label.toLowerCase()}`}
                    disabled={!autoSync.config}
                    onClick={() =>
                      void autoSync.setMedia({ ...media, [toggle.key]: !on })
                    }
                    className={`rounded-full border px-3 py-1.5 text-[11px] font-medium transition-colors disabled:opacity-40 ${
                      on
                        ? 'border-accent bg-accent/10 text-accent'
                        : 'border-line text-muted hover:text-ink'
                    }`}
                  >
                    {on ? '✓ ' : ''}
                    {toggle.label}
                  </button>
                );
              })}
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-muted">
              {autoSync.config
                ? 'Only these file types are added to the chat database. Nothing else is uploaded.'
                : 'Choose the WhatsApp folder first to change this.'}
            </p>
          </div>

          <div className="rounded-2xl border border-line bg-surface/50 p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="flex items-center gap-2 text-xs font-medium text-ink">
                  <Clock3 size={15} className="text-accent" /> Automatic backup
                </p>
                <p className="mt-1 text-[11px] leading-relaxed text-muted">
                  Checks once a day at your chosen time, while PicPocket is open. Chrome or Edge on a
                  computer can run it with no tap at all (choose “Allow on every visit”); on a phone
                  the next tap after opening the app starts it. Switching it off also stops a backup
                  that is already running.
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={autoSync.autoSync}
                aria-label="Automatic WhatsApp backup"
                data-auto-sync-control=""
                disabled={!autoSync.config}
                onClick={() => void autoSync.setAutoSync(!autoSync.autoSync)}
                className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-40 ${
                  autoSync.autoSync ? 'bg-accent' : 'bg-line'
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
                    autoSync.autoSync ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </button>
            </div>

            {autoSync.config ? (
              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line pt-3">
                <label className="flex items-center gap-2 text-[11px] font-medium text-muted">
                  Backup time
                  <input
                    type="time"
                    value={autoSync.scheduleTime}
                    onChange={(event) => void autoSync.setScheduleTime(event.target.value)}
                    className="h-8 rounded-lg border border-line bg-app px-2 text-xs text-ink focus:border-accent focus:outline-none"
                  />
                </label>
                <p className="text-[11px] text-muted">
                  {autoSync.lastSyncAt
                    ? `Last check ${formatFullDate(autoSync.lastSyncAt)}`
                    : 'Not checked automatically yet'}
                </p>
              </div>
            ) : (
              <p className="mt-3 text-[11px] leading-relaxed text-muted">
                {pickerAvailable
                  ? 'Choose a WhatsApp folder above to enable scheduled backups.'
                  : 'Scheduled backups need a browser that can remember folder access. This browser can upload on demand only.'}
              </p>
            )}

            {autoSync.awaitingTap ? (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <p className="text-[11px] font-medium leading-relaxed text-accent">
                  Backup is due — tap anywhere to allow the WhatsApp folder, then it starts on its
                  own.
                </p>
                <Button variant="ghost" size="sm" onClick={stopAutoBackup} data-auto-sync-control="">
                  Not now
                </Button>
              </div>
            ) : null}
            {autoSync.error ? (
              <p className="mt-2 text-[11px] leading-relaxed text-danger">{autoSync.error}</p>
            ) : null}
            {autoRunning && autoSync.progress ? (
              <div className="mt-3 space-y-2">
                <ProgressBar progress={autoSync.progress} />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={stopAutoBackup}
                  data-auto-sync-control=""
                  leadingIcon={<Square size={13} />}
                >
                  Stop backup
                </Button>
              </div>
            ) : null}
          </div>

          {scan ? (
            <div className="rounded-2xl border border-line bg-surface/50 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-ink">{scan.rootName}</p>
                  <p className="mt-0.5 text-[11px] text-muted">
                    {scan.files.length.toLocaleString()} files · {formatBytes(scan.totalBytes)}
                    {scan.skipped > 0 ? ` · ${scan.skipped} skipped` : ''}
                  </p>
                </div>
                <span className="shrink-0 rounded-full bg-surface px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted">
                  {scan.latestDatabase ? 'Database found' : 'Media only'}
                </span>
              </div>

              <dl className="mt-3 grid grid-cols-1 gap-1.5 text-[11px] sm:grid-cols-2">
                <div className="flex justify-between gap-2 sm:block">
                  <dt className="text-muted">Latest database</dt>
                  <dd className="truncate text-ink">
                    {scan.latestDatabase
                      ? `${scan.latestDatabase.file.name} — ${formatBytes(scan.latestDatabase.file.size)}`
                      : 'None in this folder'}
                  </dd>
                </div>
                <div className="flex justify-between gap-2 sm:block">
                  <dt className="text-muted">Media files</dt>
                  <dd className="truncate text-ink">
                    {scan.media.length.toLocaleString()} ·{' '}
                    {formatBytes(scan.media.reduce((sum, entry) => sum + entry.file.size, 0))}
                    {hasAnyMedia(media) ? '' : ' · not uploaded'}
                  </dd>
                </div>
                <div className="flex justify-between gap-2 sm:block">
                  <dt className="text-muted">New files to send</dt>
                  <dd className="truncate text-ink">
                    {plan
                      ? hasAnyMedia(media)
                        ? `${plan.pendingMediaCount.toLocaleString()} new/changed · ${formatBytes(plan.pendingBytes)}`
                        : 'None — chats only'
                      : 'Checking local index…'}
                  </dd>
                </div>
                <div className="flex justify-between gap-2 sm:block">
                  <dt className="text-muted">Chat database</dt>
                  <dd className="truncate text-ink">
                    {plan
                      ? plan.databaseChanged
                        ? 'Will be uploaded'
                        : 'Already up to date'
                      : '—'}
                  </dd>
                </div>
              </dl>
            </div>
          ) : null}

          {progress.phase !== 'idle' ? (
            <div className="rounded-2xl border border-line bg-surface/50 p-4">
              <ProgressBar progress={progress} />
            </div>
          ) : null}
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard
          label="Last backup"
          value={summary ? humanDayLabel(summary.createdAt) : 'Never'}
          detail={summary ? formatFullDate(summary.createdAt) : 'Nothing backed up yet'}
          icon={<CloudUpload size={13} />}
          loading={summaryLoading}
        />
        <StatCard
          label="Chat history"
          value={summary?.database ? formatBytes(summary.database.size) : 'Not backed up'}
          detail="Messages & groups"
          icon={<Database size={13} />}
          loading={summaryLoading}
        />
        <StatCard
          label="WhatsApp media"
          value={summary ? `${summary.mediaCount.toLocaleString()} files` : '0 files'}
          detail={summary ? `${formatBytes(summary.totalBytes)} total` : 'Images, video, voice notes'}
          icon={<FileArchive size={13} />}
          loading={summaryLoading}
        />
      </div>

      <div className="mt-5 overflow-hidden rounded-3xl border border-line bg-elevated">
        <div className="flex items-center justify-between gap-2 border-b border-line px-5 py-4">
          <div className="flex items-center gap-2">
            <Download size={17} className="text-accent" />
            <h2 className="text-sm font-semibold text-ink">Download &amp; restore to phone</h2>
          </div>
          <button
            type="button"
            onClick={() => void loadRemote()}
            disabled={remoteLoading || !channelId}
            aria-label="Refresh backup manifest"
            className="flex h-8 w-8 items-center justify-center rounded-full text-muted hover:bg-surface disabled:opacity-50"
          >
            {remoteLoading ? (
              <Loader2 size={15} className="animate-spin" />
            ) : (
              <RefreshCw size={15} />
            )}
          </button>
        </div>

        <div className="space-y-4 p-5">
          {remoteLoading ? (
            <p className="flex items-center gap-2 text-xs text-muted">
              <Loader2 size={14} className="animate-spin" /> Looking for an existing backup…
            </p>
          ) : remote ? (
            <div className="rounded-2xl border border-line bg-surface/50 p-4">
              <p className="text-sm font-medium text-ink">
                {remote.manifest.database?.name ?? 'Backup without database'}
              </p>
              <p className="mt-0.5 text-[11px] text-muted">
                {formatFullDate(remote.manifest.createdAt)} ·{' '}
                {remote.manifest.database
                  ? `${formatBytes(remote.manifest.database.size)} in ${remote.manifest.database.chunks.length} chunks`
                  : 'No msgstore in this manifest'}{' '}
                · {remote.manifest.media.length.toLocaleString()} media
              </p>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button
                  onClick={() => void restore()}
                  disabled={busy !== null || !remote.manifest.database}
                  leadingIcon={
                    busy === 'restore' ? (
                      <Loader2 size={16} className="animate-spin" />
                    ) : (
                      <Smartphone size={16} />
                    )
                  }
                >
                  {busy === 'restore' ? 'Restoring…' : 'Download & Restore'}
                </Button>
                {working ? (
                  <Button variant="ghost" size="sm" onClick={cancel}>
                    Cancel
                  </Button>
                ) : null}
              </div>

              {restoreResult ? (
                <p className="mt-3 text-[11px] text-muted">
                  {restoreResult.method === 'saved'
                    ? 'Saved to the folder you picked.'
                    : 'Downloaded as one file. Very large databases need plenty of free memory.'}
                </p>
              ) : null}
            </div>
          ) : (
            <p className="text-xs leading-relaxed text-muted">
              No backup found in this channel yet. Upload one first — this card finds it
              automatically.
            </p>
          )}

          <div className="space-y-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">
              Restore checklist
            </p>
            <ol className="space-y-3">
              {RESTORE_STEPS.map((step, index) => (
                <li key={step.title} className="flex gap-3">
                  <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[11px] font-semibold text-accent">
                    {index + 1}
                  </span>
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-ink">{step.title}</p>
                    <p className="mt-0.5 break-words text-[11px] leading-relaxed text-muted">
                      {step.detail}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          </div>

          <div className="flex items-start gap-2.5 rounded-xl border border-line bg-surface/40 px-3.5 py-3 text-[11px] leading-relaxed text-muted">
            <ShieldCheck size={15} className="mt-0.5 shrink-0 text-emerald-500" />
            <p>
              WhatsApp verifies the database against your phone number. Modern Android versions may
              block apps from writing into another app&apos;s folder — use a file manager with
              folder access (or root) if the copy is refused.
            </p>
          </div>
        </div>
      </div>

      {sharedFiles.length > 0 ? (
        <div className="mt-5 overflow-hidden rounded-3xl border border-accent/30 bg-accent-soft/30">
          <div className="flex items-center gap-2 border-b border-accent/20 px-5 py-4">
            <FileArchive size={17} className="text-accent" />
            <h2 className="text-sm font-semibold text-ink">Shared from your phone</h2>
          </div>
          <div className="space-y-3 p-5">
            <ul className="space-y-1.5">
              {sharedFiles.slice(0, 6).map((file, index) => (
                <li
                  key={`${file.name}-${index}`}
                  className="flex items-center justify-between gap-3 text-xs"
                >
                  <span className="min-w-0 truncate text-ink">{file.name}</span>
                  <span className="shrink-0 text-muted">{formatBytes(file.size)}</span>
                </li>
              ))}
              {sharedFiles.length > 6 ? (
                <li className="text-[11px] text-muted">+{sharedFiles.length - 6} more</li>
              ) : null}
            </ul>
            <Button
              onClick={() => void backupShared()}
              disabled={!channelId || busy !== null}
              leadingIcon={
                busy === 'shared' ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : (
                  <UploadCloud size={16} />
                )
              }
            >
              {busy === 'shared' ? 'Backing up…' : 'Back up shared files'}
            </Button>
            {!channelId ? (
              <p className="text-[11px] text-muted">Choose a backup channel first.</p>
            ) : null}
          </div>
        </div>
      ) : null}

      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        onChange={onDirectoryInput}
        tabIndex={-1}
        aria-hidden="true"
      />

      <input
        ref={archiveInputRef}
        type="file"
        multiple
        accept=".zip,application/zip,application/x-zip-compressed,application/octet-stream"
        hidden
        onChange={onArchiveInput}
        tabIndex={-1}
        aria-hidden="true"
      />
    </section>
  );
}
