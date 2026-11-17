import { useEffect, useState } from 'react';
import { Check, Copy, Download, KeyRound, ShieldAlert } from 'lucide-react';
import { Button } from './ui/Button';
import { Modal } from './ui/Modal';
import { Spinner } from './ui/Spinner';

export interface VaultRecoverySetupModalProps {
  readonly open: boolean;
  readonly words: string;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}

export function VaultRecoverySetupModal({
  open,
  words,
  busy,
  error,
  onCancel,
  onConfirm,
}: VaultRecoverySetupModalProps) {
  const [consent, setConsent] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setConsent(false);
    setCopied(false);
    setCopyError(null);
  }, [open]);

  const copy = async (): Promise<void> => {
    setCopyError(null);
    try {
      await navigator.clipboard.writeText(words);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopyError('Copy failed. Use Download instead.');
    }
  };

  const download = (): void => {
    const content = [
      'PicPocket vault recovery key',
      '',
      'Keep this private. These 24 words are the vault key itself.',
      'If you lose this key and forget your passphrase, the vault cannot be opened.',
      '',
      words,
      '',
    ].join('\n');
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'picpocket-vault-recovery-key.txt';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title="Save your vault recovery key"
      description="This is shown once, before the vault is created"
      size="lg"
    >
      <div className="space-y-4">
        <div className="flex items-start gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/5 p-4">
          <ShieldAlert size={18} className="mt-0.5 shrink-0 text-amber-500" />
          <p className="text-xs leading-relaxed text-muted">
            These 24 words encode the vault key itself—not a password. Anyone with them can open the
            vault. Do not store them in Telegram, this browser, or a shared password manager.
          </p>
        </div>

        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted">
            24-word recovery key
          </span>
          <textarea
            disabled
            value={words}
            rows={5}
            className="w-full resize-none rounded-xl border border-line bg-surface/70 p-3.5 font-mono text-sm leading-relaxed text-ink opacity-100 disabled:cursor-default"
          />
        </label>

        <div className="flex flex-col gap-2 sm:flex-row">
          <Button
            variant="secondary"
            className="flex-1"
            onClick={() => void copy()}
            leadingIcon={copied ? <Check size={16} /> : <Copy size={16} />}
          >
            {copied ? 'Copied' : 'Copy key'}
          </Button>
          <Button
            variant="secondary"
            className="flex-1"
            onClick={download}
            leadingIcon={<Download size={16} />}
          >
            Download key
          </Button>
        </div>
        {copyError ? <p className="text-xs text-danger">{copyError}</p> : null}

        <label className="flex items-start gap-3 rounded-xl border border-line bg-surface/60 p-3.5 text-xs leading-relaxed text-muted">
          <input
            type="checkbox"
            checked={consent}
            onChange={(event) => setConsent(event.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-line accent-[var(--accent)]"
          />
          <span>
            I understand that if I lose this key and forget my passphrase, I cannot enter this vault.
          </span>
        </label>

        {error ? <p className="text-xs text-danger">{error}</p> : null}

        <Button
          className="w-full"
          onClick={onConfirm}
          disabled={!consent || busy}
          leadingIcon={busy ? <Spinner size={16} /> : <KeyRound size={16} />}
        >
          {busy ? 'Finishing setup…' : 'I saved this key — finish setup'}
        </Button>
        <p className="text-center text-[11px] leading-relaxed text-muted">
          Closing this window cancels vault creation. You can create the vault again with your
          passphrase.
        </p>
      </div>
    </Modal>
  );
}
