/**
 * Zero-knowledge crypto worker.
 *
 * Everything sensitive happens here, off the main thread:
 *  - PBKDF2(SHA-256, 600 000 iterations) → non-extractable AES-256-GCM key
 *  - encrypted envelopes for originals and previews
 *  - EXIF/GPS/XMP sanitisation for JPEG, PNG and WebP
 *  - WebP previews via OffscreenCanvas
 *
 * The derived CryptoKey never leaves this module and is created with
 * `extractable: false`, so neither the UI nor an injected script can read it.
 */
import type {
  ChannelKeyPayload,
  ChannelKeyResponse,
  DecryptMetaPayload,
  DecryptPackedPayload,
  EncryptMetaPayload,
  PackBundlePayload,
  PackBundleResponse,
  PrepareMediaPayload,
  PrepareMediaResponse,
  RequestMap,
  UnlockChannelPayload,
  UnlockPayload,
  UnlockResponse,
  WorkerRequest,
  WorkerRequestType,
  WorkerResponse,
} from '../types/worker';
import type { VaultMetadata } from '../types/media';
import { isVaultMetadata } from '../types/media';

interface WorkerScope {
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<WorkerRequest>) => void): void;
}

const scope = self as unknown as WorkerScope;

const PBKDF2_ITERATIONS = 600_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const THUMB_MAX_EDGE = 512;
const THUMB_QUALITY = 0.82;
const MAGIC = new Uint8Array([0x54, 0x47, 0x50, 0x31]); // "TGP1"
const META_PREFIX = 'TGP1M:';
const VERIFIER_PREFIX = 'TGP1V:';
const VERIFIER_PLAINTEXT = 'vault-photos:key-check:v1';
const PACKED_IV_BYTES = 12;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * The primary vault key (non-extractable). It is also the fallback key for
 * legacy items and for channels that never published their own header.
 */
let vaultKey: CryptoKey | null = null;

/**
 * Kept only while the vault is unlocked so per-channel keys can be derived
 * from the same passphrase without asking the user again. Cleared on lock.
 */
let vaultPassphrase: string | null = null;

/**
 * Per-channel keys. A shared channel may use a passphrase that differs from
 * the primary vault, so its key is cached here under its channel id.
 */
const channelKeys = new Map<string, CryptoKey>();

/* ------------------------------------------------------------------ */
/* Encoding helpers                                                    */
/* ------------------------------------------------------------------ */

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function hasMagic(bytes: Uint8Array): boolean {
  return MAGIC.every((byte, index) => bytes[index] === byte);
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function requireKey(): CryptoKey {
  if (!vaultKey) throw new Error('Vault is locked. Enter your passphrase to unlock it.');
  return vaultKey;
}

/** Channel key when one is cached, otherwise the primary vault key. */
function keyFor(channelId?: string): CryptoKey {
  if (channelId) {
    const scoped = channelKeys.get(channelId);
    if (scoped) return scoped;
  }
  return requireKey();
}

/* ------------------------------------------------------------------ */
/* Key derivation                                                      */
/* ------------------------------------------------------------------ */

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  if (passphrase.length < 8) {
    throw new Error('The vault passphrase must be at least 8 characters long.');
  }
  const baseKey = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt as unknown as BufferSource,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false, // non-extractable: the key can never be exported
    ['encrypt', 'decrypt'],
  );
}

async function sealVerifier(key: CryptoKey = requireKey()): Promise<string> {
  const iv = randomBytes(IV_BYTES);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as unknown as BufferSource },
      key,
      textEncoder.encode(VERIFIER_PLAINTEXT),
    ),
  );
  return `${VERIFIER_PREFIX}${toBase64Url(concat(iv, ciphertext))}`;
}

async function assertVerifier(verifier: string, key: CryptoKey = requireKey()): Promise<void> {
  if (!verifier.startsWith(VERIFIER_PREFIX)) {
    throw new Error('The stored vault profile is corrupted.');
  }
  const payload = fromBase64Url(verifier.slice(VERIFIER_PREFIX.length));
  const iv = payload.subarray(0, IV_BYTES);
  const ciphertext = payload.subarray(IV_BYTES);
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as unknown as BufferSource },
      key,
      ciphertext as unknown as BufferSource,
    );
    if (textDecoder.decode(plaintext) !== VERIFIER_PLAINTEXT) {
      throw new Error('Passphrase mismatch.');
    }
  } catch {
    throw new Error('That passphrase does not unlock this vault.');
  }
}

async function unlock(payload: UnlockPayload): Promise<UnlockResponse> {
  const salt = payload.salt ? fromBase64Url(payload.salt) : randomBytes(SALT_BYTES);
  if (salt.byteLength !== SALT_BYTES) throw new Error('Invalid vault salt.');

  const previousKey = vaultKey;
  const previousPassphrase = vaultPassphrase;
  vaultKey = null;
  vaultPassphrase = null;
  try {
    vaultKey = await deriveKey(payload.passphrase, salt);
    if (payload.verifier) {
      await assertVerifier(payload.verifier);
      vaultPassphrase = payload.passphrase;
      return { salt: toBase64Url(salt), verifier: payload.verifier };
    }
    const verifier = await sealVerifier();
    vaultPassphrase = payload.passphrase;
    return { salt: toBase64Url(salt), verifier };
  } catch (error) {
    vaultKey = previousKey;
    vaultPassphrase = previousPassphrase;
    throw error;
  }
}

/**
 * Re-derives a channel key from the primary passphrase and the salt published
 * in that channel's header. Succeeds only when both belong to the same vault.
 */
async function syncChannelHeader(payload: ChannelKeyPayload): Promise<ChannelKeyResponse> {
  if (!vaultKey || !vaultPassphrase) return { matched: false };
  try {
    const salt = fromBase64Url(payload.salt);
    if (salt.byteLength !== SALT_BYTES) return { matched: false };
    const candidate = await deriveKey(vaultPassphrase, salt);
    await assertVerifier(payload.verifier, candidate);
    channelKeys.set(payload.channelId, candidate);
    return { matched: true };
  } catch {
    return { matched: false };
  }
}

/** Derives and caches a key from a passphrase entered for one channel. */
async function unlockChannel(payload: UnlockChannelPayload): Promise<undefined> {
  const salt = fromBase64Url(payload.salt);
  if (salt.byteLength !== SALT_BYTES) throw new Error('This channel publishes an invalid vault salt.');
  const candidate = await deriveKey(payload.passphrase, salt);
  try {
    await assertVerifier(payload.verifier, candidate);
  } catch {
    throw new Error('That passphrase does not unlock this channel.');
  }
  channelKeys.set(payload.channelId, candidate);
  return undefined;
}

/* ------------------------------------------------------------------ */
/* AES-256-GCM envelope:  "TGP1" | iv(12) | ciphertext                 */
/* ------------------------------------------------------------------ */

async function encryptBytes(bytes: Uint8Array, channelId?: string): Promise<ArrayBuffer> {
  const key = keyFor(channelId);
  const iv = randomBytes(IV_BYTES);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as unknown as BufferSource },
    key,
    bytes as unknown as BufferSource,
  );
  const out = new Uint8Array(MAGIC.byteLength + IV_BYTES + ciphertext.byteLength);
  out.set(MAGIC, 0);
  out.set(iv, MAGIC.byteLength);
  out.set(new Uint8Array(ciphertext), MAGIC.byteLength + IV_BYTES);
  return out.buffer;
}

/**
 * Packed slices use a lean envelope: `[12-byte IV][ciphertext + 16-byte tag]`.
 * No type/magic prefix is needed because the bundle index records the bounds.
 */
async function encryptPacked(bytes: Uint8Array, channelId?: string): Promise<Uint8Array> {
  const key = keyFor(channelId);
  const iv = randomBytes(PACKED_IV_BYTES);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as unknown as BufferSource },
      key,
      bytes as unknown as BufferSource,
    ),
  );
  const out = new Uint8Array(PACKED_IV_BYTES + ciphertext.byteLength);
  out.set(iv, 0);
  out.set(ciphertext, PACKED_IV_BYTES);
  return out;
}

async function decryptPacked(payload: Uint8Array, channelId?: string): Promise<ArrayBuffer> {
  const key = keyFor(channelId);
  if (payload.byteLength <= PACKED_IV_BYTES) {
    throw new Error('Packed vault slice is truncated.');
  }
  const iv = payload.subarray(0, PACKED_IV_BYTES);
  const ciphertext = payload.subarray(PACKED_IV_BYTES);
  try {
    return await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as unknown as BufferSource },
      key,
      ciphertext as unknown as BufferSource,
    );
  } catch {
    throw new Error('Packed slice decryption failed: wrong key or corrupted bundle.');
  }
}

/** Encrypt each item with its own IV, then concatenate into one container. */
async function packBundle(payload: PackBundlePayload): Promise<PackBundleResponse> {
  const sealed: Uint8Array[] = [];
  let total = 0;
  for (const item of payload.items) {
    const bytes = await encryptPacked(new Uint8Array(item), payload.channelId);
    sealed.push(bytes);
    total += bytes.byteLength;
  }

  const bundle = new Uint8Array(total);
  const slices: Array<{ byteOffset: number; byteLength: number }> = [];
  let offset = 0;
  for (const bytes of sealed) {
    bundle.set(bytes, offset);
    slices.push({ byteOffset: offset, byteLength: bytes.byteLength });
    offset += bytes.byteLength;
  }
  return { bundle: bundle.buffer, slices };
}

async function decryptBytes(payload: Uint8Array, channelId?: string): Promise<ArrayBuffer> {
  const key = keyFor(channelId);
  if (payload.byteLength <= MAGIC.byteLength + IV_BYTES || !hasMagic(payload)) {
    throw new Error('This document is not a PicPocket file.');
  }
  const iv = payload.subarray(MAGIC.byteLength, MAGIC.byteLength + IV_BYTES);
  const ciphertext = payload.subarray(MAGIC.byteLength + IV_BYTES);
  try {
    return await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as unknown as BufferSource },
      key,
      ciphertext as unknown as BufferSource,
    );
  } catch {
    throw new Error('Decryption failed: wrong passphrase or corrupted file.');
  }
}

async function encryptMeta(payload: EncryptMetaPayload): Promise<{ caption: string }> {
  const plaintext = textEncoder.encode(JSON.stringify(payload.meta));
  if (plaintext.byteLength > 700) {
    throw new Error('Vault metadata is too large for a Telegram caption.');
  }
  const sealed = new Uint8Array(await encryptBytes(plaintext, payload.channelId));
  // Drop the magic prefix; captions carry their own discriminator.
  const iv = sealed.subarray(MAGIC.byteLength, MAGIC.byteLength + IV_BYTES);
  const ciphertext = sealed.subarray(MAGIC.byteLength + IV_BYTES);
  return { caption: `${META_PREFIX}${toBase64Url(concat(iv, ciphertext))}` };
}

async function decryptMeta(payload: DecryptMetaPayload): Promise<{ meta: VaultMetadata }> {
  if (!payload.caption.startsWith(META_PREFIX)) {
    throw new Error('Not a PicPocket metadata caption.');
  }
  const raw = fromBase64Url(payload.caption.slice(META_PREFIX.length));
  const iv = raw.subarray(0, IV_BYTES);
  const ciphertext = raw.subarray(IV_BYTES);
  const key = keyFor(payload.channelId);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as unknown as BufferSource },
    key,
    ciphertext as unknown as BufferSource,
  );
  const parsed: unknown = JSON.parse(textDecoder.decode(plaintext));
  if (!isVaultMetadata(parsed)) throw new Error('Vault metadata is malformed.');
  return { meta: parsed };
}

/* ------------------------------------------------------------------ */
/* Metadata sanitisation                                               */
/* ------------------------------------------------------------------ */

function readAscii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

/**
 * Extracts the first EXIF-style timestamp without shipping a full TIFF parser.
 * EXIF has no timezone, so the value is interpreted as local time.
 */
function parseExifDate(buffer: Uint8Array): number | null {
  const limit = Math.min(buffer.byteLength, 512 * 1024);
  const chunk = buffer.subarray(0, limit);
  let ascii = '';
  const step = 8192;
  for (let offset = 0; offset < chunk.byteLength; offset += step) {
    ascii += readAscii(chunk, offset, Math.min(step, chunk.byteLength - offset));
  }
  const match = /(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(ascii);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  if (!year || !month || !day || !hour || !minute || !second) return null;
  const date = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  const time = date.getTime();
  return Number.isFinite(time) && time > 0 ? time : null;
}

/** Removes every JPEG APPn segment (except JFIF and ICC) plus comments. */
function stripJpeg(buffer: Uint8Array): Uint8Array {
  if (buffer.byteLength < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return buffer;
  const parts: Uint8Array[] = [buffer.subarray(0, 2)];
  let offset = 2;

  while (offset + 4 <= buffer.byteLength) {
    if (buffer[offset] !== 0xff) break;
    const marker = buffer[offset + 1];
    if (marker === undefined) break;

    // Start of scan: everything after this is entropy-coded image data.
    if (marker === 0xda) {
      parts.push(buffer.subarray(offset));
      return concat(...parts);
    }

    const length = ((buffer[offset + 2] ?? 0) << 8) | (buffer[offset + 3] ?? 0);
    if (length < 2 || offset + 2 + length > buffer.byteLength) break;
    const segment = buffer.subarray(offset, offset + 2 + length);
    const isMetadata =
      (marker >= 0xe1 && marker <= 0xef && marker !== 0xe2) || marker === 0xfe;
    if (!isMetadata) parts.push(segment);
    offset += 2 + length;
  }

  // Unparseable tail: keep it rather than corrupting the image.
  if (offset < buffer.byteLength) parts.push(buffer.subarray(offset));
  return concat(...parts);
}

const PNG_METADATA_CHUNKS = new Set(['eXIf', 'tEXt', 'iTXt', 'zTXt', 'tIME']);

function stripPng(buffer: Uint8Array): Uint8Array {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buffer.byteLength < 8 || !signature.every((byte, index) => buffer[index] === byte)) {
    return buffer;
  }
  const parts: Uint8Array[] = [buffer.subarray(0, 8)];
  let offset = 8;
  while (offset + 12 <= buffer.byteLength) {
    const view = new DataView(buffer.buffer, buffer.byteOffset + offset, 8);
    const length = view.getUint32(0);
    const type = readAscii(buffer, offset + 4, 4);
    const total = 12 + length;
    if (offset + total > buffer.byteLength) break;
    if (!PNG_METADATA_CHUNKS.has(type)) parts.push(buffer.subarray(offset, offset + total));
    offset += total;
    if (type === 'IEND') break;
  }
  return concat(...parts);
}

/** Strips EXIF / XMP chunks from a WebP RIFF container. */
function stripWebp(buffer: Uint8Array): Uint8Array {
  if (buffer.byteLength < 16) return buffer;
  if (readAscii(buffer, 0, 4) !== 'RIFF' || readAscii(buffer, 8, 4) !== 'WEBP') return buffer;
  const parts: Uint8Array[] = [];
  let offset = 12;
  while (offset + 8 <= buffer.byteLength) {
    const type = readAscii(buffer, offset, 4);
    const size =
      (buffer[offset + 4] ?? 0) |
      ((buffer[offset + 5] ?? 0) << 8) |
      ((buffer[offset + 6] ?? 0) << 16) |
      ((buffer[offset + 7] ?? 0) << 24);
    const padded = size + (size % 2);
    const end = Math.min(offset + 8 + padded, buffer.byteLength);
    if (type !== 'EXIF' && type !== 'XMP ') parts.push(buffer.subarray(offset, end));
    offset = end;
  }
  const body = concat(...parts);
  const header = new Uint8Array(12);
  header.set(buffer.subarray(0, 4), 0);
  new DataView(header.buffer).setUint32(4, 4 + body.byteLength, true);
  header.set(buffer.subarray(8, 12), 8);
  return concat(header, body);
}

function sanitize(buffer: Uint8Array, mime: string): Uint8Array {
  if (mime === 'image/jpeg' || mime === 'image/jpg') return stripJpeg(buffer);
  if (mime === 'image/png') return stripPng(buffer);
  if (mime === 'image/webp') return stripWebp(buffer);
  return buffer;
}

/* ------------------------------------------------------------------ */
/* Preview generation                                                  */
/* ------------------------------------------------------------------ */

interface ThumbResult {
  bytes: ArrayBuffer;
  mime: string;
  width: number;
  height: number;
}

async function makeThumb(bitmap: ImageBitmap): Promise<ThumbResult | null> {
  const scale = Math.min(1, THUMB_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.imageSmoothingQuality = 'high';
  context.drawImage(bitmap, 0, 0, width, height);
  const blob = await canvas.convertToBlob({ type: 'image/webp', quality: THUMB_QUALITY });
  return {
    bytes: await blob.arrayBuffer(),
    mime: blob.type || 'image/webp',
    width: bitmap.width,
    height: bitmap.height,
  };
}

const IMAGE_MIME = /^image\//;

async function prepareMedia(payload: PrepareMediaPayload): Promise<PrepareMediaResponse> {
  const original = new Uint8Array(payload.data);
  if (!IMAGE_MIME.test(payload.mime)) {
    throw new Error('Only images can be prepared in the crypto worker.');
  }

  const stripped = sanitize(original, payload.mime.toLowerCase());
  let thumb: ThumbResult | null = null;
  let width = 0;
  let height = 0;

  try {
    const bitmap = await createImageBitmap(
      new Blob([stripped as unknown as BlobPart], { type: payload.mime }),
      {
        imageOrientation: 'from-image',
      },
    );
    width = bitmap.width;
    height = bitmap.height;
    thumb = await makeThumb(bitmap);
    bitmap.close();
  } catch {
    // HEIC and other unsupported formats: keep the upload, skip the preview.
  }

  const takenAt = parseExifDate(original) ?? payload.lastModified;

  return {
    stripped: stripped.buffer as ArrayBuffer,
    thumb: thumb?.bytes ?? null,
    thumbMime: thumb?.mime ?? null,
    width: thumb?.width ?? width,
    height: thumb?.height ?? height,
    kind: 'photo',
    takenAt: Number.isFinite(takenAt) && takenAt > 0 ? takenAt : Date.now(),
    strippedBytes: original.byteLength - stripped.byteLength,
  };
}

/* ------------------------------------------------------------------ */
/* RPC plumbing                                                        */
/* ------------------------------------------------------------------ */

type Handler = (payload: never) => Promise<unknown>;

const handlers: { [K in WorkerRequestType]: (payload: RequestMap[K]['payload']) => Promise<RequestMap[K]['response']> } = {
  unlock: (payload) => unlock(payload),
  lock: async () => {
    vaultKey = null;
    vaultPassphrase = null;
    channelKeys.clear();
    return undefined;
  },
  prepareMedia: (payload) => prepareMedia(payload),
  encryptMeta: (payload) => encryptMeta(payload),
  decryptMeta: (payload) => decryptMeta(payload),
  encryptBytes: async (payload) => ({
    data: await encryptBytes(new Uint8Array(payload.data), payload.channelId),
  }),
  encryptChunk: async (payload) => ({ data: await encryptBytes(new Uint8Array(payload.data)) }),
  decryptBytes: async (payload) => ({
    data: await decryptBytes(new Uint8Array(payload.data), payload.channelId),
  }),
  encryptThumb: async (payload) => ({
    data: await encryptBytes(new Uint8Array(payload.data), payload.channelId),
  }),
  packBundle: (payload) => packBundle(payload),
  decryptPacked: async (payload: DecryptPackedPayload) => ({
    data: await decryptPacked(new Uint8Array(payload.data), payload.channelId),
  }),
  syncChannelHeader: (payload) => syncChannelHeader(payload),
  unlockChannel: (payload) => unlockChannel(payload),
};

async function dispatch(request: WorkerRequest): Promise<void> {
  try {
    const handler = handlers[request.type] as Handler;
    const response = await handler(request.payload as never);
    const success = {
      id: request.id,
      ok: true,
      type: request.type,
      response,
    } as WorkerResponse;
    scope.postMessage(success);
  } catch (error) {
    const failure: WorkerResponse = {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : 'Unexpected crypto worker error.',
    };
    scope.postMessage(failure);
  }
}

scope.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  void dispatch(event.data);
});
