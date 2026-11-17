import { useCallback, useEffect, useState } from 'react';
import {
  CheckCircle2,
  CloudUpload,
  FolderOpen,
  ImageOff,
  Play,
  RefreshCw,
} from 'lucide-react';
import type { FolderLibraryEntry } from '../types/folderSync';
import type { FolderSyncApi } from '../hooks/useFolderSync';
import { formatBytes } from '../lib/format';
import { useNearViewport } from '../hooks/useNearViewport';
import { Button } from './ui/Button';
import { Modal } from './ui/Modal';
import { Spinner } from './ui/Spinner';

export interface FolderBrowserModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly folderSync: FolderSyncApi;
}

const isVideo = (file: File): boolean =>
  file.type.startsWith('video/') ||
  /\.(?:3gp|avi|m4v|mkv|mov|mp4|mpe?g|ogv|webm)$/i.test(file.name);

const describeError = (caught: unknown): string => {
  if (caught instanceof Error && caught.message) return caught.message;
  return 'Could not read this folder. Reconnect it and try again.';
};

function LocalPreview({ entry }: { readonly entry: FolderLibraryEntry }) {
  const [tileRef, nearViewport] = useNearViewport<HTMLDivElement>();
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!nearViewport) {
      setUrl(null);
      return;
    }
    const next = URL.createObjectURL(entry.file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [entry.file, nearViewport]);

  return (
    <div ref={tileRef} className="h-full w-full">
      {!url ? (
        <div className="h-full w-full bg-elevated shimmer" />
      ) : isVideo(entry.file) ? (
        <video
          src={url}
          muted
          playsInline
          preload="metadata"
          className="h-full w-full object-cover"
        />
      ) : entry.file.type.startsWith('image/') ? (
        <img
          src={url}
          alt={entry.path}
          loading="lazy"
          decoding="async"
          draggable={false}
          className="h-full w-full object-cover"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-elevated text-muted">
          <ImageOff size={22} />
        </div>
      )}
    </div>
  );
}

function LocalEntryCard({
  entry,
  busy,
  disabled,
  onUpload,
}: {
  readonly entry: FolderLibraryEntry;
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly onUpload: (entry: FolderLibraryEntry) => void;
}) {
  return (
    <div className="group relative overflow-hidden rounded-2xl border border-line bg-surface">
      <div className="relative aspect-square overflow-hidden bg-elevated">
        <LocalPreview entry={entry} />

        {isVideo(entry.file) ? (
          <span className="pointer-events-none absolute bottom-2 left-2 flex h-6 w-6 items-center justify-center rounded-full bg-black/60 text-white backdrop-blur-sm">
            <Play size={11} fill="currentColor" />
          </span>
        ) : null}

        {entry.synced ? (
          <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-full bg-emerald-600/90 px-2 py-1 text-[10px] font-medium text-white shadow-sm backdrop-blur-sm">
            <CheckCircle2 size={12} /> Synced
          </span>
        ) : (
          <button
            type="button"
            onClick={() => onUpload(entry)}
            disabled={disabled || busy}
            aria-label={`Upload ${entry.path}`}
            title="Upload this file"
            className="absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-full bg-black/60 text-white shadow-sm backdrop-blur-sm transition hover:bg-accent hover:text-accent-ink disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? <Spinner size={14} /> : <CloudUpload size={16} />}
          </button>
        )}
      </div>

      <div className="p-2.5">
        <p className="truncate text-[11px] font-medium text-ink" title={entry.path}>
          {entry.path}
        </p>
        <p className="mt-0.5 text-[10px] text-muted">{formatBytes(entry.file.size)}</p>
      </div>
    </div>
  );
}

export function FolderBrowserModal({ open, onClose, folderSync }: FolderBrowserModalProps) {
  const [entries, setEntries] = useState<FolderLibraryEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);

  const { folderName, listLocalFiles, uploadLocalFiles } = folderSync;

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const next = await listLocalFiles();
      setEntries([...next]);
    } catch (caught) {
      setEntries([]);
      setError(describeError(caught));
    } finally {
      setLoading(false);
    }
  }, [listLocalFiles]);

  useEffect(() => {
    if (!open) return;
    setEntries(null);
    setError(null);
    void refresh();
  }, [open, refresh]);

  const upload = useCallback(
    async (targets: readonly FolderLibraryEntry[]): Promise<void> => {
      const pending = targets.filter((entry) => !entry.synced);
      if (pending.length === 0 || uploading !== null) return;

      setError(null);
      setUploading(pending.length === 1 ? (pending[0]?.path ?? 'file') : 'all');
      try {
        const result = await uploadLocalFiles(pending);
        if (result.failed > 0) {
          setError(
            `${result.failed} file${result.failed === 1 ? '' : 's'} could not be uploaded: ${result.failures[0] ?? 'Unknown error'}`,
          );
        }
        await refresh();
      } catch (caught) {
        setError(describeError(caught));
      } finally {
        setUploading(null);
      }
    },
    [refresh, uploadLocalFiles, uploading],
  );

  const synced = entries?.filter((entry) => entry.synced).length ?? 0;
  const unsynced = entries?.filter((entry) => !entry.synced) ?? [];
  const busy = uploading !== null;
  const disabled = busy || folderSync.syncing;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={folderName ?? 'Local folder'}
      description="Files on this device. Synced items are already in your vault; upload any unsynced item you want."
      size="lg"
      footer={
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-[11px] text-muted">
            {entries ? `${synced} synced · ${unsynced.length} not synced` : 'Scanning folder…'}
          </p>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void refresh()}
              disabled={loading || busy}
              leadingIcon={<RefreshCw size={14} />}
            >
              Rescan
            </Button>
            <Button
              size="sm"
              onClick={() => void upload(unsynced)}
              disabled={disabled || unsynced.length === 0}
              leadingIcon={busy ? <Spinner size={14} /> : <CloudUpload size={14} />}
            >
              Upload all ({unsynced.length})
            </Button>
          </div>
        </div>
      }
    >
      {!folderName ? (
        <div className="flex flex-col items-center gap-4 py-12 text-center">
          <FolderOpen size={32} className="text-muted" />
          <p className="max-w-sm text-sm text-muted">
            Connect a folder in Settings first, then come back here to choose files manually.
          </p>
        </div>
      ) : loading && entries === null ? (
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted">
          <Spinner size={16} /> Scanning {folderName}…
        </div>
      ) : error && entries?.length === 0 ? (
        <div className="flex flex-col items-center gap-4 py-12 text-center">
          <p className="max-w-sm text-sm text-danger">{error}</p>
          <Button size="sm" onClick={() => void folderSync.chooseFolder()}>
            Reconnect folder
          </Button>
        </div>
      ) : entries && entries.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-12 text-center">
          <FolderOpen size={32} className="text-muted" />
          <p className="text-sm text-muted">No photos or videos found in this folder.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {folderSync.syncing ? (
            <p className="rounded-xl bg-surface/60 p-3 text-[11px] leading-relaxed text-muted">
              A folder sync is running. Manual uploads will be available when it finishes.
            </p>
          ) : folderSync.autoSync ? null : (
            <p className="rounded-xl bg-surface/60 p-3 text-[11px] leading-relaxed text-muted">
              Automatic sync is off. Only the files you upload here will be sent to your vault.
            </p>
          )}

          {error ? (
            <p className="rounded-xl bg-danger/10 p-3 text-[11px] leading-relaxed text-danger">
              {error}
            </p>
          ) : null}

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {entries?.map((entry) => (
              <LocalEntryCard
                key={entry.path}
                entry={entry}
                busy={busy && (uploading === 'all' || uploading === entry.path)}
                disabled={disabled}
                onUpload={(target) => void upload([target])}
              />
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
}
