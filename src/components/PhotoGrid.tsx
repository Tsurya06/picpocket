import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { Check, File, FileArchive, FileText, ImageOff, Lock, Play } from 'lucide-react';
import type { MediaItem, MonthGroup } from '../types/media';
import { formatBytes, formatDuration } from '../lib/format';
import { prefetchThumbnail, useThumbnail } from '../hooks/useThumbnail';
import { SkeletonGrid } from './ui/Spinner';

export interface PhotoGridProps {
  readonly groups: readonly MonthGroup[];
  readonly loading: boolean;
  readonly loadingMore: boolean;
  readonly hasMore: boolean;
  readonly onLoadMore: () => void;
  readonly onOpen: (item: MediaItem) => void;
  readonly emptyState: ReactNode;
  readonly selectedIds: ReadonlySet<string>;
  readonly onLongPress: (item: MediaItem) => void;
  readonly onToggleSelect: (item: MediaItem) => void;
}

const MIN_TILE = 148;
const GAP = 4;
const MONTH_ROW = 56;
const DAY_ROW = 34;
/** Rows kept mounted just outside the viewport so fast scrolling is smooth. */
const OVERSCAN_ROWS = 3;
/** Extra rows whose previews are warmed above and below the mounted window. */
const PREFETCH_ROWS = 4;

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

const LONG_PRESS_MS = 450;

function MediaTile({
  item,
  onOpen,
  fill,
  selected,
  selecting,
  onLongPress,
  onToggleSelect,
}: {
  item: MediaItem;
  onOpen: (item: MediaItem) => void;
  fill: boolean;
  selected: boolean;
  selecting: boolean;
  onLongPress: (item: MediaItem) => void;
  onToggleSelect: (item: MediaItem) => void;
}) {
  // Rows only exist when they are visible or inside the small virtual buffer,
  // so every mounted tile can load its preview without a per-tile observer.
  const { url, loading, failed } = useThumbnail(item);
  const sizing = fill ? 'h-full w-full' : 'w-full';

  const timerRef = useRef<number | null>(null);
  const originRef = useRef<{ x: number; y: number } | null>(null);
  const suppressClickRef = useRef(false);

  const clearTimer = (): void => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  useEffect(() => clearTimer, []);

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    suppressClickRef.current = false;
    originRef.current = { x: event.clientX, y: event.clientY };
    clearTimer();
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      // The click that follows a long press must not open the viewer. It is
      // cleared on the next pointerdown in case no click ever arrives.
      suppressClickRef.current = true;
      onLongPress(item);
    }, LONG_PRESS_MS);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const origin = originRef.current;
    if (!origin) return;
    if (Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 10) clearTimer();
  };

  const endPress = (): void => {
    clearTimer();
    originRef.current = null;
  };

  const onClick = (): void => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    if (selecting) onToggleSelect(item);
    else onOpen(item);
  };

  const onContextMenu = (event: ReactMouseEvent<HTMLButtonElement>): void => {
    // Android fires a context menu on long press; keep our gesture instead.
    event.preventDefault();
  };

  const interactions = {
    onPointerDown,
    onPointerMove,
    onPointerUp: endPress,
    onPointerCancel: endPress,
    onPointerLeave: endPress,
    onClick,
    onContextMenu,
    'aria-pressed': selected,
  } as const;

  const selectionOverlay = selected ? (
    <>
      <span className="pointer-events-none absolute inset-0 z-10 rounded-[var(--radius-tile)] ring-2 ring-inset ring-accent" />
      <span className="pointer-events-none absolute left-1.5 top-1.5 z-10 flex h-6 w-6 items-center justify-center rounded-full bg-accent text-accent-ink shadow">
        <Check size={14} strokeWidth={3} />
      </span>
    </>
  ) : null;

  if (item.kind === 'file') {
    const FileIcon = fileIconFor(item);
    return (
      <button
        type="button"
        {...interactions}
        className={`tile-in group relative block overflow-hidden rounded-[var(--radius-tile)] border border-line bg-elevated text-left focus-visible:outline-offset-4 ${sizing}`}
        aria-label={`File ${item.fileName}`}
      >
        {selectionOverlay}
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
      type="button"
      {...interactions}
      className={`tile-in group relative block overflow-hidden rounded-[var(--radius-tile)] bg-surface text-left focus-visible:outline-offset-4 ${sizing}`}
      aria-label={`${item.kind === 'video' ? 'Video' : 'Photo'} ${item.fileName}`}
    >
      {selectionOverlay}
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
  selectedIds,
  onLongPress,
  onToggleSelect,
}: PhotoGridProps) {
  const selecting = selectedIds.size > 0;
  const listRef = useRef<HTMLDivElement | null>(null);
  const loadMoreRef = useRef(onLoadMore);
  useEffect(() => {
    loadMoreRef.current = onLoadMore;
  }, [onLoadMore]);
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

  // The list sits below a header whose height can change as banners and
  // counts arrive. Remeasure after layout so scrollMargin tracks it exactly.
  useLayoutEffect(() => {
    const element = listRef.current;
    if (!element) return;
    const next = element.getBoundingClientRect().top + window.scrollY;
    setOffsetTop((current) => (Math.abs(current - next) > 0.5 ? next : current));
  });

  const columns = Math.max(2, Math.min(8, Math.floor((width + GAP) / (MIN_TILE + GAP)) || 2));
  const tileSize = width > 0 ? (width - GAP * (columns - 1)) / columns : MIN_TILE;
  const rows = useMemo(() => buildRows(groups, columns), [groups, columns]);

  const sizeOf = (row: GridRow | undefined): number => {
    if (!row) return tileSize + GAP;
    if (row.kind === 'month') return MONTH_ROW;
    if (row.kind === 'day') return DAY_ROW;
    return tileSize + GAP;
  };

  const virtualizer = useWindowVirtualizer({
    count: rows.length,
    estimateSize: (index) => sizeOf(rows[index]),
    overscan: OVERSCAN_ROWS,
    scrollMargin: offsetTop,
    getItemKey: (index) => rows[index]?.key ?? index,
  });

  useEffect(() => {
    virtualizer.measure();
  }, [columns, tileSize, virtualizer]);

  const virtualRows = virtualizer.getVirtualItems();
  const firstVirtualIndex = virtualRows[0]?.index ?? 0;
  const lastVirtualIndex = virtualRows[virtualRows.length - 1]?.index ?? -1;
  const prefetchFrom = Math.max(0, firstVirtualIndex - PREFETCH_ROWS);
  const prefetchTo = Math.min(rows.length - 1, lastVirtualIndex + PREFETCH_ROWS);

  // Warm previews in both directions. The shared thumbnail cache keeps the
  // bytes and object URL, so a row remounting after fast scrolling paints at
  // once instead of falling back to a skeleton.
  useEffect(() => {
    for (let index = prefetchFrom; index <= prefetchTo; index += 1) {
      const row = rows[index];
      if (row?.kind !== 'items') continue;
      for (const item of row.items) prefetchThumbnail(item);
    }
  }, [prefetchFrom, prefetchTo, rows]);

  // Page the next batch in before the final mounted row is visible. The
  // timeline's own busy guard ignores calls while a page is already in flight,
  // and a failed load can be retried on the next scroll.
  useEffect(() => {
    if (!hasMore || loadingMore || lastVirtualIndex < 0) return;
    if (lastVirtualIndex < rows.length - 1 - PREFETCH_ROWS) return;
    loadMoreRef.current();
  }, [hasMore, lastVirtualIndex, loadingMore, rows.length]);

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
                      <MediaTile
                        key={item.id}
                        item={item}
                        onOpen={onOpen}
                        fill
                        selected={selectedIds.has(item.id)}
                        selecting={selecting}
                        onLongPress={onLongPress}
                        onToggleSelect={onToggleSelect}
                      />
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>

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
