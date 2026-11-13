import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  FolderLock,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Users,
} from 'lucide-react';
import type { ChannelSummary } from '../types/media';
import { useChannelAvatar } from '../hooks/useChannelAvatar';
import { Button } from './ui/Button';
import { Modal } from './ui/Modal';
import { Spinner } from './ui/Spinner';

export interface ChannelSelectorModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly channels: readonly ChannelSummary[];
  readonly selectedIds: readonly string[];
  readonly loading: boolean;
  readonly onToggle: (id: string) => void;
  readonly onCreate: (title: string) => Promise<ChannelSummary | null>;
  readonly onRefresh: () => void;
}

function ChannelAvatar({ channel }: { channel: ChannelSummary }) {
  const url = useChannelAvatar(channel.id, true);
  if (url) {
    return (
      <img
        src={url}
        alt=""
        className="h-11 w-11 shrink-0 rounded-full object-cover"
        loading="lazy"
        decoding="async"
      />
    );
  }
  return (
    <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent-soft text-sm font-semibold uppercase text-accent">
      {channel.title.trim().charAt(0) || '#'}
    </span>
  );
}

export function ChannelSelectorModal({
  open,
  onClose,
  channels,
  selectedIds,
  loading,
  onToggle,
  onCreate,
  onRefresh,
}: ChannelSelectorModalProps) {
  const [search, setSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [title, setTitle] = useState('My PicPocket');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Staged selection: toggles only change this draft until Done is pressed.
  const [draft, setDraft] = useState<Set<string>>(() => new Set(selectedIds));
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) setDraft(new Set(selectedIds));
    wasOpen.current = open;
  }, [open, selectedIds]);

  const toggleDraft = (id: string): void => {
    setDraft((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const commit = (): void => {
    for (const id of selectedIds) {
      if (!draft.has(id)) onToggle(id);
    }
    for (const id of draft) {
      if (!selectedIds.includes(id)) onToggle(id);
    }
    onClose();
  };

  const selected = draft;
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return channels;
    return channels.filter((channel) =>
      `${channel.title} ${channel.username ?? ''}`.toLowerCase().includes(needle),
    );
  }, [channels, search]);

  const create = async (): Promise<void> => {
    const trimmed = title.trim();
    if (trimmed.length < 2) {
      setCreateError('Give it a name with at least 2 characters.');
      return;
    }
    setCreating(true);
    setCreateError(null);
    const created = await onCreate(trimmed);
    setCreating(false);
    if (!created) {
      setCreateError('Telegram refused to create the channel. Try again in a moment.');
      return;
    }
    // The new channel is selected by the hook; mirror it in the draft.
    setDraft((current) => new Set(current).add(created.id));
    setShowCreate(false);
    setTitle('My PicPocket');
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Choose your photo channels"
      description="Pick the chats that hold your photos. Everything else stays untouched."
      size="lg"
      headerAccessory={
        <button
          type="button"
          onClick={onRefresh}
          aria-label="Refresh channel list"
          className="flex h-10 w-10 items-center justify-center rounded-full text-muted hover:bg-surface"
        >
          {loading ? <Spinner size={17} /> : <RefreshCw size={17} />}
        </button>
      }
      footer={
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted">
            {draft.size === 0
              ? 'Nothing selected yet'
              : `${draft.size} chat${draft.size === 1 ? '' : 's'} selected`}
          </p>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button size="sm" onClick={commit} disabled={draft.size === 0}>
              Done
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="flex items-center gap-2 rounded-xl border border-emerald-500/25 bg-emerald-500/5 px-3.5 py-3 text-xs leading-relaxed text-muted">
          <ShieldCheck size={16} className="shrink-0 text-emerald-500" />
          <p>
            Chats you pick here become your photo library. New uploads are encrypted; photos already
            in them show up automatically.
          </p>
        </div>

        <label className="relative block">
          <span className="sr-only">Filter channels</span>
          <Search
            size={16}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted"
          />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by name"
            className="h-10 w-full rounded-xl border border-line bg-app pl-9 pr-3 text-sm text-ink placeholder:text-muted focus:border-accent focus:outline-none"
          />
        </label>

        <div className="max-h-[42vh] space-y-1.5 overflow-y-auto pr-1">
          {loading && channels.length === 0 ? (
            <div className="space-y-2">
              {Array.from({ length: 4 }, (_, index) => (
                <div key={index} className="flex items-center gap-3 rounded-2xl border border-line p-3">
                  <div className="shimmer h-11 w-11 rounded-full" />
                  <div className="flex-1 space-y-2">
                    <div className="shimmer h-3 w-1/2 rounded" />
                    <div className="shimmer h-2.5 w-1/3 rounded" />
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          {!loading && filtered.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-line p-6 text-center text-sm text-muted">
              {channels.length === 0
                ? 'No chats found yet. Create a private one below.'
                : 'No chat matches that search.'}
            </div>
          ) : null}

          {filtered.map((channel) => {
            const isSelected = selected.has(channel.id);
            return (
              <button
                key={channel.id}
                type="button"
                role="switch"
                aria-checked={isSelected}
                onClick={() => toggleDraft(channel.id)}
                className={`flex w-full items-center gap-3 rounded-2xl border p-3 text-left transition-colors ${
                  isSelected
                    ? 'border-accent/40 bg-accent-soft/50'
                    : 'border-line bg-elevated hover:bg-surface'
                }`}
              >
                <ChannelAvatar channel={channel} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-medium text-ink">{channel.title}</span>
                    {channel.isCreator ? (
                      <span className="shrink-0 rounded-full bg-surface px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted">
                        Owner
                      </span>
                    ) : null}
                  </span>
                  <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted">
                    <span>
                      {channel.kind === 'supergroup'
                        ? 'Supergroup'
                        : channel.kind === 'group'
                          ? 'Group'
                          : 'Channel'}
                    </span>
                    {typeof channel.memberCount === 'number' ? (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="inline-flex items-center gap-1">
                          <Users size={11} /> {channel.memberCount.toLocaleString()}
                        </span>
                      </>
                    ) : null}
                    {channel.username ? (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="truncate">@{channel.username}</span>
                      </>
                    ) : null}
                  </span>
                </span>
                <span
                  className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border ${
                    isSelected
                      ? 'border-accent bg-accent text-accent-ink'
                      : 'border-line bg-elevated text-transparent'
                  }`}
                >
                  <Check size={14} strokeWidth={3} />
                </span>
              </button>
            );
          })}
        </div>

        {showCreate ? (
          <div className="rounded-2xl border border-line bg-surface/60 p-4">
            <p className="flex items-center gap-2 text-sm font-medium text-ink">
              <FolderLock size={16} className="text-accent" /> New private vault channel
            </p>
            <p className="mt-1 text-xs leading-relaxed text-muted">
              Only you can post in it, and nobody can join without an invite link you share.
            </p>
            <div className="mt-3 flex gap-2">
              <input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                maxLength={80}
                className="h-10 flex-1 rounded-xl border border-line bg-app px-3 text-sm text-ink focus:border-accent focus:outline-none"
                placeholder="Channel name"
                autoFocus
              />
              <Button size="sm" onClick={() => void create()} disabled={creating}>
                {creating ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
                Create
              </Button>
            </div>
            {createError ? <p className="mt-2 text-xs text-danger">{createError}</p> : null}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            className="flex w-full items-center gap-2 rounded-2xl border border-dashed border-line p-3.5 text-sm font-medium text-accent hover:bg-surface"
          >
            <Plus size={17} /> Create new private vault channel
          </button>
        )}
      </div>
    </Modal>
  );
}
