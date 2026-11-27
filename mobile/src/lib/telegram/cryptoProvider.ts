/**
 * Pure-JS `ICryptoProvider` for mtcute. Replaces the WASM/WebCrypto provider
 * that `@mtcute/web` uses, because Hermes has neither WASM nor WebCrypto.
 */
import { ecb, gcm } from '@noble/ciphers/aes.js';
import { hmac } from '@noble/hashes/hmac.js';
import { pbkdf2 } from '@noble/hashes/pbkdf2.js';
import { sha1 } from '@noble/hashes/legacy.js';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { gunzipSync, gzipSync, inflateSync } from 'fflate';
import type { IAesCtr, ICryptoProvider, IEncryptionScheme } from '@mtcute/core/utils.js';

const BLOCK = 16;

/**
 * Noble seals a cipher instance after one `encrypt()` call, so a fresh
 * instance is created per block. Padding is disabled: IGE and CTR hand it
 * whole blocks and pad themselves.
 */
const blockEncryptor = (key: Uint8Array) => (block: Uint8Array): Uint8Array =>
  Uint8Array.from(ecb(key, { disablePadding: true }).encrypt(block));

const blockDecryptor = (key: Uint8Array) => (block: Uint8Array): Uint8Array =>
  Uint8Array.from(ecb(key, { disablePadding: true }).decrypt(block));

/** AES-CTR built on single AES blocks, keeping the counter across calls. */
function createCtr(key: Uint8Array, iv: Uint8Array): IAesCtr {
  const encryptBlock = blockEncryptor(key);
  const counter = Uint8Array.from(iv);
  let keystream: Uint8Array = new Uint8Array(0);
  let position = 0;

  const nextBlock = (): Uint8Array => {
    const block = encryptBlock(counter);
    // Big-endian increment of the whole 16-byte counter.
    for (let i = counter.length - 1; i >= 0; i -= 1) {
      counter[i] = (counter[i] ?? 0) + 1;
      if (counter[i] !== 0) break;
    }
    return block;
  };

  return {
    process(data: Uint8Array): Uint8Array {
      const out = new Uint8Array(data.length);
      for (let i = 0; i < data.length; i += 1) {
        if (position >= keystream.length) {
          keystream = nextBlock();
          position = 0;
        }
        out[i] = (data[i] ?? 0) ^ (keystream[position] ?? 0);
        position += 1;
      }
      return out;
    },
  };
}

/**
 * AES-IGE as used by MTProto:
 *   C_i = E(P_i XOR C_{i-1}) XOR P_{i-1}
 * with C_{-1} = iv[0..16] and P_{-1} = iv[16..32].
 */
function createIge(key: Uint8Array, iv: Uint8Array): IEncryptionScheme {
  const encryptBlock = blockEncryptor(key);
  const decryptBlock = blockDecryptor(key);

  return {
    encrypt(data: Uint8Array): Uint8Array {
      if (data.length % BLOCK !== 0) throw new Error('IGE needs whole AES blocks.');
      const out = new Uint8Array(data.length);
      let prevCipher: Uint8Array = Uint8Array.from(iv.subarray(0, 16));
      let prevPlain: Uint8Array = Uint8Array.from(iv.subarray(16, 32));
      for (let offset = 0; offset < data.length; offset += BLOCK) {
        const plain = data.subarray(offset, offset + BLOCK);
        const xored = new Uint8Array(BLOCK);
        for (let i = 0; i < BLOCK; i += 1) xored[i] = (plain[i] ?? 0) ^ (prevCipher[i] ?? 0);
        const encrypted = encryptBlock(xored);
        const block = new Uint8Array(BLOCK);
        for (let i = 0; i < BLOCK; i += 1) block[i] = (encrypted[i] ?? 0) ^ (prevPlain[i] ?? 0);
        out.set(block, offset);
        prevCipher = block;
        prevPlain = plain;
      }
      return out;
    },
    decrypt(data: Uint8Array): Uint8Array {
      if (data.length % BLOCK !== 0) throw new Error('IGE needs whole AES blocks.');
      const out = new Uint8Array(data.length);
      let prevCipher: Uint8Array = Uint8Array.from(iv.subarray(0, 16));
      let prevPlain: Uint8Array = Uint8Array.from(iv.subarray(16, 32));
      for (let offset = 0; offset < data.length; offset += BLOCK) {
        const block = data.subarray(offset, offset + BLOCK);
        const xored = new Uint8Array(BLOCK);
        for (let i = 0; i < BLOCK; i += 1) xored[i] = (block[i] ?? 0) ^ (prevPlain[i] ?? 0);
        const decrypted = decryptBlock(xored);
        const plain = new Uint8Array(BLOCK);
        for (let i = 0; i < BLOCK; i += 1) plain[i] = (decrypted[i] ?? 0) ^ (prevCipher[i] ?? 0);
        out.set(plain, offset);
        prevCipher = block;
        prevPlain = plain;
      }
      return out;
    },
  };
}

const hashOf = (algo: string | undefined) => {
  switch ((algo ?? 'sha256').toLowerCase()) {
    case 'sha1':
      return sha1;
    case 'sha512':
      return sha512;
    default:
      return sha256;
  }
};

export const cryptoProvider: ICryptoProvider = {
  sha1: (data) => sha1(data),
  sha256: (data) => sha256(data),
  pbkdf2: (password, salt, iterations, keylen = 64, algo) =>
    pbkdf2(hashOf(algo), password, salt, { c: iterations, dkLen: keylen }),
  hmacSha256: (data, key) => hmac(sha256, key, data),
  createAesCtr: (key, iv) => createCtr(key, iv),
  createAesIge: (key, iv) => createIge(key, iv),
  factorizePQ: () => {
    throw new Error('Quadratic factorization is not needed for an interactive client.');
  },
  gzip: (data, maxSize) => {
    const out = gzipSync(data);
    return out.byteLength > maxSize ? null : out;
  },
  gunzip: (data) => gunzipSync(data),
  inflate: (data) => inflateSync(data),
  randomFill: (buf) => {
    buf.set(crypto.getRandomValues(new Uint8Array(buf.length)));
  },
  randomBytes: (size) => crypto.getRandomValues(new Uint8Array(size)),
};

export { gcm };
