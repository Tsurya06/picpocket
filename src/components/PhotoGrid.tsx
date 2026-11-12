import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
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

const MIN_TILE = 148;
const GAP = 4;
const MONTH_ROW = 56;
const DAY_ROW = 34;

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

function MediaTile({
  item,
  onOpen,
  fill,
}: {
  item: MediaItem;
  onOpen: (item: MediaItem) => void;
  fill: boolean;
}) {
  const [tileRef, nearViewport] = useNearViewport<HTMLButtonElement>();
  const { url, loading, failed } = useThumbnail(item, nearViewport);
  const sizing = fill ? 'h-full w-full' : 'w-full';

  if (item.kind === 'file') {
    const FileIcon = fileIconFor(item);
    return (
      <button
        ref={tileRef}
        type="button"
        onClick={() => onOpen(item)}
        className={`tile-in group relative block overflow-hidden rounded-[var(--radius-tile)] border border-line bg-elevated text-left focus-visible:outline-offset-4 ${sizing}`}
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
      className={`tile-in group relative block overflow-hidden rounded-[var(--radius-tile)] bg-surface text-left focus-visible:outline-offset-4 ${sizing}`}
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
        <div
          className={`absolute inset-0 ${loading ? 'shimmer' : 'flex items-center justify-center bg-surface'}`}
        >
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

type GridRow =
  | { readonly kind: 'month'; readonly key: string; readonly label: string; readonly count: number }
  | { readonly kind: 'day'; readonly key: string; readonly label: string }
  | { readonly kind: 'items'; readonly key: string; readonly items: readonly MediaItem[] };

/**
 * Flattens the grouped timeline into virtual rows: one per month header, one
 * per day header, and fixed-width media rows. Only the rows intersecting the
 * viewport are mounted, so DOM size stays constant whether the channel holds
 * 50 photos or 50 000.
 */
const buildRows = (groups: readonly MonthGroup[], columns: number): GridRow[] => {
  const rows: GridRow[] = [];
  for (const month of groups) {
    rows.push({
      kind: 'month',
      key: `month:${month.key}`,
      label: month.label,
      count: month.count,
    });
    for (const day of month.days) {
      rows.push({ kind: 'day', key: `day:${day.key}`, label: day.label });
      for (let index = 0; index < day.items.length; index += columns) {
        rows.push({
          kind: 'items',
          key: `row:${day.key}:${index}`,
          items: day.items.slice(index, index + columns),
        });
      }
    }
  }
  return rows;
};

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
  const listRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [offsetTop, setOffsetTop] = useState(0);

  // Column count follows the container width so tiles keep a usable size.
  useEffect(() => {
    const element = listRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    setWidth(element.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const element = listRef.current;
    if (!element) return;
    const measure = (): void => {
      setOffsetTop(element.getBoundingClientRect().top + window.scrollY);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [groups, width]);

  const columns = Math.max(2, Math.min(8, Math.floor((width + GAP) / (MIN_TILE + GAP)) || 2));
  const tileSize = width > 0 ? (width - GAP * (columns - 1)) / columns : MIN_TILE;
  const rows = buildRows(groups, columns);

  const sizeOf = (row: GridRow | undefined): number => {
    if (!row) return tileSize + GAP;
    if (row.kind === 'month') return MONTH_ROW;
    if (row.kind === 'day') return DAY_ROW;
    return tileSize + GAP;
  };

  const virtualizer = useWindowVirtualizer({
    count: rows.length,
    estimateSize: (index) => sizeOf(rows[index]),
    overscan: 6,
    scrollMargin: offsetTop,
    getItemKey: (index) => rows[index]?.key ?? index,
  });

  useEffect(() => {
    virtualizer.measure();
  }, [columns, tileSize, virtualizer]);

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

  const virtualRows = virtualizer.getVirtualItems();

  return (
    <div className="px-3 pb-24 sm:px-6">
      <div className="mx-auto max-w-[1800px]">
        <div
          ref={listRef}
          className="relative w-full"
          style={{ height: virtualizer.getTotalSize() }}
        >
          {virtualRows.map((virtualRow) => {
            const row = rows[virtualRow.index];
            if (!row) return null;
            return (
              <div
                key={virtualRow.key}
                className="absolute inset-x-0 top-0"
                style={{
                  height: virtualRow.size,
                  transform: `translateY(${virtualRow.start - offsetTop}px)`,
                }}
              >
                {row.kind === 'month' ? (
                  <h2 className="flex h-full items-baseline gap-3 pt-5 text-[17px] font-semibold tracking-tight text-ink">
                    {row.label}
                    <span className="text-xs font-normal text-muted">
                      {row.count} {row.count === 1 ? 'item' : 'items'}
                    </span>
                  </h2>
                ) : null}

                {row.kind === 'day' ? (
                  <h3 className="flex h-full items-center text-xs font-semibold uppercase tracking-wide text-muted">
                    {row.label}
                  </h3>
                ) : null}

                {row.kind === 'items' ? (
                  <div
                    className="grid h-full"
                    style={{
                      gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                      gap: GAP,
                      height: tileSize,
                    }}
                  >
                    {row.items.map((item) => (
                      <MediaTile key={item.id} item={item} onOpen={onOpen} fill />
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>

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
