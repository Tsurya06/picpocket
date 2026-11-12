import { useEffect, useState } from 'react';
import { FolderLock, Menu, Search, Settings, Upload, X } from 'lucide-react';
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
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (!menuOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [menuOpen]);

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
        {/* Desktop brand logo — hidden on mobile for 100% full-width search */}
        <div className="hidden shrink-0 items-center gap-2.5 pr-1 sm:flex">
          <span className="relative flex h-9 w-9 items-center justify-center rounded-2xl bg-gradient-to-br from-[#1a73e8] to-[#0d9488] text-white shadow-sm">
            <FolderLock size={18} />
          </span>
          <span className="text-[15px] font-semibold tracking-tight text-ink">
            PicPocket
          </span>
        </div>

        {/* Search bar: occupies full remaining width on mobile */}
        {mode === 'photos' ? (
          <label className="relative min-w-0 flex-1">
            <span className="sr-only">Search photos</span>
            <Search
              size={17}
              className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted"
            />
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
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span className="relative flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-[#1a73e8] to-[#0d9488] text-white shadow-sm sm:hidden">
              <FolderLock size={16} />
            </span>
            <span className="text-sm font-semibold text-ink sm:hidden">
              WhatsApp Vault
            </span>
          </div>
        )}

        {/* Desktop Action Group — strictly hidden on mobile */}
        <div className="hidden shrink-0 items-center gap-2 sm:flex">
          <button
            type="button"
            onClick={onOpenChannels}
            aria-label="Channels"
            className="flex h-10 max-w-[240px] shrink-0 items-center gap-1.5 rounded-full border border-line bg-elevated px-3 text-sm font-medium text-ink hover:bg-surface"
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
              <span>Upload</span>
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

        {/* Mobile Hamburger Button — only button next to search on mobile */}
        <button
          type="button"
          onClick={() => setMenuOpen(!menuOpen)}
          aria-label={menuOpen ? 'Close menu' : 'Open menu'}
          aria-expanded={menuOpen}
          className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-line bg-elevated text-ink transition-colors hover:bg-surface sm:hidden"
        >
          {menuOpen ? <X size={20} /> : <Menu size={20} />}
          {syncing && !menuOpen ? (
            <span className="absolute right-1 top-1 h-2.5 w-2.5 animate-pulse rounded-full border-2 border-app bg-accent" />
          ) : null}
        </button>
      </div>

      {/* Mobile Drawer (Navigation & Settings only — no redundant upload button) */}
      {menuOpen ? (
        <>
          <div
            className="fixed inset-0 top-[57px] z-20 bg-black/40 backdrop-blur-xs sm:hidden"
            onClick={() => setMenuOpen(false)}
            aria-hidden="true"
          />
          <div
            role="dialog"
            aria-label="Mobile Navigation"
            className="absolute inset-x-0 top-full z-30 border-b border-line bg-elevated/95 p-3 shadow-xl backdrop-blur-xl sm:hidden"
          >
            <div className="flex flex-col gap-2.5">
              {/* Account profile card */}
              <div className="flex items-center justify-between rounded-2xl border border-line bg-surface/60 p-3">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[#3867d6] to-[#0d9488] text-sm font-semibold text-white">
                    {initial}
                    {syncing ? (
                      <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 animate-pulse rounded-full border-2 border-app bg-accent" />
                    ) : null}
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-ink">{accountName}</p>
                    <p className="text-xs text-muted">
                      {syncing ? 'Syncing changes…' : 'MTProto Connected'}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    onOpenSettings();
                  }}
                  className="flex h-8 items-center gap-1.5 rounded-lg border border-line bg-app px-2.5 text-xs font-medium text-ink hover:bg-surface"
                >
                  <Settings size={13} className="text-muted" />
                  Settings
                </button>
              </div>

              {/* Vault channel selector */}
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  onOpenChannels();
                }}
                className="flex items-center justify-between rounded-xl border border-line bg-surface/60 p-3 text-left transition-colors hover:bg-surface"
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <FolderLock size={18} className="shrink-0 text-accent" />
                  <div className="min-w-0">
                    <p className="text-[11px] font-medium text-muted">Selected Vault</p>
                    <p className="truncate text-sm font-medium text-ink">{switcherLabel}</p>
                  </div>
                </div>
                <span className="shrink-0 text-xs font-semibold text-accent">Switch</span>
              </button>
            </div>
          </div>
        </>
      ) : null}
    </header>
  );
}
