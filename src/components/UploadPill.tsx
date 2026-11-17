import { useEffect, useState } from 'react';
import { AlertTriangle, Check, ChevronDown, Lock, Upload, X } from 'lucide-react';
import type { UploadProgress, UploadResult } from '../types/media';
import { Spinner } from './ui/Spinner';

export interface UploadPillProps {
  readonly progress: UploadProgress;
  readonly result: UploadResult | null;
  readonly encrypted: boolean;
  readonly onCancel: () => void;
  readonly onSkip: (index: number) => void;
  readonly onDismiss: () => void;
}

const AUTO_DISMISS_MS = 8000;

export function UploadPill({
  progress,
  result,
  encrypted,
  onCancel,
  onSkip,
  onDismiss,
}: UploadPillProps) {
  const [hovered, setHovered] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const finished = result !== null;
  const failed = result ? result.failed.length : progress.failed;
  const cancelled = result?.cancelled ?? progress.skipped.length;
  const overall = finished
    ? 1
    : Math.min(1, (progress.completed + progress.currentFraction) / Math.max(1, progress.total));
  const showQueue = hovered || expanded;

  // Stay visible while the user is inspecting it; once they leave (or never
  // interact), a finished toast dismisses itself after 8 seconds.
  useEffect(() => {
    if (!finished || hovered || expanded) return;
    const timer = window.setTimeout(onDismiss, AUTO_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [expanded, finished, hovered, onDismiss]);

  return (
    <div
      role="status"
      aria-live="polite"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
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
                : `${result.uploaded} ${result.uploaded === 1 ? 'item' : 'items'} uploaded${
                    cancelled > 0 ? ` · ${cancelled} skipped` : ''
                  }`
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

      {showQueue && progress.queue.length > 0 ? (
        <div className="max-h-48 overflow-y-auto border-t border-line/70 px-2 py-1.5">
          {progress.queue.map((entry) => {
            const skipped = progress.skipped.includes(entry.index);
            const current = !finished && entry.index === progress.currentIndex;
            const done = entry.index < progress.currentIndex;
            const canSkip = !finished && !skipped && entry.index > progress.currentIndex;
            return (
              <div
                key={entry.index}
                className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-[11px] ${
                  current ? 'bg-accent-soft/70 text-ink' : 'text-muted'
                }`}
              >
                <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                  {skipped ? (
                    <X size={12} className="text-muted" />
                  ) : current ? (
                    <Spinner size={12} />
                  ) : done ? (
                    <Check size={12} className="text-emerald-500" />
                  ) : (
                    <span className="h-1 w-1 rounded-full bg-current" />
                  )}
                </span>
                <span
                  className={`min-w-0 flex-1 truncate ${skipped ? 'line-through opacity-60' : ''}`}
                  title={entry.name}
                >
                  {entry.name}
                </span>
                {skipped ? (
                  <span className="shrink-0 text-[10px] uppercase tracking-wide">Skipped</span>
                ) : canSkip ? (
                  <button
                    type="button"
                    onClick={() => onSkip(entry.index)}
                    aria-label={`Skip ${entry.name}`}
                    title="Skip this file"
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full hover:bg-surface"
                  >
                    <X size={12} />
                  </button>
                ) : current ? (
                  <span className="shrink-0 text-[10px] uppercase tracking-wide text-accent">
                    Current
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-2 px-4 py-1.5 text-[10px] text-muted">
        <span className="flex min-w-0 items-center gap-1">
          {encrypted ? <Lock size={10} /> : <Upload size={10} />}
          <span className="truncate">
            {encrypted ? 'Encrypted before upload' : 'Uploaded without encryption'}
          </span>
        </span>
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 hover:bg-surface hover:text-ink"
          aria-expanded={expanded}
          title={showQueue ? 'Hide queue' : 'Show queue'}
        >
          <span className="tabular-nums">
            {progress.completed}/{progress.total} files
          </span>
          <ChevronDown
            size={11}
            className={`transition-transform ${showQueue ? 'rotate-180' : ''}`}
          />
        </button>
      </div>
    </div>
  );
}
