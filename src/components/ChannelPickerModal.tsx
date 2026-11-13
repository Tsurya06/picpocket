import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, RefreshCw, Search, ShieldCheck } from 'lucide-react';
import type { ChannelSummary } from '../types/media';
import { useChannelAvatar } from '../hooks/useChannelAvatar';
import { Button } from './ui/Button';
import { Modal } from './ui/Modal';
import { Spinner } from './ui/Spinner';

export interface ChannelPickerModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly channels: readonly ChannelSummary[];
  readonly selectedId: string | null;
  readonly loading: boolean;
  readonly onSelect: (id: string) => void;
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

/** Single-channel picker used by the WhatsApp tab, independent of the photo selection. */
export function ChannelPickerModal({
  open,
  onClose,
  channels,
  selectedId,
  loading,
  onSelect,
  onRefresh,
}: ChannelPickerModalProps) {
  const [search, setSearch] = useState('');
  // Staged choice: nothing changes until Done is pressed.
  const [draft, setDraft] = useState<string | null>(selectedId);
  const wasOpen = useRef(false);

  useEffect(() => {
    if (open && !wasOpen.current) setDraft(selectedId);
    wasOpen.current = open;
  }, [open, selectedId]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return channels;
    return channels.filter((channel) =>
      `${channel.title} ${channel.username ?? ''}`.toLowerCase().includes(needle),
    );
  }, [channels, search]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Choose a backup channel"
      description="This is only for WhatsApp backups. Your photo library stays exactly as it is."
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
          <p className="text-xs text-muted">One channel only</p>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={draft === null}
              onClick={() => {
                if (draft !== null) onSelect(draft);
                onClose();
              }}
            >
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
            Backups are stored in this channel as encrypted files. Photos and other libraries you
            use in PicPocket are not changed.
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
          {loading && channels.length === 0 ? <Spinner size={18} /> : null}

          {!loading && filtered.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-line p-6 text-center text-sm text-muted">
              {channels.length === 0 ? 'No chats found yet.' : 'No chat matches that search.'}
            </div>
          ) : null}

          {filtered.map((channel) => {
            const isSelected = channel.id === draft;
            return (
              <button
                key={channel.id}
                type="button"
                aria-pressed={isSelected}
                onClick={() => setDraft(channel.id)}
                className={`flex w-full items-center gap-3 rounded-2xl border p-3 text-left transition-colors ${
                  isSelected
                    ? 'border-accent/40 bg-accent-soft/50'
                    : 'border-line bg-elevated hover:bg-surface'
                }`}
              >
                <ChannelAvatar channel={channel} />
                <span className="min-w-0 flex-1">
                  <span className="truncate text-sm font-medium text-ink">{channel.title}</span>
                  <span className="mt-0.5 block text-[11px] text-muted">
                    {channel.kind === 'supergroup'
                      ? 'Supergroup'
                      : channel.kind === 'group'
                        ? 'Group'
                        : 'Channel'}
                    {channel.username ? ` · @${channel.username}` : ''}
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
      </div>
    </Modal>
  );
}
