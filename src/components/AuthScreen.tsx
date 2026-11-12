import { useState, type FormEvent, type ReactNode } from 'react';
import {
  ArrowRight,
  Check,
  Eye,
  EyeOff,
  FolderLock,
  KeyRound,
  Lock,
  Moon,
  QrCode,
  ShieldCheck,
  Smartphone,
  Sun,
} from 'lucide-react';
import type { AuthController } from '../hooks/useTelegramAuth';
import { VAULT_PASSPHRASE_HINT } from '../hooks/useTelegramAuth';
import type { ThemeMode } from '../types/media';
import {
  API_CREDENTIALS_HELP_URL,
  envCredentials,
  hasEnvCredentials,
  loadCustomCredentials,
  saveCustomCredentials,
} from '../lib/config';
import { Button, IconButton } from './ui/Button';
import { Spinner } from './ui/Spinner';
import { QRCodeCanvas } from './QRCodeCanvas';

export interface AuthScreenProps {
  readonly auth: AuthController;
  readonly theme: ThemeMode;
  readonly onToggleTheme: () => void;
}

const inputClass =
  'h-11 w-full rounded-xl border border-line bg-app px-3.5 text-sm text-ink placeholder:text-muted/70 focus:border-accent focus:outline-none';

const labelClass = 'mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted';

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className={labelClass}>{label}</span>
      {children}
      {hint ? <span className="mt-1.5 block text-xs text-muted">{hint}</span> : null}
    </label>
  );
}

function SecretField({
  label,
  value,
  onChange,
  placeholder,
  autoComplete,
  autoFocus,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  autoComplete?: string;
  autoFocus?: boolean;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <label className="block">
      <span className={labelClass}>{label}</span>
      <span className="relative block">
        <input
          className={`${inputClass} pr-11`}
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          autoComplete={autoComplete}
          autoFocus={autoFocus}
          spellCheck={false}
        />
        <button
          type="button"
          onClick={() => setVisible((current) => !current)}
          className="absolute right-1 top-1 flex h-9 w-9 items-center justify-center rounded-full text-muted hover:bg-surface"
          aria-label={visible ? 'Hide password' : 'Show password'}
        >
          {visible ? <EyeOff size={17} /> : <Eye size={17} />}
        </button>
      </span>
    </label>
  );
}

function ErrorBanner({ message, onDismiss }: { message: string | null; onDismiss: () => void }) {
  if (!message) return null;
  return (
    <div
      role="alert"
      className="mb-4 flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-sm text-danger"
    >
      <span className="flex-1">{message}</span>
      <button type="button" onClick={onDismiss} className="text-xs font-semibold uppercase">
        Dismiss
      </button>
    </div>
  );
}

function StepDots({ step }: { step: 1 | 2 }) {
  return (
    <div className="mb-6 flex items-center gap-2" aria-hidden="true">
      {[1, 2].map((value) => (
        <span
          key={value}
          className={`h-1.5 flex-1 rounded-full transition-colors ${
            value <= step ? 'bg-accent' : 'bg-line'
          }`}
        />
      ))}
    </div>
  );
}

function BrandPanel() {
  return (
    <div className="relative hidden overflow-hidden bg-[#0b1220] p-12 text-white lg:flex lg:w-[46%] lg:flex-col lg:justify-between">
      <div
        className="pointer-events-none absolute inset-0 opacity-90"
        style={{
          background:
            'radial-gradient(1000px 600px at 10% 0%, #1a73e8 0%, transparent 55%), radial-gradient(900px 700px at 90% 100%, #0d9488 0%, transparent 60%)',
        }}
      />
      <div className="relative">
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-white/15 backdrop-blur">
            <FolderLock size={22} />
          </span>
          <span className="text-lg font-semibold tracking-tight">PicPocket</span>
        </div>

        <h1 className="mt-16 max-w-md text-4xl font-semibold leading-[1.1] tracking-tight">
          Your photos.
          <br />
          Your channels.
          <br />
          <span className="text-white/70">Your keys.</span>
        </h1>
        <p className="mt-5 max-w-sm text-sm leading-relaxed text-white/70">
          A Google Photos–style gallery that uses your own private Telegram channels as
          unlimited storage. No backend, no analytics, no plaintext uploads.
        </p>

        <ul className="mt-10 space-y-4 text-sm text-white/85">
          {[
            'MTProto over WebSockets, straight from this tab',
            'AES-256-GCM vault with PBKDF2 (600,000 rounds)',
            'EXIF and GPS stripped locally before upload',
            'Session sealed at rest; nothing readable in IndexedDB',
          ].map((line) => (
            <li key={line} className="flex items-start gap-3">
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/15">
                <Check size={12} />
              </span>
              {line}
            </li>
          ))}
        </ul>
      </div>

      <p className="relative text-xs leading-relaxed text-white/50">
        Open source. Independent client — not affiliated with Telegram or Google.
      </p>
    </div>
  );
}

export function AuthScreen({ auth, theme, onToggleTheme }: AuthScreenProps) {
  const [storedCredentials] = useState(loadCustomCredentials);
  const [apiId, setApiId] = useState(
    envCredentials.apiId?.toString() ?? storedCredentials.apiId?.toString() ?? '',
  );
  const [apiHash, setApiHash] = useState(
    envCredentials.apiHash ?? storedCredentials.apiHash ?? '',
  );
  // Desktop users sign in by scanning with their phone; phone-first elsewhere.
  const [method, setMethod] = useState<'phone' | 'qr'>(() =>
    typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches
      ? 'qr'
      : 'phone',
  );
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [resetArmed, setResetArmed] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const error = localError ?? auth.error;
  const clearError = (): void => {
    setLocalError(null);
    auth.clearError();
  };

  const submitLogin = (event: FormEvent): void => {
    event.preventDefault();
    clearError();
    const parsedApiId = Number.parseInt(apiId, 10);
    if (!Number.isFinite(parsedApiId) || parsedApiId <= 0) {
      setLocalError(
        'This copy has no Telegram API credentials. Open “Advanced: Custom API ID” at the bottom and paste your own.',
      );
      return;
    }
    if (apiHash.trim().length < 10) {
      setLocalError(
        'The API hash is missing. Paste the matching hash under “Advanced: Custom API ID”.',
      );
      return;
    }
    if (method === 'phone' && !/^\+?[0-9\s-]{6,18}$/.test(phone.trim())) {
      setLocalError('Enter your phone number in international format.');
      return;
    }
    // Deployment credentials win; otherwise remember what the user entered.
    if (!hasEnvCredentials) saveCustomCredentials(parsedApiId, apiHash.trim());
    void auth.beginLogin({
      apiId: parsedApiId,
      apiHash: apiHash.trim(),
      mode: method,
      phone: method === 'phone' ? phone.trim() : undefined,
    });
  };

  const submitCode = (event: FormEvent): void => {
    event.preventDefault();
    if (code.trim().length < 3) return;
    auth.submitCode(code.trim());
    setCode('');
  };

  const submitPassword = (event: FormEvent): void => {
    event.preventDefault();
    if (password.length === 0) return;
    auth.submitPassword(password);
    setPassword('');
  };

  const submitVault = (event: FormEvent): void => {
    event.preventDefault();
    clearError();
    if (auth.vaultMode === 'create') {
      if (passphrase.length < 8) {
        setLocalError('Use at least 8 characters for the vault passphrase.');
        return;
      }
      if (passphrase !== confirmation) {
        setLocalError('The passphrases do not match.');
        return;
      }
      if (!acknowledged) {
        setLocalError('Please confirm that you understand the passphrase cannot be recovered.');
        return;
      }
      void auth.createVault(passphrase);
      return;
    }
    void auth.unlock(passphrase);
  };

  const unlock = (event: FormEvent): void => {
    event.preventDefault();
    clearError();
    if (passphrase.length === 0) return;
    void auth.unlock(passphrase);
  };

  const shell = (content: ReactNode): ReactNode => (
    <div className="flex min-h-screen flex-col bg-app lg:flex-row">
      <BrandPanel />
      <div className="flex min-h-screen flex-1 flex-col">
        <div className="flex items-center justify-between px-6 py-5">
          <span className="flex items-center gap-2 text-sm font-semibold tracking-tight lg:invisible">
            <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-accent text-accent-ink">
              <FolderLock size={16} />
            </span>
            PicPocket
          </span>
          <IconButton label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} onClick={onToggleTheme}>
            {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
          </IconButton>
        </div>
        <div className="flex flex-1 items-center justify-center px-5 pb-12 sm:px-8">
          <div className="w-full max-w-[440px]">{content}</div>
        </div>
      </div>
    </div>
  );

  if (auth.status === 'booting') {
    return shell(
      <div className="flex flex-col items-center gap-4 text-muted">
        <Spinner size={26} />
        <p className="text-sm">Opening your local vault…</p>
      </div>,
    );
  }

  if (auth.status === 'locked') {
    return shell(
      <div>
        <StepDots step={2} />
        <div className="mb-6 flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-soft text-accent">
          <Lock size={22} />
        </div>
        <h2 className="text-2xl font-semibold tracking-tight text-ink">Welcome back</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          Enter your vault passphrase to derive the key and unlock your sealed Telegram session.
        </p>
        <ErrorBanner message={error} onDismiss={clearError} />
        <form onSubmit={unlock} className="mt-6 space-y-4">
          <SecretField
            label="Vault passphrase"
            value={passphrase}
            onChange={setPassphrase}
            autoComplete="current-password"
            autoFocus
            placeholder="Your passphrase"
          />
          <Button type="submit" size="lg" className="w-full" disabled={auth.busy}>
            {auth.busy ? <Spinner size={17} /> : <KeyRound size={17} />}
            {auth.busy ? 'Deriving key…' : 'Unlock vault'}
          </Button>
        </form>

        <div className="mt-8 rounded-xl border border-line bg-surface/60 p-4 text-xs leading-relaxed text-muted">
          <p className="flex items-center gap-2 font-medium text-ink">
            <ShieldCheck size={14} /> Derivation happens on this device
          </p>
          <p className="mt-1.5">
            PBKDF2-SHA-256 · 600,000 iterations · AES-256-GCM. The key stays inside a Web Worker
            and can never be exported.
          </p>
        </div>

        <div className="mt-6 text-center">
          {resetArmed ? (
            <div className="rounded-xl border border-danger/30 bg-danger/5 p-4 text-left">
              <p className="text-sm font-medium text-ink">Reset local data?</p>
              <p className="mt-1 text-xs leading-relaxed text-muted">
                This deletes the sealed session, the vault profile and cached previews on this
                device. Encrypted files remain in Telegram but become unreadable without the old
                passphrase.
              </p>
              <div className="mt-3 flex gap-2">
                <Button size="sm" variant="danger" onClick={() => void auth.reset()}>
                  Reset everything
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setResetArmed(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setResetArmed(true)}
              className="text-xs font-medium text-muted underline-offset-4 hover:text-ink hover:underline"
            >
              Forgot passphrase? Sign in with a different account
            </button>
          )}
        </div>
      </div>,
    );
  }

  if (auth.status === 'vault') {
    const creating = auth.vaultMode === 'create';
    return shell(
      <div>
        <StepDots step={2} />
        <div className="mb-6 flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-soft text-accent">
          <ShieldCheck size={22} />
        </div>
        <h2 className="text-2xl font-semibold tracking-tight text-ink">
          {creating ? 'Create your vault key' : 'Unlock your existing vault'}
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          {creating
            ? 'Telegram is connected. Choose a passphrase to seal your session and encrypt every upload.'
            : 'This account already has a vault. Enter its passphrase to seal the new Telegram session.'}
        </p>
        <ErrorBanner message={error} onDismiss={clearError} />
        <form onSubmit={submitVault} className="mt-6 space-y-4">
          <SecretField
            label="Vault passphrase"
            value={passphrase}
            onChange={setPassphrase}
            autoComplete={creating ? 'new-password' : 'current-password'}
            autoFocus
            placeholder="At least 8 characters"
          />
          {creating ? (
            <>
              <SecretField
                label="Confirm passphrase"
                value={confirmation}
                onChange={setConfirmation}
                autoComplete="new-password"
                placeholder="Repeat the passphrase"
              />
              <label className="flex items-start gap-3 rounded-xl border border-line bg-surface/60 p-3.5 text-xs leading-relaxed text-muted">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(event) => setAcknowledged(event.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-line accent-[var(--accent)]"
                />
                <span>
                  I understand that losing this passphrase means losing access to vault media, and
                  that there is no recovery server.
                </span>
              </label>
            </>
          ) : (
            <p className="text-xs leading-relaxed text-muted">{VAULT_PASSPHRASE_HINT}</p>
          )}
          <Button type="submit" size="lg" className="w-full" disabled={auth.busy}>
            {auth.busy ? <Spinner size={17} /> : <Lock size={17} />}
            {auth.busy ? 'Securing session…' : creating ? 'Create vault & finish' : 'Unlock & finish'}
          </Button>
        </form>
      </div>,
    );
  }

  if (auth.status === 'connecting') {
    const stage = auth.stage;
    return shell(
      <div>
        <StepDots step={1} />
        <div className="mb-6 flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-soft text-accent">
          {stage.kind === 'qr' ? <QrCode size={22} /> : <Smartphone size={22} />}
        </div>

        {stage.kind === 'qr' ? (
          <>
            <h2 className="text-2xl font-semibold tracking-tight text-ink">Scan to sign in</h2>
            <p className="mb-6 mt-2 text-sm text-muted">
              Open Telegram on your phone → Settings → Devices → Link Desktop Device
            </p>
            <QRCodeCanvas url={stage.url} expiresAt={stage.expiresAt} />
          </>
        ) : null}

        {stage.kind === 'code' ? (
          <>
            <h2 className="text-2xl font-semibold tracking-tight text-ink">Enter your code</h2>
            <p className="mb-6 mt-2 text-sm text-muted">
              {stage.hint ?? 'Telegram just sent you a login code.'}
            </p>
            <ErrorBanner message={error} onDismiss={clearError} />
            <form onSubmit={submitCode} className="space-y-4">
              <Field label="Login code">
                <input
                  className={`${inputClass} text-center text-lg tracking-[0.4em]`}
                  value={code}
                  onChange={(event) => setCode(event.target.value.replace(/\s/g, ''))}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  autoFocus
                  placeholder="12345"
                  maxLength={10}
                />
              </Field>
              <Button type="submit" size="lg" className="w-full" disabled={code.trim().length < 3}>
                <ArrowRight size={17} /> Continue
              </Button>
            </form>
          </>
        ) : null}

        {stage.kind === 'password' ? (
          <>
            <h2 className="text-2xl font-semibold tracking-tight text-ink">Two-step verification</h2>
            <p className="mb-6 mt-2 text-sm text-muted">
              {stage.hint ?? 'This account is protected by a cloud password.'}
            </p>
            <ErrorBanner message={error} onDismiss={clearError} />
            <form onSubmit={submitPassword} className="space-y-4">
              <SecretField
                label="Telegram password"
                value={password}
                onChange={setPassword}
                autoComplete="current-password"
                autoFocus
                placeholder="Cloud password"
              />
              <Button type="submit" size="lg" className="w-full" disabled={password.length === 0}>
                <ArrowRight size={17} /> Sign in
              </Button>
            </form>
          </>
        ) : null}

        {stage.kind === 'connecting' || stage.kind === 'idle' ? (
          <>
            <h2 className="text-2xl font-semibold tracking-tight text-ink">Connecting…</h2>
            <p className="mt-2 flex items-center gap-2 text-sm text-muted">
              <Spinner size={15} /> Opening an MTProto socket to Telegram.
            </p>
          </>
        ) : null}

        {stage.kind === 'error' ? (
          <>
            <h2 className="text-2xl font-semibold tracking-tight text-ink">Sign-in failed</h2>
            <ErrorBanner message={stage.message} onDismiss={clearError} />
          </>
        ) : null}

        <div className="mt-8 flex items-center justify-between">
          <button
            type="button"
            onClick={() => auth.cancelLogin()}
            className="text-xs font-medium text-muted underline-offset-4 hover:text-ink hover:underline"
          >
            Cancel and start over
          </button>
          <span className="flex items-center gap-1.5 text-xs text-muted">
            <Lock size={12} /> End-to-end with Telegram
          </span>
        </div>
      </div>,
    );
  }

  // Onboarding / login form.
  return shell(
    <div>
      <StepDots step={1} />
      <h2 className="text-2xl font-semibold tracking-tight text-ink">Connect your Telegram</h2>
      <p className="mt-2 text-sm leading-relaxed text-muted">
        Sign in with your own account. There is no bot, no token, and no server in between.
      </p>

      <ErrorBanner message={error} onDismiss={clearError} />

      <form onSubmit={submitLogin} className="mt-6 space-y-4">
        <div className="grid grid-cols-2 gap-2 rounded-full bg-surface p-1">
          {(
            [
              ['phone', 'Phone number', Smartphone],
              ['qr', 'QR code', QrCode],
            ] as const
          ).map(([value, label, Icon]) => (
            <button
              key={value}
              type="button"
              onClick={() => setMethod(value)}
              className={`flex h-10 items-center justify-center gap-2 rounded-full text-sm font-medium transition-colors ${
                method === value ? 'bg-elevated text-ink shadow-sm' : 'text-muted hover:text-ink'
              }`}
            >
              <Icon size={15} /> {label}
            </button>
          ))}
        </div>

        {method === 'phone' ? (
          <Field label="Phone number" hint="International format, for example +1 415 555 0132.">
            <input
              className={inputClass}
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              inputMode="tel"
              autoComplete="tel"
              placeholder="+1 415 555 0132"
            />
          </Field>
        ) : (
          <p className="rounded-xl border border-line bg-surface/50 px-4 py-3 text-xs leading-relaxed text-muted">
            Open Telegram on your phone → Settings → Devices → Link Desktop Device
          </p>
        )}

        <Button type="submit" size="lg" className="w-full" disabled={auth.busy}>
          {auth.busy ? <Spinner size={17} /> : <ArrowRight size={17} />}
          {method === 'phone' ? 'Send login code' : 'Show QR code'}
        </Button>

        {/* Self-hosters only: deliberately quiet and collapsed. */}
        {!hasEnvCredentials ? (
          <details className="rounded-lg px-1 pt-2 text-[11px] text-muted/70">
            <summary className="cursor-pointer list-none underline-offset-2 hover:text-muted hover:underline">
              Advanced: Custom API ID
            </summary>
            <div className="mt-2 space-y-3">
              <Field label="api_id">
                <input
                  className={inputClass}
                  value={apiId}
                  onChange={(event) => setApiId(event.target.value.replace(/[^0-9]/g, ''))}
                  inputMode="numeric"
                  placeholder="12345678"
                  autoComplete="off"
                />
              </Field>
              <Field label="api_hash">
                <input
                  className={inputClass}
                  value={apiHash}
                  onChange={(event) => setApiHash(event.target.value.trim())}
                  placeholder="0123456789abcdef0123456789abcdef"
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>
              <p className="text-xs leading-relaxed text-muted">
                For self-hosted copies. Create an app at{' '}
                <a
                  href={API_CREDENTIALS_HELP_URL}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-accent underline-offset-2 hover:underline"
                >
                  my.telegram.org/apps
                </a>
                ; the values stay in this browser.
              </p>
            </div>
          </details>
        ) : null}
      </form>

      <p className="mt-6 text-center text-[11px] leading-relaxed text-muted">
        By continuing you confirm you are allowed to access the selected channels. PicPocket is
        an independent open-source project, not affiliated with Telegram or Google.
      </p>
    </div>,
  );
}
