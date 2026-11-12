import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Download,
  File as FileIcon,
  ImageOff,
  Lock,
  Maximize2,
  Trash2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type { MediaItem } from '../types/media';
import { formatBytes, formatDuration, formatFullDate } from '../lib/format';
import { useFullMedia } from '../hooks/useFullMedia';
import { useThumbnail } from '../hooks/useThumbnail';
import { Spinner } from './ui/Spinner';

export interface LightboxProps {
  readonly items: readonly MediaItem[];
  readonly index: number;
  readonly onIndexChange: (index: number) => void;
  readonly onClose: () => void;
  readonly onDelete: (item: MediaItem) => Promise<void>;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const safeFileName = (name: string): string => name.replace(/[\\/:*?"<>|]+/g, '-');

const MAX_SCALE = 4;
const SWIPE_THRESHOLD = 70;

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
  moved: boolean;
}

export function Lightbox({ items, index, onIndexChange, onClose, onDelete }: LightboxProps) {
  const item = items[index] ?? null;
  const media = useFullMedia(item, item !== null);
  const placeholder = useThumbnail(item, item !== null && media.loading);

  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [swipeX, setSwipeX] = useState(0);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stageRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  const hasPrev = index > 0;
  const hasNext = index < items.length - 1;

  const goPrev = useCallback(() => {
    if (index > 0) onIndexChange(index - 1);
  }, [index, onIndexChange]);

  const goNext = useCallback(() => {
    if (index < items.length - 1) onIndexChange(index + 1);
  }, [index, items.length, onIndexChange]);

  useEffect(() => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
    setSwipeX(0);
    setDeleteArmed(false);
    setDeleting(false);
    setError(null);
  }, [item?.id]);

  useEffect(() => {
    closeRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        if (scale > 1) {
          setScale(1);
          setOffset({ x: 0, y: 0 });
        } else {
          onClose();
        }
        return;
      }
      if (scale > 1) return;
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        goPrev();
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        goNext();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [goNext, goPrev, onClose, scale]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (event: WheelEvent): void => {
      if (!item || item.kind !== 'photo') return;
      event.preventDefault();
      setScale((current) => {
        const next = clamp(current * (event.deltaY < 0 ? 1.12 : 0.9), 1, MAX_SCALE);
        if (next === 1) setOffset({ x: 0, y: 0 });
        return next;
      });
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, [item]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!item || item.kind === 'video') return;
    if (event.button !== 0) return;
    // Never capture pointers that belong to controls overlaying the stage.
    if (event.target instanceof Element && event.target.closest('button, video, a, input')) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: offset.x,
      originY: offset.y,
      moved: false,
    };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) drag.moved = true;
    if (scale > 1) {
      setOffset({ x: drag.originX + dx, y: drag.originY + dy });
    } else {
      setSwipeX(dx);
    }
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    if (event.currentTarget.hasPointerCapture(drag.pointerId)) {
      event.currentTarget.releasePointerCapture(drag.pointerId);
    }
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    setSwipeX(0);
    if (scale > 1) return;
    if (Math.abs(dx) > SWIPE_THRESHOLD && Math.abs(dx) > Math.abs(dy) * 1.4) {
      if (dx < 0) goNext();
      else goPrev();
    }
  };

  const download = (): void => {
    if (!item || !media.url) return;
    const anchor = document.createElement('a');
    anchor.href = media.url;
    anchor.download = safeFileName(item.fileName);
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  };

  const confirmDelete = async (): Promise<void> => {
    if (!item) return;
    setDeleting(true);
    setError(null);
    try {
      await onDelete(item);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not delete this item.');
      setDeleting(false);
      setDeleteArmed(false);
    }
  };

  if (!item) return null;

  const zoomed = scale > 1;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${item.kind === 'video' ? 'Video' : item.kind === 'file' ? 'File' : 'Photo'} viewer: ${item.fileName}`}
      className="fixed inset-0 z-[60] flex flex-col bg-[#0b0c0f] text-white"
    >
      <header className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start justify-between gap-3 bg-gradient-to-b from-black/80 to-transparent p-3 sm:p-4">
        <div className="pointer-events-auto min-w-0">
          <p className="truncate text-sm font-medium">{item.fileName}</p>
          <p className="mt-0.5 truncate text-[11px] text-white/60">
            {formatFullDate(item.takenAt)} · {item.channelTitle}
          </p>
        </div>
        <div className="pointer-events-auto flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={download}
            disabled={!media.url}
            aria-label="Download original"
            title="Download original"
            className="flex h-10 w-10 items-center justify-center rounded-full text-white/90 hover:bg-white/10 disabled:opacity-40"
          >
            <Download size={19} />
          </button>
          <button
            type="button"
            onClick={() => setDeleteArmed(true)}
            aria-label="Delete from channel"
            title="Delete from channel"
            className="flex h-10 w-10 items-center justify-center rounded-full text-white/90 hover:bg-white/10"
          >
            <Trash2 size={19} />
          </button>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close viewer"
            className="flex h-10 w-10 items-center justify-center rounded-full text-white/90 hover:bg-white/10"
          >
            <X size={21} />
          </button>
        </div>
      </header>

      <div
        ref={stageRef}
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden px-2 pb-24 pt-16 sm:px-16"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={() => {
          if (item.kind !== 'photo') return;
          setScale((current) => (current > 1 ? 1 : 2.2));
          setOffset({ x: 0, y: 0 });
        }}
      >
        {media.loading ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            {placeholder.url ? (
              <img
                src={placeholder.url}
                alt=""
                aria-hidden="true"
                className="absolute inset-0 h-full w-full scale-105 object-contain opacity-40 blur-2xl"
              />
            ) : null}
            <div className="relative flex flex-col items-center gap-3 rounded-2xl bg-black/40 px-5 py-4 backdrop-blur">
              <Spinner size={22} />
              <p className="text-xs text-white/70">
                {item.source === 'vault' ? 'Downloading & decrypting…' : 'Downloading original…'}
                {media.progress > 0 ? ` ${Math.round(media.progress * 100)}%` : ''}
              </p>
            </div>
          </div>
        ) : null}

        {media.error ? (
          <div className="flex max-w-sm flex-col items-center gap-3 rounded-2xl bg-white/5 p-6 text-center">
            <ImageOff size={26} className="text-white/60" />
            <p className="text-sm text-white/80">{media.error}</p>
          </div>
        ) : null}

        {media.url && item.kind === 'video' ? (
          <video
            key={media.url}
            src={media.url}
            controls
            autoPlay
            playsInline
            className="max-h-full max-w-full rounded-lg bg-black shadow-2xl"
          />
        ) : null}

        {media.url && item.kind === 'file' ? (
          <div className="flex w-full max-w-lg flex-col items-center gap-4 rounded-3xl border border-white/10 bg-white/5 p-6 text-center sm:p-8">
            <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-white/10 text-white">
              <FileIcon size={28} />
            </span>
            <div className="min-w-0 max-w-full">
              <p className="truncate text-sm font-medium">{item.fileName}</p>
              <p className="mt-1 truncate text-xs text-white/50">
                {item.mimeType || 'application/octet-stream'} · {formatBytes(item.size)}
              </p>
            </div>

            {item.mimeType.startsWith('audio/') ? (
              <audio controls src={media.url} className="w-full" />
            ) : null}

            {item.mimeType === 'application/pdf' ? (
              <iframe
                src={media.url}
                title={item.fileName}
                className="h-64 w-full rounded-xl bg-white sm:h-80"
              />
            ) : null}

            <a
              href={media.url}
              download={safeFileName(item.fileName)}
              className="mt-1 inline-flex items-center gap-2 rounded-full bg-white px-5 py-2.5 text-sm font-medium text-[#0b0c0f] transition-colors hover:bg-white/90"
            >
              <Download size={16} /> Download file
            </a>
            <p className="text-[11px] text-white/40">
              Saved in Telegram as a file{item.source === 'vault' ? ', encrypted' : ''}.
            </p>
          </div>
        ) : null}

        {media.url && item.kind === 'photo' ? (
          <div
            className="flex h-full w-full items-center justify-center"
            style={{ transform: `translateX(${zoomed ? 0 : swipeX}px)` }}
          >
            <img
              src={media.url}
              alt={item.fileName}
              draggable={false}
              className="max-h-full max-w-full select-none object-contain shadow-2xl"
              style={{
                transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
                transition: dragRef.current ? 'none' : 'transform 180ms ease-out',
                cursor: zoomed ? 'grab' : 'zoom-in',
              }}
            />
          </div>
        ) : null}

        {hasPrev ? (
          <button
            type="button"
            onClick={goPrev}
            aria-label="Previous"
            className="absolute left-2 top-1/2 hidden h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-white backdrop-blur transition-colors hover:bg-white/20 sm:flex"
          >
            <ChevronLeft size={22} />
          </button>
        ) : null}
        {hasNext ? (
          <button
            type="button"
            onClick={goNext}
            aria-label="Next"
            className="absolute right-2 top-1/2 hidden h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-white backdrop-blur transition-colors hover:bg-white/20 sm:flex"
          >
            <ChevronRight size={22} />
          </button>
        ) : null}
      </div>

      <footer className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex flex-col gap-3 bg-gradient-to-t from-black/85 to-transparent p-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="pointer-events-auto">
          <p className="text-sm font-medium text-white/90">
            {formatFullDate(item.takenAt)}
          </p>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-white/55">
            {item.width > 0 && item.height > 0 ? (
              <span>
                {item.width} × {item.height}
              </span>
            ) : null}
            <span>·</span>
            <span>{formatBytes(item.size)}</span>
            {item.duration ? (
              <>
                <span>·</span>
                <span>{formatDuration(item.duration)}</span>
              </>
            ) : null}
            <span>·</span>
            <span className="inline-flex items-center gap-1">
              {item.source === 'vault' ? <Lock size={10} /> : null}
              {item.source === 'vault' ? 'Encrypted in Telegram' : 'Direct from channel'}
            </span>
          </p>
          {item.caption ? (
            <p className="mt-2 max-w-md text-xs leading-relaxed text-white/70">{item.caption}</p>
          ) : null}
        </div>

        <div className="pointer-events-auto flex items-center gap-2 self-start sm:self-auto">
          {item.kind === 'photo' ? (
            <>
              <button
                type="button"
                onClick={() => {
                  setScale((current) => clamp(current - 0.5, 1, MAX_SCALE));
                  if (scale - 0.5 <= 1) setOffset({ x: 0, y: 0 });
                }}
                aria-label="Zoom out"
                className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 hover:bg-white/20"
              >
                <ZoomOut size={16} />
              </button>
              <button
                type="button"
                onClick={() => setScale((current) => clamp(current + 0.5, 1, MAX_SCALE))}
                aria-label="Zoom in"
                className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 hover:bg-white/20"
              >
                <ZoomIn size={16} />
              </button>
              <button
                type="button"
                onClick={() => {
                  setScale(1);
                  setOffset({ x: 0, y: 0 });
                }}
                aria-label="Reset zoom"
                className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 hover:bg-white/20"
              >
                <Maximize2 size={16} />
              </button>
            </>
          ) : null}
          <span className="ml-1 rounded-full bg-white/10 px-3 py-1.5 text-xs tabular-nums text-white/70">
            {index + 1} / {items.length}
          </span>
        </div>
      </footer>

      {deleteArmed ? (
        <div className="absolute inset-x-0 bottom-24 z-30 mx-auto w-[calc(100%-2rem)] max-w-sm rounded-2xl border border-white/15 bg-[#17181c] p-4 shadow-2xl">
          <p className="text-sm font-medium">Delete from the channel?</p>
          <p className="mt-1 text-xs leading-relaxed text-white/60">
            This removes the message for everyone in the channel. {item.thumbMessageId ? 'The encrypted preview is removed too. ' : ''}
            It cannot be undone.
          </p>
          {error ? <p className="mt-2 text-xs text-red-400">{error}</p> : null}
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setDeleteArmed(false)}
              className="rounded-full px-3.5 py-2 text-sm text-white/70 hover:bg-white/10"
              disabled={deleting}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void confirmDelete()}
              disabled={deleting}
              className="flex items-center gap-2 rounded-full bg-red-500 px-3.5 py-2 text-sm font-medium text-white hover:bg-red-400 disabled:opacity-60"
            >
              {deleting ? <Spinner size={14} /> : <Trash2 size={14} />}
              Delete
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
