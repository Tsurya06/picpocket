import { FolderLock, Search, Upload, X } from 'lucide-react';
import type { ChannelSummary } from '../types/media';
import { Button } from './ui/Button';

export interface TopBarProps {
  readonly query: string;
  readonly onQueryChange: (value: string) => void;
  readonly selectedChannels: readonly ChannelSummary[];
  readonly onOpenChannels: () => void;
  readonly onOpenSettings: () => void;
  readonly onUpload: () => void;
  readonly uploadDisabled: boolean;
  readonly accountName: string;
  readonly syncing: boolean;
  readonly mode: 'photos' | 'whatsapp';
}

export function TopBar({
  query,
  onQueryChange,
  selectedChannels,
  onOpenChannels,
  onOpenSettings,
  onUpload,
  uploadDisabled,
  accountName,
  syncing,
  mode,
}: TopBarProps) {
  const initial = accountName.trim().charAt(0).toUpperCase() || 'V';
  const switcherLabel =
    selectedChannels.length === 1
      ? selectedChannels[0]?.title ?? 'Vault'
      : selectedChannels.length > 1
        ? `${selectedChannels.length} channels`
        : 'Vault';

  return (
    <header className="safe-top sticky top-0 z-30 border-b border-line bg-app/90 backdrop-blur-xl">
      <div className="mx-auto flex max-w-[1800px] items-center gap-2 px-3 py-2 sm:gap-3 sm:px-5">
        <div className="flex shrink-0 items-center gap-2.5 pr-1">
          <span className="relative flex h-9 w-9 items-center justify-center rounded-2xl bg-gradient-to-br from-[#1a73e8] to-[#0d9488] text-white shadow-sm">
            <FolderLock size={18} />
          </span>
          <span className="hidden text-[15px] font-semibold tracking-tight text-ink sm:block">
            PicPocket
          </span>
        </div>

        {mode === 'photos' ? (
          <label className="relative min-w-0 flex-1">
            <span className="sr-only">Search photos</span>
            <Search size={17} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted" />
            <input
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder="Search your photos"
              className="h-10 w-full rounded-full border border-transparent bg-surface pl-10 pr-9 text-sm text-ink placeholder:text-muted focus:border-line focus:bg-app focus:outline-none"
            />
            {query ? (
              <button
                type="button"
                onClick={() => onQueryChange('')}
                aria-label="Clear search"
                className="absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full text-muted hover:bg-app"
              >
                <X size={15} />
              </button>
            ) : null}
          </label>
        ) : (
          <div className="min-w-0 flex-1" />
        )}

        <button
          type="button"
          onClick={onOpenChannels}
          aria-label="Channels"
          className="flex h-10 max-w-[45vw] shrink-0 items-center gap-1.5 rounded-full border border-line bg-elevated px-3 text-sm font-medium text-ink hover:bg-surface sm:max-w-[240px]"
        >
          <FolderLock size={15} className="shrink-0 text-muted" />
          <span className="truncate">{switcherLabel}</span>
        </button>

        {mode === 'photos' ? (
          <Button
            variant="primary"
            onClick={onUpload}
            disabled={uploadDisabled}
            aria-label="Upload files"
            leadingIcon={<Upload size={16} />}
            className="shrink-0"
          >
            <span className="hidden sm:inline">Upload</span>
          </Button>
        ) : null}

        <button
          type="button"
          onClick={onOpenSettings}
          aria-label="Settings"
          className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[#3867d6] to-[#0d9488] text-sm font-semibold text-white"
        >
          {initial}
          {syncing ? (
            <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 animate-pulse rounded-full border-2 border-app bg-accent" />
          ) : null}
        </button>
      </div>
    </header>
  );
}
