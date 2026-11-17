import { useEffect, useState, type FormEvent } from 'react';
import { KeyRound, ShieldAlert } from 'lucide-react';
import { Button } from './ui/Button';
import { Modal } from './ui/Modal';
import { Spinner } from './ui/Spinner';

export interface ResetPassphraseModalProps {
  readonly open: boolean;
  readonly hasRecovery: boolean;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onClose: () => void;
  readonly onReset: (words: string, passphrase: string) => Promise<boolean>;
  readonly onStartOver: () => void;
}

export function ResetPassphraseModal({
  open,
  hasRecovery,
  busy,
  error,
  onClose,
  onReset,
  onStartOver,
}: ResetPassphraseModalProps) {
  const [words, setWords] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setWords('');
    setPassphrase('');
    setConfirmation('');
    setLocalError(null);
  }, [open]);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setLocalError(null);
    if (words.trim().split(/\s+/).filter(Boolean).length !== 24) {
      setLocalError('Enter all 24 recovery words separated by spaces.');
      return;
    }
    if (passphrase.length < 8) {
      setLocalError('Use at least 8 characters for the new passphrase.');
      return;
    }
    if (passphrase !== confirmation) {
      setLocalError('The new passphrases do not match.');
      return;
    }
    const ok = await onReset(words, passphrase);
    if (ok) onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Forgot passphrase"
      description="Recover with your 24-word vault key, then choose a new passphrase"
    >
      {!hasRecovery ? (
        <div className="space-y-4">
          <div className="flex items-start gap-3 rounded-2xl border border-danger/25 bg-danger/5 p-4">
            <ShieldAlert size={18} className="mt-0.5 shrink-0 text-danger" />
            <p className="text-xs leading-relaxed text-muted">
              This vault has no recovery key saved. Without the passphrase, encrypted media cannot be
              opened. Starting over creates a new local vault; existing encrypted files stay in
              Telegram but remain unreadable.
            </p>
          </div>
          <Button className="w-full" variant="danger" onClick={onStartOver}>
            Start over with a new vault
          </Button>
        </div>
      ) : (
        <form onSubmit={(event) => void submit(event)} className="space-y-4">
          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted">
              24-word recovery key
            </span>
            <textarea
              value={words}
              onChange={(event) => setWords(event.target.value)}
              rows={4}
              autoComplete="off"
              spellCheck={false}
              placeholder="Enter the 24 words in order, separated by spaces"
              className="w-full resize-none rounded-xl border border-line bg-app p-3.5 font-mono text-sm leading-relaxed text-ink placeholder:text-muted/70 focus:border-accent focus:outline-none"
            />
          </label>

          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted">
              New vault passphrase
            </span>
            <input
              type="password"
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
              autoComplete="new-password"
              placeholder="At least 8 characters"
              className="h-11 w-full rounded-xl border border-line bg-app px-3.5 text-sm text-ink placeholder:text-muted/70 focus:border-accent focus:outline-none"
            />
          </label>

          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted">
              Confirm new passphrase
            </span>
            <input
              type="password"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              autoComplete="new-password"
              placeholder="Repeat the new passphrase"
              className="h-11 w-full rounded-xl border border-line bg-app px-3.5 text-sm text-ink placeholder:text-muted/70 focus:border-accent focus:outline-none"
            />
          </label>

          <p className="text-[11px] leading-relaxed text-muted">
            Your 24 words decode the existing vault key, so your photos and channels stay unchanged.
            Only the passphrase used to unlock this device changes.
          </p>

          {localError ?? error ? (
            <p className="text-xs text-danger">{localError ?? error}</p>
          ) : null}

          <Button
            type="submit"
            className="w-full"
            disabled={busy}
            leadingIcon={busy ? <Spinner size={16} /> : <KeyRound size={16} />}
          >
            {busy ? 'Recovering vault…' : 'Recover and set new passphrase'}
          </Button>
        </form>
      )}
    </Modal>
  );
}
