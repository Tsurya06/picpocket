import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AuthStatus,
  LoginStage,
  TelegramCredentials,
  VaultHeaderChoice,
} from '../types/telegram';
import { isVaultRecovery, type TelegramAccount, type VaultProfile, type VaultRecovery } from '../types/media';
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
  readonly vaultChoices: readonly VaultHeaderChoice[];
  /** True after every candidate key rejected the entered passphrase. */
  readonly vaultFallback: boolean;
  /** Shown once after a new vault key is created, before setup finishes. */
  readonly recoverySetup: { readonly words: string; readonly recovery: VaultRecovery } | null;
}

const initialState: AuthState = {
  status: 'booting',
  account: null,
  profile: null,
  stage: { kind: 'idle' },
  error: null,
  busy: false,
  vaultMode: 'create',
  vaultChoices: [],
  vaultFallback: false,
  recoverySetup: null,
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
  confirmVaultRecovery: () => Promise<void>;
  cancelVaultRecovery: () => Promise<void>;
  unlock: (passphrase: string) => Promise<void>;
  resetPassphraseWithRecovery: (words: string, passphrase: string) => Promise<boolean>;
  lock: () => Promise<void>;
  reset: () => Promise<void>;
  /** Forgot-passphrase path: wipe local state and start a brand new vault. */
  startOver: () => Promise<void>;
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
  'The vault passphrase protects your Telegram session. If you set up a 24-word recovery phrase, those words can unlock it when the passphrase is forgotten.';

const normalizeProfile = (profile: VaultProfile | null): VaultProfile | null => {
  if (!profile?.recovery || isVaultRecovery(profile.recovery)) return profile;
  const { recovery: _recovery, ...rest } = profile;
  return rest;
};

export function useTelegramAuth(): AuthController {
  const [state, setState] = useState<AuthState>(initialState);
  const profileRef = useRef<VaultProfile | null>(null);
  /** Every remote header found at sign-in, kept for automatic matching. */
  const vaultChoicesRef = useRef<readonly VaultHeaderChoice[]>([]);
  const pendingSessionRef = useRef<string | null>(null);
  const credentialsRef = useRef<TelegramCredentials | null>(null);
  /** Set after "forgot passphrase" so a remote header cannot force unlock mode. */
  const skipRemoteVaultRef = useRef(false);
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
        const [storedProfile, sealed] = await Promise.all([loadVaultProfile(), loadSealedSession()]);
        if (cancelled) return;
        const profile = normalizeProfile(storedProfile ?? null);
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
        vaultChoices: [],
        vaultFallback: false,
        recoverySetup: null,
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
        let profile = normalizeProfile(profileRef.current ?? (await loadVaultProfile()) ?? null);
        let vaultChoices: readonly VaultHeaderChoice[] = [];

        // Collect every published header so the entered passphrase, not the
        // user, decides which vault key this device should adopt.
        if (!skipRemoteVaultRef.current) {
          try {
            const found = await telegramService.findVaultHeaders();
            if (loginAttemptRef.current !== attempt) return;
            // Keep every key as a candidate; the passphrase decides which one
            // to adopt, so the user never has to choose between headers.
            vaultChoices = found;
          } catch {
            // No header or no search permission: fall back to create mode.
          }
          if (loginAttemptRef.current !== attempt) return;
        }

        profileRef.current = profile;
        vaultChoicesRef.current = vaultChoices;
        patch({
          status: 'vault',
          vaultMode: profile || vaultChoices.length > 0 ? 'unlock' : 'create',
          profile,
          vaultChoices,
          vaultFallback: false,
          recoverySetup: null,
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
        const { words, recovery } = await cryptoClient.createRecovery(salt);
        const profile: VaultProfile = {
          salt,
          verifier,
          iterations: 600_000,
          createdAt: Date.now(),
          recovery,
        };
        profileRef.current = profile;
        vaultChoicesRef.current = [];
        patch({
          status: 'vault',
          profile,
          busy: false,
          vaultChoices: [],
          vaultFallback: false,
          recoverySetup: { words, recovery },
          error: null,
          stage: { kind: 'success' },
        });
      } catch (error) {
        await cryptoClient.lock();
        profileRef.current = null;
        patch({ busy: false, error: describeError(error) });
      }
    },
    [patch],
  );

  const confirmVaultRecovery = useCallback(async (): Promise<void> => {
    const profile = profileRef.current;
    const credentials = credentialsRef.current;
    if (!profile || !state.recoverySetup || !credentials || !pendingSessionRef.current) {
      patch({ error: 'Sign in again to finish setting up the vault.' });
      return;
    }
    patch({ busy: true, error: null });
    try {
      await saveVaultProfile(profile);
      await sealPendingSession(credentials);
      patch({
        status: 'ready',
        profile,
        busy: false,
        vaultChoices: [],
        vaultFallback: false,
        recoverySetup: null,
        stage: { kind: 'success' },
        error: null,
      });
    } catch (error) {
      patch({ busy: false, error: describeError(error) });
    }
  }, [patch, sealPendingSession, state.recoverySetup]);

  const cancelVaultRecovery = useCallback(async (): Promise<void> => {
    await cryptoClient.lock();
    profileRef.current = null;
    patch({
      profile: null,
      busy: false,
      recoverySetup: null,
      error: 'Vault setup was cancelled. Create a passphrase to try again.',
    });
  }, [patch]);

  const unlock = useCallback(
    async (passphrase: string) => {
      if (passphrase.length < 8) {
        patch({ error: 'The vault passphrase must be at least 8 characters.' });
        return;
      }

      const profile = normalizeProfile(profileRef.current ?? (await loadVaultProfile()) ?? null);
      let choices = vaultChoicesRef.current;

      // A fresh login already searched Telegram. If that search was skipped,
      // do it now while the new session is still available to compare keys.
      if (choices.length === 0 && pendingSessionRef.current && !skipRemoteVaultRef.current) {
        try {
          choices = await telegramService.findVaultHeaders();
          vaultChoicesRef.current = choices;
        } catch {
          // Network or search failure: the local profile can still unlock.
        }
      }

      const candidates: VaultProfile[] = [];
      if (profile) candidates.push(profile);
      for (const choice of choices) {
        const exists = candidates.some(
          (candidate) =>
            candidate.salt === choice.saltB64 && candidate.verifier === choice.verifierB64,
        );
        if (exists) continue;
        candidates.push({
          salt: choice.saltB64,
          verifier: choice.verifierB64,
          iterations: 600_000,
          createdAt: choice.date,
          ...(choice.recovery ? { recovery: choice.recovery } : {}),
          ...(choice.passphraseWrap ? { passphraseWrap: choice.passphraseWrap } : {}),
        });
      }

      if (candidates.length === 0) {
        patch({ status: 'onboarding', error: 'No vault exists yet. Sign in to create one.' });
        return;
      }

      patch({ busy: true, error: null, vaultChoices: choices, vaultFallback: false });
      try {
        // Try the local profile first, then every published header. Only a key
        // whose verifier accepts this passphrase becomes the active profile.
        let matched: VaultProfile | null = null;
        let lastError: unknown = null;
        const wordCount = passphrase.trim().split(/\s+/).filter(Boolean).length;
        const recoveryInput = wordCount === 24;
        for (const candidate of candidates) {
          try {
            const result = candidate.recovery && recoveryInput
              ? await cryptoClient.unlockWithRecovery(
                  passphrase,
                  candidate.recovery,
                  candidate.salt,
                  candidate.verifier,
                )
              : await cryptoClient.unlock(passphrase, {
                  salt: candidate.salt,
                  verifier: candidate.verifier,
                  ...(candidate.passphraseWrap
                    ? { passphraseWrap: candidate.passphraseWrap }
                    : {}),
                });
            matched = {
              salt: result.salt,
              verifier: result.verifier,
              iterations: candidate.iterations,
              createdAt: candidate.createdAt,
              ...(candidate.recovery ? { recovery: candidate.recovery } : {}),
              ...(candidate.passphraseWrap ? { passphraseWrap: candidate.passphraseWrap } : {}),
            };
            break;
          } catch (caught) {
            lastError = caught;
            if (recoveryInput && candidate.recovery) {
              try {
                const result = await cryptoClient.unlock(passphrase, {
                  salt: candidate.salt,
                  verifier: candidate.verifier,
                  ...(candidate.passphraseWrap
                    ? { passphraseWrap: candidate.passphraseWrap }
                    : {}),
                });
                matched = {
                  salt: result.salt,
                  verifier: result.verifier,
                  iterations: candidate.iterations,
                  createdAt: candidate.createdAt,
                  ...(candidate.recovery ? { recovery: candidate.recovery } : {}),
                  ...(candidate.passphraseWrap
                    ? { passphraseWrap: candidate.passphraseWrap }
                    : {}),
                };
                break;
              } catch (fallback) {
                lastError = fallback;
              }
            }
          }
        }

        if (!matched) {
          patch({
            busy: false,
            vaultFallback: choices.length > 0,
            error:
              recoveryInput && candidates.length > 1
                ? `That 24-word recovery phrase did not match any of the ${candidates.length} vault keys found in this account.`
                : recoveryInput
                  ? describeError(lastError)
                  : candidates.length > 1
                ? `That passphrase did not match any of the ${candidates.length} vault keys found in this account.`
                : describeError(lastError),
          });
          return;
        }

        await saveVaultProfile(matched);

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
            profileRef.current = matched;
            patch({
              status: 'ready',
              profile: matched,
              account,
              busy: false,
              vaultChoices: [],
              vaultFallback: false,
              recoverySetup: null,
              stage: { kind: 'success' },
            });
            vaultChoicesRef.current = [];
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
          profileRef.current = matched;
          patch({
            status: account ? 'ready' : 'onboarding',
            profile: matched,
            account,
            busy: false,
            vaultChoices: [],
            vaultFallback: false,
            recoverySetup: null,
            stage: { kind: 'success' },
          });
          vaultChoicesRef.current = [];
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

  const resetPassphraseWithRecovery = useCallback(
    async (words: string, passphrase: string): Promise<boolean> => {
      if (passphrase.length < 8) {
        patch({ error: 'Choose a new passphrase with at least 8 characters.' });
        return false;
      }

      patch({ busy: true, error: null });
      try {
        const profile = normalizeProfile(profileRef.current ?? (await loadVaultProfile()) ?? null);
        let choices = vaultChoicesRef.current;
        if (choices.length === 0 && pendingSessionRef.current && !skipRemoteVaultRef.current) {
          try {
            choices = await telegramService.findVaultHeaders();
            vaultChoicesRef.current = choices;
          } catch {
            // The local profile can still recover offline.
          }
        }

        const candidates: VaultProfile[] = [];
        if (profile) candidates.push(profile);
        for (const choice of choices) {
          if (
            candidates.some(
              (candidate) =>
                candidate.salt === choice.saltB64 && candidate.verifier === choice.verifierB64,
            )
          ) {
            continue;
          }
          candidates.push({
            salt: choice.saltB64,
            verifier: choice.verifierB64,
            iterations: 600_000,
            createdAt: choice.date,
            ...(choice.recovery ? { recovery: choice.recovery } : {}),
            ...(choice.passphraseWrap ? { passphraseWrap: choice.passphraseWrap } : {}),
          });
        }

        let matched: VaultProfile | null = null;
        let lastError: unknown = null;
        for (const candidate of candidates) {
          if (!candidate.recovery) continue;
          try {
            await cryptoClient.unlockWithRecovery(
              words,
              candidate.recovery,
              candidate.salt,
              candidate.verifier,
            );
            matched = candidate;
            break;
          } catch (caught) {
            lastError = caught;
          }
        }

        if (!matched) {
          patch({ busy: false, error: describeError(lastError) });
          return false;
        }

        const passphraseWrap = await cryptoClient.wrapPassphrase(passphrase);
        const next: VaultProfile = { ...matched, passphraseWrap };
        await saveVaultProfile(next);
        profileRef.current = next;
        patch({ profile: next });

        // Completes the normal unlock path using the new passphrase.
        await unlock(passphrase);

        // Publish the new wrapper so another device can use the new passphrase.
        try {
          const headers = await telegramService.findVaultHeaders();
          for (const header of headers) {
            if (header.saltB64 !== next.salt || header.verifierB64 !== next.verifier) continue;
            await telegramService.publishChannelHeader(header.channelId, {
              v: 1,
              saltB64: next.salt,
              verifierB64: next.verifier,
              ...(next.recovery ? { recovery: next.recovery } : {}),
              passphraseWrap,
            });
          }
        } catch {
          // Local passphrase reset succeeded; header sync can happen later.
        }
        return Boolean(telegramService.currentAccount);
      } catch (error) {
        patch({ busy: false, error: describeError(error) });
        return false;
      }
    },
    [patch, unlock],
  );

  const lock = useCallback(async () => {
    await cryptoClient.lock();
    telegramService.dispose();
    pendingSessionRef.current = null;
    // Clear API credentials from memory on lock so they are not accessible
    // while the vault is locked. They are re-hydrated on the next unlock.
    credentialsRef.current = null;
    setState((current) => ({
      ...current,
      status: current.profile ? 'locked' : 'onboarding',
      account: null,
      busy: false,
      recoverySetup: null,
      stage: { kind: 'idle' },
    }));
  }, []);

  const reset = useCallback(async () => {
    await cryptoClient.lock();
    telegramService.dispose();
    await resetLocalData();
    profileRef.current = null;
    vaultChoicesRef.current = [];
    pendingSessionRef.current = null;
    credentialsRef.current = null;
    skipRemoteVaultRef.current = false;
    setState({ ...initialState, status: 'onboarding', vaultMode: 'create' });
  }, []);

  const startOver = useCallback(async () => {
    await cryptoClient.lock();
    telegramService.dispose();
    await resetLocalData();
    profileRef.current = null;
    vaultChoicesRef.current = [];
    pendingSessionRef.current = null;
    credentialsRef.current = null;
    // The old vault header stays in Telegram, so ignore it on the next login
    // and let the user create a new passphrase from scratch.
    skipRemoteVaultRef.current = true;
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
    confirmVaultRecovery,
    cancelVaultRecovery,
    unlock,
    resetPassphraseWithRecovery,
    lock,
    reset,
    startOver,
    clearError,
  };
}

export const VAULT_PASSPHRASE_HINT = PLAINTEXT_MESSAGE;
