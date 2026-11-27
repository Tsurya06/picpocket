/**
 * AES-256-GCM + PBKDF2 primitives. The parameters match the web vault exactly
 * (PBKDF2-SHA256, 600k iterations, 12-byte IV, 16-byte tag appended), so a
 * backup made on either side opens on the other.
 */
import { gcm } from '@noble/ciphers/aes.js';
import { pbkdf2Async } from '@noble/hashes/pbkdf2.js';
import { sha256 } from '@noble/hashes/sha2.js';

export const PBKDF2_ITERATIONS = 600_000;
export const SALT_BYTES = 16;
export const IV_BYTES = 12;

export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

export async function deriveKey(
  passphrase: string,
  salt: Uint8Array,
  iterations = PBKDF2_ITERATIONS,
): Promise<Uint8Array> {
  if (passphrase.length < 8) {
    throw new Error('The vault passphrase must be at least 8 characters long.');
  }
  return pbkdf2Async(sha256, passphrase, salt, { c: iterations, dkLen: 32 });
}

/** Returns `iv || ciphertext || tag`, the layout WebCrypto produces. */
export function sealGcm(key: Uint8Array, plain: Uint8Array, iv = randomBytes(IV_BYTES)): Uint8Array {
  const ciphertext = gcm(key, iv).encrypt(plain);
  const out = new Uint8Array(iv.byteLength + ciphertext.byteLength);
  out.set(iv, 0);
  out.set(ciphertext, iv.byteLength);
  return out;
}

export function openGcm(key: Uint8Array, sealed: Uint8Array): Uint8Array {
  if (sealed.byteLength <= IV_BYTES) throw new Error('Encrypted payload is truncated.');
  const iv = sealed.subarray(0, IV_BYTES);
  return gcm(key, iv).decrypt(sealed.subarray(IV_BYTES));
}
