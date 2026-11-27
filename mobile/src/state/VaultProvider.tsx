import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  getJsonSetting,
  getSetting,
  removeSetting,
  setJsonSetting,
  setSetting,
} from '../lib/db';
import { vault } from '../lib/crypto/vault';
import { bytesToUtf8, fromBase64, toBase64, utf8ToBytes } from '../lib/encoding';
import {
  telegramService,
  type ChannelSummary,
  type TelegramAccount,
  type TelegramCredentials,
} from '../lib/telegram/service';
import {
  normalizeMediaSelection,
  NO_MEDIA_SELECTION,
  type WhatsAppMediaSelection,
} from '../lib/whatsapp/types';
import { DEFAULT_SYNC_TIME, normalizeSyncTime } from '../lib/schedule';

export type Stage = 'loading' | 'credentials' | 'unlock' | 'login' | 'ready';

interface VaultProfile {
  readonly saltB64: string;
  readonly verifierB64: string;
}

interface ChannelChoice {
  readonly id: string;
  readonly title: string;
}

interface FolderChoice {
  readonly uri: string;
  readonly name: string;
}

interface VaultContextValue {
  readonly stage: Stage;
  readonly busy: boolean;
  readonly error: string | null;
  readonly info: string | null;
  readonly hasVault: boolean;
  readonly account: TelegramAccount | null;
  readonly channels: readonly ChannelSummary[];
  readonly channel: ChannelChoice | null;
  readonly folder: FolderChoice | null;
  readonly media: WhatsAppMediaSelection;
  readonly autoSync: boolean;
  readonly scheduleTime: string;
  readonly lastSyncAt: number | null;
  saveCredentials: (apiId: number, apiHash: string) => Promise<void>;
  unlockVault: (passphrase: string, mode: 'create' | 'unlock') => Promise<void>;
  sendLoginCode: (phone: string) => Promise<{ authorized: boolean }>;
  submitLoginCode: (code: string) => Promise<{ passwordNeeded: boolean }>;
  submitLoginPassword: (password: string) => Promise<void>;
  refreshChannels: () => Promise<void>;
  selectChannel: (choice: ChannelChoice) => Promise<void>;
  saveFolder: (choice: FolderChoice | null) => Promise<void>;
  setMedia: (next: WhatsAppMediaSelection) => void;
  setAutoSync: (enabled: boolean) => Promise<void>;
  setScheduleTime: (time: string) => Promise<void>;
  markSynced: () => Promise<void>;
  lock: () => Promise<void>;
  signOut: () => Promise<void>;
  clearMessages: () => void;
}

const VaultContext = createContext<VaultContextValue | null>(null);

const cipherErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message) return error.message;
  return 'Something went wrong. Please try again.';
};

export function VaultProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [stage, setStage] = useState<Stage>('loading');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [hasVault, setHasVault] = useState(false);
  const [account, setAccount] = useState<TelegramAccount | null>(null);
  const [channels, setChannels] = useState<readonly ChannelSummary[]>([]);
  const [channel, setChannel] = useState<ChannelChoice | null>(null);
  const [folder, setFolder] = useState<FolderChoice | null>(null);
  const [media, setMediaState] = useState<WhatsAppMediaSelection>(NO_MEDIA_SELECTION);
  const [autoSync, setAutoSyncState] = useState(false);
  const [scheduleTime, setScheduleTimeState] = useState(DEFAULT_SYNC_TIME);
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);

  const readCredentials = useCallback(
    () => getJsonSetting<TelegramCredentials>('creds'),
    [],
  );

  const ensureVaultHeader = useCallback(async (channelId: string): Promise<void> => {
    const profile = await getJsonSetting<VaultProfile>('vaultProfile');
    if (!profile) return;
    const existing = await telegramService.findChannelHeader(channelId);
    if (existing) {
      const matched = await vault.syncChannelHeader(
        channelId,
        existing.header.saltB64,
        existing.header.verifierB64,
      );
      if (matched) return;
      // The channel belongs to another vault. Keep the app usable read-only.
      throw new Error(
        'This channel is locked with a different vault passphrase. Pick another channel.',
      );
    }
    await telegramService.publishChannelHeader(channelId, {
      v: 1,
      saltB64: profile.saltB64,
      verifierB64: profile.verifierB64,
    });
  }, []);

  const loadChannels = useCallback(
    async (preferred: ChannelChoice | null): Promise<void> => {
      const list = await telegramService.listChannels();
      setChannels(list);
      const saved = preferred ?? (await getJsonSetting<ChannelChoice>('channel'));
      if (saved && list.some((entry) => entry.id === saved.id)) {
        setChannel(saved);
        setInfo(null);
        return;
      }
      // Only a channel the account can post to is a usable vault: publishing
      // the header into a read-only channel used to abort the whole login.
      const fallback =
        list.find((entry) => entry.isCreator) ??
        list.find((entry) => entry.isAdmin) ??
        list[0];
      if (fallback) {
        const choice = { id: fallback.id, title: fallback.title };
        setChannel(choice);
        await setJsonSetting('channel', choice);
        try {
          await ensureVaultHeader(choice.id);
          setInfo(null);
        } catch (failure) {
          setChannel(null);
          await removeSetting('channel');
          setInfo(
            `Could not use "${fallback.title}" for the vault (${cipherErrorMessage(failure)}). Pick a channel you own in Settings.`,
          );
        }
      }
    },
    [ensureVaultHeader],
  );

  const boot = useCallback(async (): Promise<void> => {
    const credentials = await readCredentials();
    const profile = await getJsonSetting<VaultProfile>('vaultProfile');
    setHasVault(profile !== null);
    setMediaState(normalizeMediaSelection(await getJsonSetting('media')));
    setAutoSyncState((await getSetting('autoSync')) === '1');
    setScheduleTimeState(normalizeSyncTime((await getSetting('syncTime')) ?? DEFAULT_SYNC_TIME));
    const sync = await getSetting('lastSyncAt');
    setLastSyncAt(sync ? Number(sync) : null);
    setFolder(await getJsonSetting<FolderChoice>('folder'));

    if (!credentials) {
      setStage('credentials');
      return;
    }
    setStage('unlock');
  }, [readCredentials]);

  useEffect(() => {
    void boot().catch((failure: unknown) => {
      setError(cipherErrorMessage(failure));
      setStage('credentials');
    });
  }, [boot]);

  const saveCredentials = useCallback(async (apiId: number, apiHash: string): Promise<void> => {
    if (!Number.isFinite(apiId) || apiId <= 0 || apiHash.trim().length < 10) {
      throw new Error('Enter the api_id (numbers) and api_hash from my.telegram.org.');
    }
    await setJsonSetting('creds', { apiId, apiHash: apiHash.trim() });
    const profile = await getJsonSetting<VaultProfile>('vaultProfile');
    setHasVault(profile !== null);
    setStage('unlock');
  }, []);

  const connectStoredSession = useCallback(
    async (credentials: TelegramCredentials): Promise<boolean> => {
      const sealed = await getSetting('session');
      if (!sealed) return false;
      let me: TelegramAccount;
      try {
        const session = bytesToUtf8(vault.decryptBytes(fromBase64(sealed)));
        me = await telegramService.connectWithSession(credentials, session);
      } catch (failure) {
        await removeSetting('session');
        setInfo(`Saved Telegram session expired: ${cipherErrorMessage(failure)}`);
        return false;
      }
      setAccount(me);
      setStage('ready');
      try {
        await loadChannels(null);
      } catch (failure) {
        // The session is valid; a channel hiccup must not force a new login.
        setInfo(`Signed in, but channels did not load: ${cipherErrorMessage(failure)}.`);
      }
      return true;
    },
    [loadChannels],
  );

  const unlockVault = useCallback(
    async (passphrase: string, mode: 'create' | 'unlock'): Promise<void> => {
      setBusy(true);
      setError(null);
      try {
        const credentials = await readCredentials();
        if (!credentials) throw new Error('Telegram API credentials are missing.');

        if (mode === 'create') {
          const result = await vault.unlock(passphrase);
          const profile: VaultProfile = result;
          await setJsonSetting('vaultProfile', profile);
          setHasVault(true);
          const connected = await connectStoredSession(credentials);
          if (!connected) setStage('login');
          return;
        }

        const profile = await getJsonSetting<VaultProfile>('vaultProfile');
        if (!profile) throw new Error('No vault exists on this phone. Create one first.');
        await vault.unlock(passphrase, {
          saltB64: profile.saltB64,
          verifierB64: profile.verifierB64,
        });
        const connected = await connectStoredSession(credentials);
        if (!connected) setStage('login');
      } catch (failure) {
        setError(cipherErrorMessage(failure));
        throw failure;
      } finally {
        setBusy(false);
      }
    },
    [connectStoredSession, readCredentials],
  );

  const finishLogin = useCallback(async (): Promise<void> => {
    // Save the session before touching channels, so a slow or forbidden
    // channel can never lose a successful Telegram sign-in.
    const session = await telegramService.exportSession();
    await setSetting('session', toBase64(vault.encryptBytes(utf8ToBytes(session))));
    setAccount(telegramService.currentAccount);
    setStage('ready');
    try {
      await loadChannels(null);
    } catch (failure) {
      setInfo(`Signed in, but channels did not load: ${cipherErrorMessage(failure)}.`);
    }
  }, [loadChannels]);

  const sendLoginCode = useCallback(
    async (phone: string): Promise<{ authorized: boolean }> => {
      setBusy(true);
      setError(null);
      try {
        const credentials = await readCredentials();
        if (!credentials) throw new Error('Telegram API credentials are missing.');
        const result = await telegramService.sendCode(credentials, phone.trim());
        if (result.authorized) await finishLogin();
        return result;
      } catch (failure) {
        setError(cipherErrorMessage(failure));
        throw failure;
      } finally {
        setBusy(false);
      }
    },
    [finishLogin, readCredentials],
  );

  const submitLoginCode = useCallback(
    async (code: string): Promise<{ passwordNeeded: boolean }> => {
      setBusy(true);
      setError(null);
      try {
        const result = await telegramService.submitCode(code.trim());
        if (!result.passwordNeeded) await finishLogin();
        return result;
      } catch (failure) {
        setError(cipherErrorMessage(failure));
        throw failure;
      } finally {
        setBusy(false);
      }
    },
    [finishLogin],
  );

  const submitLoginPassword = useCallback(
    async (password: string): Promise<void> => {
      setBusy(true);
      setError(null);
      try {
        await telegramService.submitPassword(password);
        await finishLogin();
      } catch (failure) {
        setError(cipherErrorMessage(failure));
        throw failure;
      } finally {
        setBusy(false);
      }
    },
    [finishLogin],
  );

  const refreshChannels = useCallback(async (): Promise<void> => {
    setBusy(true);
    try {
      await loadChannels(channel);
    } catch (failure) {
      setError(cipherErrorMessage(failure));
    } finally {
      setBusy(false);
    }
  }, [channel, loadChannels]);

  const selectChannel = useCallback(
    async (choice: ChannelChoice): Promise<void> => {
      setBusy(true);
      setError(null);
      try {
        await ensureVaultHeader(choice.id);
        setChannel(choice);
        await setJsonSetting('channel', choice);
      } catch (failure) {
        setError(cipherErrorMessage(failure));
        throw failure;
      } finally {
        setBusy(false);
      }
    },
    [ensureVaultHeader],
  );

  const saveFolder = useCallback(async (choice: FolderChoice | null): Promise<void> => {
    setFolder(choice);
    if (choice) await setJsonSetting('folder', choice);
    else await removeSetting('folder');
  }, []);

  const setMedia = useCallback((next: WhatsAppMediaSelection): void => {
    setMediaState(next);
    void setJsonSetting('media', next);
  }, []);

  const setAutoSync = useCallback(async (enabled: boolean): Promise<void> => {
    setAutoSyncState(enabled);
    await setSetting('autoSync', enabled ? '1' : '0');
  }, []);

  const setScheduleTime = useCallback(async (time: string): Promise<void> => {
    const normalized = normalizeSyncTime(time);
    setScheduleTimeState(normalized);
    await setSetting('syncTime', normalized);
  }, []);

  const markSynced = useCallback(async (): Promise<void> => {
    const now = Date.now();
    setLastSyncAt(now);
    await setSetting('lastSyncAt', String(now));
  }, []);

  const lock = useCallback(async (): Promise<void> => {
    vault.lock();
    telegramService.dispose();
    setAccount(null);
    setChannels([]);
    setStage('unlock');
    setInfo(null);
  }, []);

  const signOut = useCallback(async (): Promise<void> => {
    telegramService.dispose();
    await removeSetting('session');
    setAccount(null);
    setChannels([]);
    setChannel(null);
    await removeSetting('channel');
    vault.lock();
    setStage('unlock');
  }, []);

  const clearMessages = useCallback((): void => {
    setError(null);
    setInfo(null);
  }, []);

  const value = useMemo<VaultContextValue>(
    () => ({
      stage,
      busy,
      error,
      info,
      hasVault,
      account,
      channels,
      channel,
      folder,
      media,
      autoSync,
      scheduleTime,
      lastSyncAt,
      saveCredentials,
      unlockVault,
      sendLoginCode,
      submitLoginCode,
      submitLoginPassword,
      refreshChannels,
      selectChannel,
      saveFolder,
      setMedia,
      setAutoSync,
      setScheduleTime,
      markSynced,
      lock,
      signOut,
      clearMessages,
    }),
    [
      stage,
      busy,
      error,
      info,
      hasVault,
      account,
      channels,
      channel,
      folder,
      media,
      autoSync,
      scheduleTime,
      lastSyncAt,
      saveCredentials,
      unlockVault,
      sendLoginCode,
      submitLoginCode,
      submitLoginPassword,
      refreshChannels,
      selectChannel,
      saveFolder,
      setMedia,
      setAutoSync,
      setScheduleTime,
      markSynced,
      lock,
      signOut,
      clearMessages,
    ],
  );

  return <VaultContext.Provider value={value}>{children}</VaultContext.Provider>;
}

export function useVault(): VaultContextValue {
  const context = useContext(VaultContext);
  if (!context) throw new Error('useVault must be used inside VaultProvider.');
  return context;
}
