import { useEffect, useRef, type ReactNode } from 'react';
import { File, FileArchive, FileText, ImageOff, Lock, Play } from 'lucide-react';
import type { MediaItem, MonthGroup } from '../types/media';
import { formatBytes, formatDuration } from '../lib/format';
import { useThumbnail } from '../hooks/useThumbnail';
import { useNearViewport } from '../hooks/useNearViewport';
import { SkeletonGrid } from './ui/Spinner';

export interface PhotoGridProps {
  readonly groups: readonly MonthGroup[];
  readonly loading: boolean;
  readonly loadingMore: boolean;
  readonly hasMore: boolean;
  readonly onLoadMore: () => void;
  readonly onOpen: (item: MediaItem) => void;
  readonly emptyState: ReactNode;
}

const MIN_RATIO = 0.62;
const MAX_RATIO = 1.9;

const aspectRatioFor = (item: MediaItem): string => {
  if (item.kind === 'file') return '4 / 3';
  if (item.width <= 0 || item.height <= 0) return '1 / 1';
  const ratio = Math.min(MAX_RATIO, Math.max(MIN_RATIO, item.width / item.height));
  return `${ratio}`;
};

const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).slice(0, 5).toUpperCase() : 'FILE';
};

const fileIconFor = (item: MediaItem): typeof File => {
  const extension = extensionOf(item.fileName);
  if (['ZIP', 'RAR', '7Z', 'TAR', 'GZ', 'BZ2'].includes(extension)) return FileArchive;
  if (['PDF', 'TXT', 'MD', 'DOC', 'DOCX', 'CSV', 'JSON'].includes(extension)) return FileText;
  return File;
};

function MediaTile({ item, onOpen }: { item: MediaItem; onOpen: (item: MediaItem) => void }) {
  const [tileRef, nearViewport] = useNearViewport<HTMLButtonElement>();
  const { url, loading, failed } = useThumbnail(item, nearViewport);

  if (item.kind === 'file') {
    const FileIcon = fileIconFor(item);
    return (
      <button
        ref={tileRef}
        type="button"
        onClick={() => onOpen(item)}
        className="tile-in group relative block w-full overflow-hidden rounded-[var(--radius-tile)] border border-line bg-elevated text-left focus-visible:outline-offset-4"
        style={{ aspectRatio: aspectRatioFor(item) }}
        aria-label={`File ${item.fileName}`}
      >
        <span className="flex h-full w-full flex-col justify-between p-3">
          <span className="flex items-start justify-between gap-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-surface text-accent">
              <FileIcon size={17} />
            </span>
            <span className="rounded bg-surface px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-muted">
              {extensionOf(item.fileName)}
            </span>
          </span>
          <span className="block">
            <span className="line-clamp-1 block text-xs font-medium text-ink">{item.fileName}</span>
            <span className="mt-0.5 block text-[10px] text-muted">{formatBytes(item.size)}</span>
          </span>
        </span>
        {item.source === 'vault' ? (
          <span
            title="End-to-end encrypted"
            className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur-sm"
          >
            <Lock size={11} />
          </span>
        ) : null}
      </button>
    );
  }

  return (
    <button
      ref={tileRef}
      type="button"
      onClick={() => onOpen(item)}
      className="tile-in group relative block w-full overflow-hidden rounded-[var(--radius-tile)] bg-surface text-left focus-visible:outline-offset-4"
      style={{ aspectRatio: aspectRatioFor(item) }}
      aria-label={`${item.kind === 'video' ? 'Video' : 'Photo'} ${item.fileName}`}
    >
      {url ? (
        <img
          src={url}
          alt={item.fileName}
          loading="lazy"
          decoding="async"
          draggable={false}
          className="h-full w-full object-cover transition-transform duration-500 ease-out group-hover:scale-[1.03]"
        />
      ) : (
        <div className={`absolute inset-0 ${loading ? 'shimmer' : 'flex items-center justify-center bg-surface'}`}>
          {!loading ? <ImageOff size={22} className="text-muted/60" /> : null}
        </div>
      )}

      {failed && !url ? (
        <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/60 to-transparent px-2 pb-1.5 pt-6 text-[10px] text-white/80">
          Preview unavailable
        </span>
      ) : null}

      <span className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/25 via-transparent to-transparent opacity-0 transition-opacity group-hover:opacity-100" />

      {item.kind === 'video' ? (
        <span className="absolute bottom-1.5 left-1.5 flex items-center gap-1 rounded bg-black/60 px-1.5 py-0.5 text-[11px] font-medium text-white backdrop-blur-sm">
          <Play size={10} fill="currentColor" />
          {formatDuration(item.duration) || 'Video'}
        </span>
      ) : null}

      {item.source === 'vault' ? (
        <span
          title="End-to-end encrypted"
          className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur-sm"
        >
          <Lock size={11} />
        </span>
      ) : null}
    </button>
  );
}

export function PhotoGrid({
  groups,
  loading,
  loadingMore,
  hasMore,
  onLoadMore,
  onOpen,
  emptyState,
}: PhotoGridProps) {
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const target = sentinelRef.current;
    if (!target || !hasMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onLoadMore();
      },
      { rootMargin: '900px 0px' },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [hasMore, onLoadMore]);

  if (loading && groups.length === 0) {
    return (
      <div className="px-3 pb-24 sm:px-6">
        <div className="mx-auto max-w-[1800px]">
          <div className="mb-4 mt-6 h-7 w-40 rounded-md bg-surface/70" />
          <SkeletonGrid count={14} />
        </div>
      </div>
    );
  }

  if (groups.length === 0) {
    return <div className="px-3 pb-24 sm:px-6">{emptyState}</div>;
  }

  return (
    <div className="px-3 pb-24 sm:px-6">
      <div className="mx-auto max-w-[1800px]">
        {groups.map((month) => (
          <section key={month.key} aria-label={month.label}>
            <h2 className="sticky top-[56px] z-20 -mx-3 flex items-baseline gap-3 bg-app/95 px-3 pb-2 pt-5 text-[17px] font-semibold tracking-tight text-ink backdrop-blur-xl sm:-mx-6 sm:px-6">
              {month.label}
              <span className="text-xs font-normal text-muted">
                {month.count} {month.count === 1 ? 'item' : 'items'}
              </span>
            </h2>

            {month.days.map((day) => (
              <div key={day.key}>
                <h3 className="sticky top-[98px] z-10 -mx-3 bg-app/90 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted backdrop-blur-xl sm:-mx-6 sm:px-6">
                  {day.label}
                </h3>
                <div className="masonry">
                  {day.items.map((item) => (
                    <MediaTile key={item.id} item={item} onOpen={onOpen} />
                  ))}
                </div>
              </div>
            ))}
          </section>
        ))}

        <div ref={sentinelRef} className="h-10" />

        {loadingMore ? (
          <div className="flex items-center justify-center py-6">
            <div className="flex items-center gap-2 text-sm text-muted">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-line border-t-accent" />
              Loading more memories…
            </div>
          </div>
        ) : null}

        {!hasMore && !loadingMore ? (
          <p className="py-10 text-center text-xs text-muted">
            {groups.length > 0 ? 'You have reached the beginning of this channel.' : ''}
          </p>
        ) : null}
      </div>
    </div>
  );
}
