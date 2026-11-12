import { useEffect, useState, type FormEvent } from 'react';
import { KeyRound } from 'lucide-react';
import { Button } from './ui/Button';
import { Spinner } from './ui/Spinner';

export interface LockedChannel {
  readonly id: string;
  readonly title: string;
}

export interface ChannelVaultBannerProps {
  readonly channels: readonly LockedChannel[];
  /** Items in the current page that could not be decrypted yet. */
  readonly skipped: number;
  readonly error: string | null;
  readonly onUnlock: (channelId: string, passphrase: string) => Promise<boolean>;
}

/**
 * Non-intrusive prompt for a shared channel that was sealed with a different
 * vault passphrase. Unlocking one channel never replaces the primary vault.
 */
export function ChannelVaultBanner({
  channels,
  skipped,
  error,
  onUnlock,
}: ChannelVaultBannerProps) {
  const [channelId, setChannelId] = useState(channels[0]?.id ?? '');
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [opened, setOpened] = useState(false);

  useEffect(() => {
    if (!channels.some((channel) => channel.id === channelId)) {
      setChannelId(channels[0]?.id ?? '');
    }
  }, [channelId, channels]);

  if (channels.length === 0) {
    if (skipped === 0) return null;
    return (
      <div className="mx-auto mt-3 max-w-[1800px] px-4 sm:px-6">
        <p className="rounded-xl border border-line bg-surface/60 px-3.5 py-2.5 text-xs text-muted">
          {skipped} item{skipped === 1 ? '' : 's'} in this channel are sealed with another key, so
          they are hidden. Unlock that channel or press refresh to retry.
        </p>
      </div>
    );
  }

  const title =
    channels.length === 1
      ? `“${channels[0]?.title ?? 'This channel'}” needs its vault passphrase`
      : `${channels.length} channels need their vault passphrases`;

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (passphrase.length < 8 || channelId.length === 0) return;
    setBusy(true);
    const ok = await onUnlock(channelId, passphrase);
    setBusy(false);
    if (ok) {
      setPassphrase('');
      setOpened(true);
    }
  };

  return (
    <div className="mx-auto mt-3 max-w-[1800px] px-4 sm:px-6">
      <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-3.5 py-3">
        <p className="flex items-center gap-2 text-xs font-medium text-ink">
          <KeyRound size={14} className="shrink-0 text-amber-500" /> {title}
        </p>
        <p className="mt-1 text-[11px] leading-relaxed text-muted">
          This channel was sealed on another device with a different passphrase. Enter it once to
          unlock just this channel — your main vault and passphrase stay unchanged.
        </p>

        {opened ? (
          <p className="mt-2 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
            Channel unlocked. Decrypting its items…
          </p>
        ) : (
          <form onSubmit={(event) => void submit(event)} className="mt-2.5 flex flex-col gap-2 sm:flex-row">
            {channels.length > 1 ? (
              <select
                value={channelId}
                onChange={(event) => setChannelId(event.target.value)}
                className="h-9 rounded-xl border border-line bg-app px-2.5 text-xs text-ink focus:border-accent focus:outline-none"
              >
                {channels.map((channel) => (
                  <option key={channel.id} value={channel.id}>
                    {channel.title}
                  </option>
                ))}
              </select>
            ) : null}
            <input
              type="password"
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
              placeholder="Channel vault passphrase"
              autoComplete="off"
              className="h-9 min-w-0 flex-1 rounded-xl border border-line bg-app px-3 text-xs text-ink placeholder:text-muted focus:border-accent focus:outline-none"
            />
            <Button
              type="submit"
              size="sm"
              disabled={busy || passphrase.length < 8 || channelId.length === 0}
            >
              {busy ? <Spinner size={14} /> : <KeyRound size={14} />}
              {busy ? 'Unlocking…' : 'Unlock channel'}
            </Button>
          </form>
        )}

        {error ? <p className="mt-2 text-[11px] text-danger">{error}</p> : null}
        {!opened && skipped > 0 ? (
          <p className="mt-2 text-[11px] text-muted">
            {skipped} item{skipped === 1 ? '' : 's'} are waiting on this key.
          </p>
        ) : null}
      </div>
    </div>
  );
}
