import { useCallback, useEffect, useRef, useState } from 'react';
import type { AuthStatus, LoginStage, TelegramCredentials } from '../types/telegram';
import type { TelegramAccount, VaultProfile } from '../types/media';
import {
  clearSealedSession,
  loadSealedSession,
  loadVaultProfile,
  resetLocalData,
  saveSealedSession,
  saveVaultProfile,
  type SessionSecret,
} from '../services/cache/db';
import {
  arrayBufferToText,
  base64ToBytes,
  bytesToBase64,
  textToArrayBuffer,
} from '../services/crypto/encoding';
import { cryptoClient } from '../services/crypto/cryptoClient';
import { describeError, telegramService } from '../services/telegram/mtprotoClient';

/** After login, the app either creates a vault or unlocks an existing one. */
export type VaultSetupMode = 'create' | 'unlock';

interface AuthState {
  readonly status: AuthStatus;
  readonly account: TelegramAccount | null;
  readonly profile: VaultProfile | null;
  readonly stage: LoginStage;
  readonly error: string | null;
  readonly busy: boolean;
  readonly vaultMode: VaultSetupMode;
}

const initialState: AuthState = {
  status: 'booting',
  account: null,
  profile: null,
  stage: { kind: 'idle' },
  error: null,
  busy: false,
  vaultMode: 'create',
};

export interface LoginInput {
  readonly apiId: number;
  readonly apiHash: string;
  readonly mode: 'phone' | 'qr';
  readonly phone?: string;
}

export interface AuthController extends AuthState {
  beginLogin: (input: LoginInput) => Promise<void>;
  submitCode: (code: string) => void;
  submitPassword: (password: string) => void;
  cancelLogin: () => void;
  createVault: (passphrase: string) => Promise<void>;
  unlock: (passphrase: string) => Promise<void>;
  lock: () => Promise<void>;
  reset: () => Promise<void>;
  clearError: () => void;
}

const parseSecret = (raw: string): SessionSecret => {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Stored session is corrupted.');
  }
  const candidate = parsed as Record<string, unknown>;
  if (
    typeof candidate.session !== 'string' ||
    typeof candidate.apiId !== 'number' ||
    typeof candidate.apiHash !== 'string'
  ) {
    throw new Error('Stored session is corrupted.');
  }
  return {
    session: candidate.session,
    apiId: candidate.apiId,
    apiHash: candidate.apiHash,
  };
};

const PLAINTEXT_MESSAGE =
  'The vault passphrase protects your Telegram session. Use at least 8 characters — there is no recovery if you lose it.';

export function useTelegramAuth(): AuthController {
  const [state, setState] = useState<AuthState>(initialState);
  const profileRef = useRef<VaultProfile | null>(null);
  const pendingSessionRef = useRef<string | null>(null);
  const credentialsRef = useRef<TelegramCredentials | null>(null);
  /** Invalidates callbacks from a login attempt that was cancelled or replaced. */
  const loginAttemptRef = useRef(0);

  const patch = useCallback((next: Partial<AuthState>) => {
    setState((current) => ({ ...current, ...next }));
  }, []);

  useEffect(() => {
    // Intentionally not guarded by a ref: StrictMode runs effects twice, and a
    // ref guard would let the first cleanup cancel the only boot attempt.
    let cancelled = false;
    void (async () => {
      try {
        const [profile, sealed] = await Promise.all([loadVaultProfile(), loadSealedSession()]);
        if (cancelled) return;
        profileRef.current = profile ?? null;
        if (profile && sealed) {
          patch({ status: 'locked', profile, stage: { kind: 'idle' } });
        } else {
          patch({ status: 'onboarding', profile: profile ?? null, stage: { kind: 'idle' } });
        }
      } catch (error) {
        if (!cancelled) {
          patch({
            status: 'onboarding',
            error: `Local storage is unavailable: ${describeError(error)}`,
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [patch]);

  const sealPendingSession = useCallback(async (credentials: TelegramCredentials): Promise<void> => {
    const session = pendingSessionRef.current;
    if (!session) throw new Error('No Telegram session is available to protect.');
    const secret: SessionSecret = {
      session,
      apiId: credentials.apiId,
      apiHash: credentials.apiHash,
    };
    const sealed = await cryptoClient.encryptBytes(textToArrayBuffer(JSON.stringify(secret)));
    await saveSealedSession(bytesToBase64(new Uint8Array(sealed)));
    pendingSessionRef.current = null;
  }, []);

  const beginLogin = useCallback(
    async (input: LoginInput) => {
      const attempt = loginAttemptRef.current + 1;
      loginAttemptRef.current = attempt;
      const credentials: TelegramCredentials = { apiId: input.apiId, apiHash: input.apiHash };
      credentialsRef.current = credentials;
      patch({
        status: 'connecting',
        busy: true,
        error: null,
        stage: { kind: 'connecting' },
      });

      try {
        const { account, session } = await telegramService.login({
          credentials,
          mode: input.mode,
          phone: input.phone,
          onStage: (stage) => {
            if (loginAttemptRef.current !== attempt) return;
            setState((current) => {
              if (stage.kind === 'error') return { ...current, stage, error: stage.message };
              return { ...current, stage };
            });
          },
        });

        if (loginAttemptRef.current !== attempt) return;
        pendingSessionRef.current = session;
        const profile = profileRef.current ?? (await loadVaultProfile()) ?? null;
        profileRef.current = profile;
        patch({
          status: 'vault',
          vaultMode: profile ? 'unlock' : 'create',
          profile,
          account,
          busy: false,
          stage: { kind: 'success' },
          error: null,
        });
      } catch (error) {
        if (loginAttemptRef.current !== attempt) return;
        patch({
          status: 'onboarding',
          busy: false,
          error: describeError(error),
          stage: { kind: 'idle' },
        });
      }
    },
    [patch],
  );

  const submitCode = useCallback((code: string) => {
    telegramService.submitCode(code);
  }, []);

  const submitPassword = useCallback((password: string) => {
    telegramService.submitPassword(password);
  }, []);

  const cancelLogin = useCallback(() => {
    loginAttemptRef.current += 1;
    telegramService.cancelLogin();
    patch({ status: 'onboarding', busy: false, stage: { kind: 'idle' } });
  }, [patch]);

  const createVault = useCallback(
    async (passphrase: string) => {
      if (passphrase.length < 8) {
        patch({ error: 'Choose a passphrase with at least 8 characters.' });
        return;
      }
      const credentials = credentialsRef.current;
      if (!credentials || !pendingSessionRef.current) {
        patch({ status: 'onboarding', error: 'Sign in again to finish setting up the vault.' });
        return;
      }

      patch({ busy: true, error: null });
      try {
        const { salt, verifier } = await cryptoClient.unlock(passphrase);
        const profile: VaultProfile = {
          salt,
          verifier,
          iterations: 600_000,
          createdAt: Date.now(),
        };
        await saveVaultProfile(profile);
        await sealPendingSession(credentials);
        profileRef.current = profile;
        patch({ status: 'ready', profile, busy: false, stage: { kind: 'success' } });
      } catch (error) {
        patch({ busy: false, error: describeError(error) });
      }
    },
    [patch, sealPendingSession],
  );

  const unlock = useCallback(
    async (passphrase: string) => {
      const profile = profileRef.current ?? (await loadVaultProfile()) ?? null;
      if (!profile) {
        patch({ status: 'onboarding', error: 'No vault exists yet. Sign in to create one.' });
        return;
      }

      patch({ busy: true, error: null });
      try {
        await cryptoClient.unlock(passphrase, { salt: profile.salt, verifier: profile.verifier });

        // Case 1: a sealed session exists → restore it.
        const sealed = await loadSealedSession();
        if (sealed) {
          const plaintext = await cryptoClient.decryptBytes(
            base64ToBytes(sealed).buffer as ArrayBuffer,
          );
          const secret = parseSecret(arrayBufferToText(plaintext));
          credentialsRef.current = { apiId: secret.apiId, apiHash: secret.apiHash };
          try {
            const account = await telegramService.connectWithSession(
              { apiId: secret.apiId, apiHash: secret.apiHash },
              secret.session,
            );
            profileRef.current = profile;
            patch({ status: 'ready', profile, account, busy: false, stage: { kind: 'success' } });
          } catch (error) {
            // The MTProto session was revoked or expired: keep the vault, drop the session.
            await clearSealedSession();
            patch({
              status: 'onboarding',
              account: null,
              busy: false,
              error: `${describeError(error)} Sign in again; your vault passphrase stays the same.`,
            });
          }
          return;
        }

        // Case 2: logged in moments ago, vault exists, session not yet sealed.
        if (credentialsRef.current && pendingSessionRef.current) {
          await sealPendingSession(credentialsRef.current);
          const account = telegramService.currentAccount;
          profileRef.current = profile;
          patch({
            status: account ? 'ready' : 'onboarding',
            profile,
            account,
            busy: false,
            stage: { kind: 'success' },
          });
          return;
        }

        patch({
          status: 'onboarding',
          busy: false,
          error: 'Sign in again to restore your encrypted session.',
        });
      } catch (error) {
        patch({ busy: false, error: describeError(error) });
      }
    },
    [patch, sealPendingSession],
  );

  const lock = useCallback(async () => {
    await cryptoClient.lock();
    telegramService.dispose();
    pendingSessionRef.current = null;
    setState((current) => ({
      ...current,
      status: current.profile ? 'locked' : 'onboarding',
      account: null,
      busy: false,
      stage: { kind: 'idle' },
    }));
  }, []);

  const reset = useCallback(async () => {
    await cryptoClient.lock();
    telegramService.dispose();
    await resetLocalData();
    profileRef.current = null;
    pendingSessionRef.current = null;
    credentialsRef.current = null;
    setState({ ...initialState, status: 'onboarding', vaultMode: 'create' });
  }, []);

  const clearError = useCallback(() => patch({ error: null }), [patch]);

  return {
    ...state,
    beginLogin,
    submitCode,
    submitPassword,
    cancelLogin,
    createVault,
    unlock,
    lock,
    reset,
    clearError,
  };
}

export const VAULT_PASSPHRASE_HINT = PLAINTEXT_MESSAGE;
