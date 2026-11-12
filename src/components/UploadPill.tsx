import { AlertTriangle, Check, Lock, Upload, X } from 'lucide-react';
import type { UploadProgress, UploadResult } from '../types/media';
import { Spinner } from './ui/Spinner';

export interface UploadPillProps {
  readonly progress: UploadProgress;
  readonly result: UploadResult | null;
  readonly encrypted: boolean;
  readonly onCancel: () => void;
  readonly onDismiss: () => void;
}

export function UploadPill({ progress, result, encrypted, onCancel, onDismiss }: UploadPillProps) {
  const finished = result !== null;
  const failed = result ? result.failed.length : progress.failed;
  const overall = finished
    ? 1
    : Math.min(1, (progress.completed + progress.currentFraction) / Math.max(1, progress.total));

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-5 right-4 z-40 w-[calc(100vw-2rem)] max-w-[340px] overflow-hidden rounded-2xl border border-line bg-elevated shadow-2xl sm:right-6"
    >
      <div className="flex items-center gap-3 px-4 py-3">
        <span
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
            finished && failed > 0
              ? 'bg-danger/10 text-danger'
              : finished
                ? 'bg-emerald-500/10 text-emerald-500'
                : 'bg-accent-soft text-accent'
          }`}
        >
          {finished ? (
            failed > 0 ? (
              <AlertTriangle size={17} />
            ) : (
              <Check size={17} />
            )
          ) : (
            <Spinner size={17} />
          )}
        </span>

        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-ink">
            {finished
              ? failed > 0
                ? `${result.uploaded} uploaded · ${failed} failed`
                : `${result.uploaded} ${result.uploaded === 1 ? 'item' : 'items'} uploaded`
              : progress.processing
                ? `${encrypted ? 'Encrypting' : 'Preparing'} ${progress.currentName || 'file'}…`
                : `Uploading ${progress.completed + 1} of ${progress.total}`}
          </p>
          <p className="truncate text-[11px] text-muted">
            {finished ? (
              failed > 0 ? (
                result.failed[0]?.reason ?? 'Some files could not be uploaded.'
              ) : (
                'Saved to your Telegram channel'
              )
            ) : (
              <>
                {progress.processing
                  ? encrypted
                    ? 'Removing photo details on device'
                    : 'Reading file on device'
                  : progress.currentName}
                {' · '}
                {Math.round(overall * 100)}%
              </>
            )}
          </p>
        </div>

        <button
          type="button"
          onClick={finished ? onDismiss : onCancel}
          aria-label={finished ? 'Dismiss' : 'Cancel upload'}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted hover:bg-surface"
        >
          <X size={16} />
        </button>
      </div>

      <div className="h-1 w-full bg-surface">
        <div
          className={`h-full transition-[width] duration-300 ${
            finished && failed > 0 ? 'bg-danger' : finished ? 'bg-emerald-500' : 'bg-accent'
          }`}
          style={{ width: `${Math.round(overall * 100)}%` }}
        />
      </div>

      <div className="flex items-center justify-between px-4 py-1.5 text-[10px] text-muted">
        <span className="flex items-center gap-1">
          {encrypted ? <Lock size={10} /> : <Upload size={10} />}
          {encrypted ? 'Encrypted before upload' : 'Uploaded without encryption'}
        </span>
        <span className="tabular-nums">
          {progress.completed}/{progress.total} files
        </span>
      </div>
    </div>
  );
}
