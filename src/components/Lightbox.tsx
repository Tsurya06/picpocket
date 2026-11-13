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
import { prefetchFullMedia, useFullMedia } from '../hooks/useFullMedia';
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
  /** Started on a <video>: no capture, so the native controls keep working. */
  fromVideo: boolean;
}

export function Lightbox({ items, index, onIndexChange, onClose, onDelete }: LightboxProps) {
  const item = items[index] ?? null;
  const media = useFullMedia(item, item !== null);
  const placeholder = useThumbnail(item, item !== null && media.loading);

  // Keep the previous frame on screen while the next original downloads, so
  // swiping never flashes an empty black stage.
  const lastUrlRef = useRef<string | null>(null);
  useEffect(() => {
    if (media.url) lastUrlRef.current = media.url;
  }, [media.url]);
  const previousUrl = !media.url && media.loading ? lastUrlRef.current : null;

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

  // Warm the neighbours so the next swipe or arrow press is instant.
  useEffect(() => {
    prefetchFullMedia(items[index + 1]);
    prefetchFullMedia(items[index - 1]);
    prefetchFullMedia(items[index + 2]);
  }, [index, items]);

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

  // Close the viewer on the mobile back gesture / back button instead of
  // letting the browser minimise the installed app.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const pushedRef = useRef(false);
  const pendingBackRef = useRef<number | null>(null);

  useEffect(() => {
    // A remount (StrictMode) must not push a second entry or undo the first.
    if (pendingBackRef.current !== null) {
      window.clearTimeout(pendingBackRef.current);
      pendingBackRef.current = null;
    }

    let closedByHistory = false;
    if (!pushedRef.current) {
      window.history.pushState({ picpocketLightbox: true }, '');
      pushedRef.current = true;
    }

    const onPopState = (): void => {
      closedByHistory = true;
      pushedRef.current = false;
      onCloseRef.current();
    };
    window.addEventListener('popstate', onPopState);

    return () => {
      window.removeEventListener('popstate', onPopState);
      if (closedByHistory || !pushedRef.current) return;
      // Deferred so a StrictMode remount can cancel it before it navigates.
      pendingBackRef.current = window.setTimeout(() => {
        pendingBackRef.current = null;
        if (pushedRef.current && window.history.state?.picpocketLightbox) {
          pushedRef.current = false;
          window.history.back();
        }
      }, 80);
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
    if (!item) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    // Never capture pointers that belong to controls overlaying the stage.
    if (event.target instanceof Element && event.target.closest('button, a, input')) return;

    // Videos keep their own pointer stream so the native controls stay usable;
    // a sideways drag still bubbles up and becomes a swipe.
    const fromVideo =
      event.target instanceof Element && event.target.closest('video') !== null;
    if (!fromVideo) {
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Some browsers reject capture for synthetic or already-released pointers.
      }
    }

    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: offset.x,
      originY: offset.y,
      moved: false,
      fromVideo,
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
    } else if (!drag.fromVideo || Math.abs(dx) > 12) {
      setSwipeX(dx);
    }
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    try {
      if (event.currentTarget.hasPointerCapture(drag.pointerId)) {
        event.currentTarget.releasePointerCapture(drag.pointerId);
      }
    } catch {
      // Ignore: the pointer may already be gone.
    }
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    setSwipeX(0);
    if (scale > 1) return;
    if (Math.abs(dx) > SWIPE_THRESHOLD && Math.abs(dx) > Math.abs(dy) * 1.2) {
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
        // `touch-action: pan-y` keeps horizontal drags for the swipe gesture
        // instead of letting the browser scroll or run its own back gesture.
        style={{ touchAction: 'pan-y', overscrollBehaviorX: 'contain' }}
        className="relative flex min-h-0 flex-1 select-none items-center justify-center overflow-hidden px-2 pb-24 pt-16 sm:px-16"
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
        {media.loading && !previousUrl ? (
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

        {previousUrl && item.kind === 'photo' ? (
          <img
            src={previousUrl}
            alt=""
            aria-hidden="true"
            className="absolute inset-0 h-full w-full select-none object-contain opacity-35 transition-opacity duration-200"
          />
        ) : null}

        {previousUrl && item.kind === 'photo' ? (
          <div className="pointer-events-none absolute bottom-28 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full bg-black/60 px-3 py-1.5 text-[11px] text-white/70 backdrop-blur">
            <Spinner size={12} />
            Loading{media.progress > 0 ? ` ${Math.round(media.progress * 100)}%` : '…'}
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
            style={{ touchAction: 'pan-y' }}
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
            style={{
              transform: `translateX(${zoomed ? 0 : swipeX}px)`,
              touchAction: 'pan-y',
              transition: dragRef.current ? 'none' : 'transform 180ms ease-out',
            }}
          >
            <img
              key={item.id}
              src={media.url}
              alt={item.fileName}
              draggable={false}
              className="max-h-full max-w-full select-none object-contain shadow-2xl transition-opacity duration-200"
              style={{
                transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
                transition: dragRef.current ? 'none' : 'transform 180ms ease-out',
                cursor: zoomed ? 'grab' : 'zoom-in',
                touchAction: 'pan-y',
              }}
            />
          </div>
        ) : null}

        {hasPrev && !zoomed ? (
          <button
            type="button"
            onClick={goPrev}
            aria-label="Previous"
            className="absolute left-1 top-1/2 z-10 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur transition-colors hover:bg-white/20 sm:left-2 sm:h-11 sm:w-11"
          >
            <ChevronLeft size={20} />
          </button>
        ) : null}
        {hasNext && !zoomed ? (
          <button
            type="button"
            onClick={goNext}
            aria-label="Next"
            className="absolute right-1 top-1/2 z-10 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur transition-colors hover:bg-white/20 sm:right-2 sm:h-11 sm:w-11"
          >
            <ChevronRight size={20} />
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
