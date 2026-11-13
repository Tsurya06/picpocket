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
  UploadCloud,
} from 'lucide-react';
import { formatBytes, formatFullDate, humanDayLabel } from '../lib/format';
import type {
  BackupProgress,
  DirectoryScan,
  RestoreResult,
  SyncPlanSummary,
  WhatsAppLocalSummary,
} from '../types/whatsapp';
import {
  backupSharedFiles,
  getLocalWhatsAppSummary,
  loadRemoteWhatsAppBackup,
  pickWhatsAppDirectory,
  previewWhatsAppSync,
  restoreWhatsAppDatabase,
  scanWhatsAppFiles,
  supportsDirectoryPicker,
  syncWhatsAppBackup,
  type RemoteBackup,
} from '../services/whatsapp/whatsappSync';
import { Button } from './ui/Button';

export interface WhatsAppBackupViewProps {
  readonly channelId: string | null;
  readonly channelTitle: string | null;
  readonly onChooseChannel: () => void;
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
  return (
    <div className="space-y-2" aria-live="polite">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="min-w-0 truncate text-ink">{progress.label}</span>
        <span className="shrink-0 font-medium tabular-nums text-muted">{percent}%</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-surface">
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-300"
          style={{ width: `${percent}%` }}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        />
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
    setProgress(EMPTY_PROGRESS);
    void refreshSummary();
    void loadRemote();
  }, [refreshSummary, loadRemote]);

  const applyScan = async (result: DirectoryScan): Promise<void> => {
    setScan(result);
    setPlan(null);
    if (result.latestDatabase === null && result.media.length === 0) {
      setNotice('No WhatsApp databases or media were found in that folder.');
      return;
    }
    if (!channelId) return;
    try {
      setPlan(await previewWhatsAppSync(channelId, result));
    } catch (caught) {
      setError(describeError(caught));
    }
  };

  const pickFolder = async (): Promise<void> => {
    setError(null);
    setNotice(null);
    if (!pickerAvailable) {
      inputRef.current?.click();
      return;
    }
    setBusy('scan');
    setProgress({ ...EMPTY_PROGRESS, phase: 'scanning', label: 'Reading the WhatsApp folder…' });
    try {
      const result = await pickWhatsAppDirectory();
      await applyScan(result);
    } catch (caught) {
      if (!(caught instanceof DOMException && caught.name === 'AbortError')) {
        setError(describeError(caught));
      }
    } finally {
      setBusy(null);
      setProgress(EMPTY_PROGRESS);
    }
  };

  const onDirectoryInput = (event: ChangeEvent<HTMLInputElement>): void => {
    const list = event.target.files;
    if (!list || list.length === 0) return;
    const result = scanWhatsAppFiles(list);
    event.target.value = '';
    void applyScan(result);
  };

  const sync = async (): Promise<void> => {
    if (!scan || !channelId || busy !== null) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy('sync');
    setError(null);
    setNotice(null);
    setProgress({ ...EMPTY_PROGRESS, phase: 'database', label: 'Preparing the backup…' });
    try {
      const result = await syncWhatsAppBackup({
        channelId,
        scan,
        onProgress: setProgress,
        signal: controller.signal,
      });
      setScan(null);
      setPlan(null);
      await refreshSummary();
      await loadRemote();
      const mediaText = `${result.uploadedMedia} new media file${result.uploadedMedia === 1 ? '' : 's'}`;
      setNotice(
        result.uploadedMedia === 0 && !result.databaseUploaded
          ? 'Everything was already backed up — nothing new to upload.'
          : `Backup complete: ${mediaText}${result.databaseUploaded ? ' and the chat database' : ''} stored in Telegram.`,
      );
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(null);
      setProgress(EMPTY_PROGRESS);
      abortRef.current = null;
    }
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

  const working = busy === 'sync' || busy === 'restore';

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
          <p className="text-xs leading-relaxed text-muted">
            Choose your WhatsApp folder — usually{' '}
            <code className="text-[11px]">/Android/media/com.whatsapp/WhatsApp</code>. Only new or
            changed files are uploaded, and the list of what has already been sent stays in this
            browser. WhatsApp encrypts its chat database itself; PicPocket adds another layer on top.
          </p>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              onClick={() => void pickFolder()}
              disabled={busy !== null}
              leadingIcon={<FolderOpen size={16} />}
            >
              {pickerAvailable ? 'Choose WhatsApp folder' : 'Select WhatsApp folder'}
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
            {scan ? (
              <Button
                variant="primary"
                onClick={() => void sync()}
                disabled={busy !== null || !channelId}
                leadingIcon={
                  busy === 'sync' ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : (
                    <UploadCloud size={16} />
                  )
                }
              >
                {busy === 'sync' ? 'Backing up…' : 'Sync WhatsApp folder now'}
              </Button>
            ) : null}
            {working ? (
              <Button variant="ghost" size="sm" onClick={cancel}>
                Cancel
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
                  </dd>
                </div>
                <div className="flex justify-between gap-2 sm:block">
                  <dt className="text-muted">New files to send</dt>
                  <dd className="truncate text-ink">
                    {plan
                      ? `${plan.pendingMediaCount.toLocaleString()} new/changed · ${formatBytes(plan.pendingBytes)}`
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
