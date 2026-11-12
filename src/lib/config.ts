/** Optional build-time credentials so self-hosters can skip the settings form. */
const rawApiId = import.meta.env.VITE_TELEGRAM_API_ID?.trim() ?? '';
const parsedApiId = Number.parseInt(rawApiId, 10);

export const envCredentials = {
  apiId: Number.isFinite(parsedApiId) && parsedApiId > 0 ? parsedApiId : undefined,
  apiHash: import.meta.env.VITE_TELEGRAM_API_HASH?.trim() || undefined,
} as const;

export const hasEnvCredentials = Boolean(envCredentials.apiId && envCredentials.apiHash);

export const API_CREDENTIALS_HELP_URL = 'https://my.telegram.org/apps';

/**
 * User-supplied Telegram API credentials, stored only in this browser.
 *
 * `api_hash` is an application identifier, not an account secret, but it is
 * still kept local: it never leaves the device except inside MTProto
 * `initConnection` calls to Telegram.
 */
export interface StoredApiCredentials {
  readonly apiId: number;
  readonly apiHash: string;
}

const CUSTOM_CREDENTIALS_KEY = 'vaultphotos.api_credentials';

/** Reads the optional credentials saved from the login screen. */
export const loadCustomCredentials = (): Partial<StoredApiCredentials> => {
  try {
    const raw = localStorage.getItem(CUSTOM_CREDENTIALS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const candidate = parsed as Record<string, unknown>;
    const apiId = typeof candidate.apiId === 'number' ? candidate.apiId : Number.NaN;
    const apiHash = typeof candidate.apiHash === 'string' ? candidate.apiHash : '';
    if (!Number.isFinite(apiId) || apiId <= 0 || apiHash.length < 10) return {};
    return { apiId, apiHash };
  } catch {
    return {};
  }
};

/** Persists credentials entered on the login screen for the next visit. */
export const saveCustomCredentials = (apiId: number, apiHash: string): void => {
  try {
    localStorage.setItem(CUSTOM_CREDENTIALS_KEY, JSON.stringify({ apiId, apiHash }));
  } catch {
    // Persistence is optional; the current login still works without it.
  }
};

// One-time cleanup for browsers that stored the retired Test DC sandbox flag.
// The app now always connects to production Telegram.
try {
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem('vaultphotos.testdc');
  }
} catch {
  // Storage can be unavailable (private mode or blocked third-party storage).
}
