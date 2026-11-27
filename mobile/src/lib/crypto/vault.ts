/**
 * Vault key management, byte-for-byte compatible with the web app:
 *
 *   bytes    "TGP1" | iv(12) | ciphertext + tag
 *   caption  "TGP1M:" + base64url(iv | ciphertext + tag)
 *   verifier "TGP1V:" + base64url(iv | ciphertext + tag)
 */
import {
  IV_BYTES,
  SALT_BYTES,
  deriveKey,
  openGcm,
  randomBytes,
  sealGcm,
} from './aes';
import { concatBytes, fromBase64Url, toBase64Url, utf8ToBytes } from '../encoding';

export const MAGIC = new Uint8Array([0x54, 0x47, 0x50, 0x31]); // "TGP1"
const META_PREFIX = 'TGP1M:';
const VERIFIER_PREFIX = 'TGP1V:';
const VERIFIER_PLAINTEXT = 'vault-photos:key-check:v1';

export interface VaultMetadata {
  readonly v: 1;
  readonly mid: string;
  readonly name: string;
  readonly mime: string;
  readonly kind: 'photo' | 'video' | 'file';
  readonly width: number;
  readonly height: number;
  readonly takenAt: number;
  readonly size: number;
  readonly duration?: number;
  readonly caption?: string;
  readonly thumbMime?: string;
}

export const isVaultMetadata = (value: unknown): value is VaultMetadata => {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<VaultMetadata>;
  return (
    candidate.v === 1 &&
    typeof candidate.mid === 'string' &&
    typeof candidate.name === 'string' &&
    typeof candidate.mime === 'string' &&
    (candidate.kind === 'photo' || candidate.kind === 'video' || candidate.kind === 'file') &&
    typeof candidate.width === 'number' &&
    typeof candidate.height === 'number' &&
    typeof candidate.takenAt === 'number' &&
    typeof candidate.size === 'number'
  );
};

const hasMagic = (bytes: Uint8Array): boolean =>
  MAGIC.every((byte, index) => bytes[index] === byte);

class Vault {
  private vaultKey: Uint8Array | null = null;
  private vaultPassphrase: string | null = null;
  private readonly channelKeys = new Map<string, Uint8Array>();

  get isUnlocked(): boolean {
    return this.vaultKey !== null;
  }

  private requireKey(): Uint8Array {
    if (!this.vaultKey) throw new Error('Unlock the vault first.');
    return this.vaultKey;
  }

  keyFor(channelId?: string): Uint8Array {
    if (channelId) {
      const channelKey = this.channelKeys.get(channelId);
      if (channelKey) return channelKey;
    }
    return this.requireKey();
  }

  hasKeyFor(channelId: string): boolean {
    return this.vaultKey !== null && this.channelKeys.has(channelId);
  }

  async unlock(
    passphrase: string,
    options: { saltB64?: string; verifierB64?: string } = {},
  ): Promise<{ saltB64: string; verifierB64: string }> {
    const salt = options.saltB64 ? fromBase64Url(options.saltB64) : randomBytes(SALT_BYTES);
    if (salt.byteLength !== SALT_BYTES) throw new Error('Invalid vault salt.');

    const key = await deriveKey(passphrase, salt);
    if (options.verifierB64) {
      const verifier = options.verifierB64;
      if (!verifier.startsWith(VERIFIER_PREFIX)) throw new Error('Invalid vault verifier.');
      const plain = openGcm(key, fromBase64Url(verifier.slice(VERIFIER_PREFIX.length)));
      if (new TextDecoder().decode(plain) !== VERIFIER_PLAINTEXT) {
        throw new Error('That passphrase does not unlock this vault.');
      }
      this.vaultKey = key;
      this.vaultPassphrase = passphrase;
      return { saltB64: toBase64Url(salt), verifierB64: verifier };
    }

    this.vaultKey = key;
    this.vaultPassphrase = passphrase;
    return { saltB64: toBase64Url(salt), verifierB64: this.sealVerifier(key) };
  }

  sealVerifier(key: Uint8Array = this.requireKey()): string {
    const sealed = sealGcm(key, utf8ToBytes(VERIFIER_PLAINTEXT));
    return `${VERIFIER_PREFIX}${toBase64Url(sealed)}`;
  }

  /** Tries the already-unlocked passphrase against a channel's published header. */
  async syncChannelHeader(channelId: string, saltB64: string, verifierB64: string): Promise<boolean> {
    if (!this.vaultPassphrase) return false;
    try {
      const salt = fromBase64Url(saltB64);
      if (salt.byteLength !== SALT_BYTES) return false;
      const key = await deriveKey(this.vaultPassphrase, salt);
      if (!verifierB64.startsWith(VERIFIER_PREFIX)) return false;
      const plain = openGcm(key, fromBase64Url(verifierB64.slice(VERIFIER_PREFIX.length)));
      if (new TextDecoder().decode(plain) !== VERIFIER_PLAINTEXT) return false;
      this.channelKeys.set(channelId, key);
      return true;
    } catch {
      return false;
    }
  }

  async unlockChannel(
    channelId: string,
    passphrase: string,
    saltB64: string,
    verifierB64: string,
  ): Promise<void> {
    const salt = fromBase64Url(saltB64);
    if (salt.byteLength !== SALT_BYTES) throw new Error('That channel publishes an invalid salt.');
    const key = await deriveKey(passphrase, salt);
    const plain = openGcm(key, fromBase64Url(verifierB64.slice(VERIFIER_PREFIX.length)));
    if (new TextDecoder().decode(plain) !== VERIFIER_PLAINTEXT) {
      throw new Error('That passphrase does not unlock this channel.');
    }
    this.channelKeys.set(channelId, key);
  }

  encryptBytes(bytes: Uint8Array, channelId?: string): Uint8Array {
    const sealed = sealGcm(this.keyFor(channelId), bytes);
    return concatBytes(MAGIC, sealed);
  }

  decryptBytes(payload: Uint8Array, channelId?: string): Uint8Array {
    if (payload.byteLength <= MAGIC.byteLength + IV_BYTES || !hasMagic(payload)) {
      throw new Error('This document is not a PicPocket file.');
    }
    return openGcm(this.keyFor(channelId), payload.subarray(MAGIC.byteLength));
  }

  /** Database chunks and the manifest use the same envelope as media bytes. */
  encryptChunk(bytes: Uint8Array, channelId?: string): Uint8Array {
    return this.encryptBytes(bytes, channelId);
  }

  decryptChunk(bytes: Uint8Array, channelId?: string): Uint8Array {
    return this.decryptBytes(bytes, channelId);
  }

  encryptMeta(meta: VaultMetadata, channelId?: string): string {
    const plain = utf8ToBytes(JSON.stringify(meta));
    if (plain.byteLength > 700) throw new Error('Vault metadata is too large for a caption.');
    const sealed = sealGcm(this.keyFor(channelId), plain);
    return `${META_PREFIX}${toBase64Url(sealed)}`;
  }

  decryptMeta(caption: string, channelId?: string): VaultMetadata {
    if (!caption.startsWith(META_PREFIX)) throw new Error('Not a PicPocket metadata caption.');
    const raw = fromBase64Url(caption.slice(META_PREFIX.length));
    const plain = openGcm(this.keyFor(channelId), raw);
    const parsed: unknown = JSON.parse(new TextDecoder().decode(plain));
    if (!isVaultMetadata(parsed)) throw new Error('Vault metadata is malformed.');
    return parsed;
  }

  lock(): void {
    this.vaultKey = null;
    this.vaultPassphrase = null;
    this.channelKeys.clear();
  }
}

export const vault = new Vault();
