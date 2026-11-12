import { useEffect, useState } from 'react';
import {
  Check,
  Database,
  FolderLock,
  HardDrive,
  LogOut,
  Moon,
  ShieldCheck,
  Trash2,
  Users,
} from 'lucide-react';
import type { TelegramAccount, ThemeMode, VaultProfile } from '../types/media';
import { formatBytes, formatFullDate } from '../lib/format';
import { clearAllMediaCache, getCacheStats } from '../services/cache/db';
import { Button } from './ui/Button';
import { Modal } from './ui/Modal';
import { Spinner } from './ui/Spinner';

export interface SettingsModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly account: TelegramAccount | null;
  readonly profile: VaultProfile | null;
  readonly channelCount: number;
  readonly theme: ThemeMode;
  readonly onToggleTheme: () => void;
  readonly encryptUploads: boolean;
  readonly onToggleEncrypt: (value: boolean) => void;
  readonly onManageChannels: () => void;
  readonly onLock: () => void;
  readonly onReset: () => void;
}

export function SettingsModal({
  open,
  onClose,
  account,
  profile,
  channelCount,
  theme,
  onToggleTheme,
  encryptUploads,
  onToggleEncrypt,
  onManageChannels,
  onLock,
  onReset,
}: SettingsModalProps) {
  const [stats, setStats] = useState<{ entries: number; bytes: number } | null>(null);
  const [clearing, setClearing] = useState(false);
  const [resetArmed, setResetArmed] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setStats(null);
    void getCacheStats()
      .then((value) => {
        if (!cancelled) setStats(value);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [open]);

  const clearCache = async (): Promise<void> => {
    setClearing(true);
    try {
      await clearAllMediaCache();
      const next = await getCacheStats();
      setStats(next);
    } finally {
      setClearing(false);
    }
  };

  const initial = account?.displayName.trim().charAt(0).toUpperCase() || 'T';

  return (
    <Modal open={open} onClose={onClose} title="Settings" description="Your account, privacy, and what is stored on this device">
      <div className="space-y-6">

        {/* ── Account info ────────────────────────────────────────── */}
        <section className="flex items-center gap-3">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-[#3867d6] to-[#0d9488] text-lg font-semibold text-white">
            {initial}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-ink">
              {account?.displayName ?? 'Telegram account'}
            </p>
            <p className="truncate text-xs text-muted">
              {account?.username ? `@${account.username}` : account?.phone ?? 'Signed in with Telegram'}
            </p>
          </div>
        </section>

        {/* ── Toggles card ────────────────────────────────────────── */}
        <section className="rounded-2xl border border-line">

          {/* Appearance */}
          <div className="flex items-center justify-between gap-4 border-b border-line p-4">
            <div>
              <p className="flex items-center gap-2 text-sm font-medium text-ink">
                <Moon size={15} className="text-accent" /> Dark theme
              </p>
              <p className="mt-1 text-xs leading-relaxed text-muted">
                Softer on the eyes at night.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={theme === 'dark'}
              aria-label="Dark theme"
              onClick={onToggleTheme}
              className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors ${
                theme === 'dark' ? 'bg-accent' : 'bg-line'
              }`}
            >
              <span
                className={`inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
                  theme === 'dark' ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>

          {/* Encrypt uploads toggle */}
          <div className="flex items-center justify-between gap-4 border-b border-line p-4">
            <div>
              <p className="flex items-center gap-2 text-sm font-medium text-ink">
                <FolderLock size={15} className="text-accent" />                 Encrypt new uploads
              </p>
              <p className="mt-1 text-xs leading-relaxed text-muted">
                Every file is scrambled on this device before it leaves. Turn off to post regular
                Telegram photos and files instead.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={encryptUploads}
              onClick={() => onToggleEncrypt(!encryptUploads)}
              className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors ${
                encryptUploads ? 'bg-accent' : 'bg-line'
              }`}
            >
              <span
                className={`inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
                  encryptUploads ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>

          {/* Channels */}
          <div className="flex items-center justify-between gap-4 p-4">
            <div>
              <p className="flex items-center gap-2 text-sm font-medium text-ink">
                <Users size={15} className="text-accent" /> Channels
              </p>
              <p className="mt-1 text-xs leading-relaxed text-muted">
                {channelCount === 0
                  ? 'No channel selected yet.'
                  : `${channelCount} chat${channelCount === 1 ? '' : 's'} selected for your gallery.`}
              </p>
            </div>
            <Button size="sm" variant="secondary" onClick={onManageChannels}>
              Manage
            </Button>
          </div>
        </section>

        {/* ── Security model ──────────────────────────────────────── */}
        <section className="rounded-2xl border border-line p-4">
          <p className="flex items-center gap-2 text-sm font-medium text-ink">
            <ShieldCheck size={15} className="text-emerald-500" /> How your stuff is protected
          </p>
          <dl className="mt-3 space-y-2">
            <div key="Connection" className="flex items-start justify-between gap-4 text-xs">
              <dt className="text-muted">Connection</dt>
              <dd className="text-right font-medium text-ink">Straight to Telegram, no middleman</dd>
            </div>
            <div key="Device identity" className="flex items-start justify-between gap-4 text-xs">
              <dt className="text-muted">Device identity</dt>
              <dd className="text-right font-medium text-ink">Looks like a normal Telegram app</dd>
            </div>
            <div key="Encryption" className="flex items-start justify-between gap-4 text-xs">
              <dt className="text-muted">Encryption</dt>
              <dd className="text-right font-medium text-ink">AES-256-GCM, key never leaves here</dd>
            </div>
            <div key="Passphrase" className="flex items-start justify-between gap-4 text-xs">
              <dt className="text-muted">Passphrase</dt>
              <dd className="text-right font-medium text-ink">PBKDF2-SHA-256 · 600,000 rounds</dd>
            </div>
            <div key="Saved login" className="flex items-start justify-between gap-4 text-xs">
              <dt className="text-muted">Saved login</dt>
              <dd className="text-right font-medium text-ink">Sealed with your passphrase</dd>
            </div>
            <div key="Upload pacing" className="flex items-start justify-between gap-4 text-xs">
              <dt className="text-muted">Upload pacing</dt>
              <dd className="text-right font-medium text-ink">
                One at a time, pauses if Telegram asks
              </dd>
            </div>
            <div key="Photo details" className="flex items-start justify-between gap-4 text-xs">
              <dt className="text-muted">Photo details</dt>
              <dd className="text-right font-medium text-ink">Location and camera data removed</dd>
            </div>
          </dl>
          {profile ? (
            <p className="mt-3 border-t border-line pt-3 text-[11px] text-muted">
              Vault created {formatFullDate(profile.createdAt)}
            </p>
          ) : null}
        </section>

        {/* ── On-device cache ─────────────────────────────────────── */}
        <section className="rounded-2xl border border-line p-4">
          <p className="flex items-center gap-2 text-sm font-medium text-ink">
            <HardDrive size={15} className="text-muted" /> On-device cache
          </p>
          <p className="mt-1 text-xs leading-relaxed text-muted">
            Previews are kept in this browser so the gallery works offline. Original files are never cached.
          </p>
          <div className="mt-3 flex items-center justify-between gap-3">
            <span className="flex items-center gap-2 text-xs text-muted">
              <Database size={13} /> {stats ? `${stats.entries} previews · ${formatBytes(stats.bytes)}` : 'Measuring…'}
            </span>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void clearCache()}
              disabled={clearing || !stats || stats.entries === 0}
            >
              {clearing ? <Spinner size={14} /> : null}
              Clear cache
            </Button>
          </div>
        </section>

        {/* ── Session actions ─────────────────────────────────────── */}
        <section className="space-y-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">Session</p>
          <Button
            variant="secondary"
            className="w-full"
            onClick={onLock}
            leadingIcon={<LogOut size={16} />}
          >
            Lock vault & forget session
          </Button>

          {resetArmed ? (
            <div className="rounded-2xl border border-danger/30 bg-danger/5 p-4">
              <p className="text-sm font-medium text-ink">Reset this device?</p>
              <p className="mt-1 text-xs leading-relaxed text-muted">
                Removes your saved login, vault setup, channel choices, and cached previews from this
                device. Encrypted files stay in Telegram, but you will need the same passphrase to
                read them again.
              </p>
              <div className="mt-3 flex gap-2">
                <Button size="sm" variant="danger" onClick={onReset}>Yes, reset</Button>
                <Button size="sm" variant="ghost" onClick={() => setResetArmed(false)}>Cancel</Button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setResetArmed(true)}
              className="flex w-full items-center gap-2 rounded-xl px-1 py-1 text-xs font-medium text-muted hover:text-danger"
            >
              <Trash2 size={13} /> Reset local data
            </button>
          )}
        </section>

        {/* ── Footer ──────────────────────────────────────────────── */}
        <p className="flex items-start gap-2 border-t border-line pt-4 text-[11px] leading-relaxed text-muted">
          <Check size={13} className="mt-0.5 shrink-0 text-emerald-500" />
          PicPocket has no server, no analytics, and no account of its own. Everything you see travels directly between this browser and Telegram.
        </p>
      </div>
    </Modal>
  );
}
