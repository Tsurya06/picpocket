import type { MediaKind, VaultMetadata } from './media';

/**
 * Typed request/response protocol for `crypto.worker.ts`.
 * Every crypto operation lives inside the worker; the main thread only ever
 * receives ciphertext, plaintext for an explicitly requested file, or closed
 * metadata objects. It never receives the AES key.
 */

export interface UnlockPayload {
  readonly passphrase: string;
  /** Existing base64 salt when unlocking, omitted when creating a vault. */
  readonly salt?: string;
  /** Stored `TGP1V:` verifier, validated before the key is accepted. */
  readonly verifier?: string;
}

export interface UnlockResponse {
  readonly salt: string;
  readonly verifier: string;
}

export interface PrepareMediaPayload {
  readonly data: ArrayBuffer;
  readonly mime: string;
  readonly name: string;
  readonly lastModified: number;
}

export interface PrepareMediaResponse {
  /** Original bytes with EXIF/GPS/XMP stripped (or passed through if none). */
  readonly stripped: ArrayBuffer;
  /** Compressed WebP preview, already metadata-free. */
  readonly thumb: ArrayBuffer | null;
  /** Actual encoding returned by the canvas (WebP, or PNG on older Safari). */
  readonly thumbMime: string | null;
  readonly width: number;
  readonly height: number;
  readonly kind: MediaKind;
  readonly takenAt: number;
  /** Bytes removed during sanitisation, surfaced in the UI. */
  readonly strippedBytes: number;
}

export interface EncryptMetaPayload {
  readonly meta: VaultMetadata;
  /** Vault channel whose key seals this item; omitted means the primary vault. */
  readonly channelId?: string;
}

export interface EncryptMetaResponse {
  /** `TGP1M:<base64url>` caption for the origin document. */
  readonly caption: string;
}

export interface DecryptMetaPayload {
  readonly caption: string;
  readonly channelId?: string;
}

export interface DecryptMetaResponse {
  readonly meta: VaultMetadata;
}

export interface BytesPayload {
  readonly data: ArrayBuffer;
  readonly channelId?: string;
}

export interface BytesResponse {
  readonly data: ArrayBuffer;
}

export interface EncryptThumbPayload {
  readonly data: ArrayBuffer;
  readonly channelId?: string;
}

export interface PackBundlePayload {
  /** Plaintext items in order; each is encrypted with its own random IV. */
  readonly items: readonly ArrayBuffer[];
  readonly channelId?: string;
}

export interface PackedSlice {
  readonly byteOffset: number;
  readonly byteLength: number;
}

export interface PackBundleResponse {
  /** `bundle_<uuid>.bin` contents: sealed items concatenated end-to-end. */
  readonly bundle: ArrayBuffer;
  readonly slices: readonly PackedSlice[];
}

export interface DecryptPackedPayload {
  readonly data: ArrayBuffer;
  readonly channelId?: string;
}

/** Header published in a channel so other devices can derive its vault key. */
export interface ChannelKeyPayload {
  readonly channelId: string;
  readonly salt: string;
  readonly verifier: string;
}

export interface UnlockChannelPayload extends ChannelKeyPayload {
  readonly passphrase: string;
}

export interface ChannelKeyResponse {
  /** True when the primary vault key already opens this channel. */
  readonly matched: boolean;
}

export interface RequestMap {
  unlock: { payload: UnlockPayload; response: UnlockResponse };
  lock: { payload: undefined; response: undefined };
  prepareMedia: { payload: PrepareMediaPayload; response: PrepareMediaResponse };
  encryptMeta: { payload: EncryptMetaPayload; response: EncryptMetaResponse };
  decryptMeta: { payload: DecryptMetaPayload; response: DecryptMetaResponse };
  encryptBytes: { payload: BytesPayload; response: BytesResponse };
  /** Same AEAD envelope, used for streamed WhatsApp database chunks. */
  encryptChunk: { payload: BytesPayload; response: BytesResponse };
  decryptBytes: { payload: BytesPayload; response: BytesResponse };
  encryptThumb: { payload: EncryptThumbPayload; response: BytesResponse };
  packBundle: { payload: PackBundlePayload; response: PackBundleResponse };
  decryptPacked: { payload: DecryptPackedPayload; response: BytesResponse };
  /** Try the unlocked primary passphrase against a channel header. */
  syncChannelHeader: { payload: ChannelKeyPayload; response: ChannelKeyResponse };
  /** Derive and cache a channel key from that channel's own passphrase. */
  unlockChannel: { payload: UnlockChannelPayload; response: undefined };
}

export type WorkerRequestType = keyof RequestMap;

export type WorkerRequest = {
  [K in WorkerRequestType]: {
    readonly id: number;
    readonly type: K;
    readonly payload: RequestMap[K]['payload'];
  };
}[WorkerRequestType];

export interface WorkerSuccess {
  readonly id: number;
  readonly ok: true;
  readonly type: WorkerRequestType;
  readonly response: RequestMap[WorkerRequestType]['response'];
}

export interface WorkerFailure {
  readonly id: number;
  readonly ok: false;
  readonly error: string;
}

export type WorkerResponse = WorkerSuccess | WorkerFailure;
