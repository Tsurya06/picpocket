/**
 * Domain types for the gallery. Nothing here imports a Telegram or Dexie type,
 * so the UI layer is completely decoupled from the MTProto client.
 */

export type MediaKind = 'photo' | 'video' | 'file';

/**
 * Where an item came from:
 * - `vault`: an AES-256-GCM encrypted `.bin` document we uploaded.
 * - `direct`: a regular photo/video already present in the channel.
 */
export type MediaSource = 'vault' | 'direct';

export interface MediaDimensions {
  readonly width: number;
  readonly height: number;
}

/**
 * Metadata sealed inside the message caption for vault items.
 * `mid` links the origin document to its encrypted thumbnail document.
 */
/**
 * Exact byte coordinates of one individually encrypted item inside a packed
 * `bundle_<uuid>.bin` Telegram document.
 */
export interface PackedSliceLocation {
  readonly bundleMessageId: number;
  /** Exact start byte of `[12-byte IV][ciphertext + 16-byte tag]` in the bundle. */
  readonly byteOffset: number;
  /** Exact length of the sealed slice, including IV and auth tag. */
  readonly byteLength: number;
}

/** A packed original plus the message that carries its encrypted index. */
export interface PackedItemLocation extends PackedSliceLocation {
  readonly bundleIndexMessageId: number;
}

export interface VaultMetadata {
  readonly v: 1;
  readonly mid: string;
  readonly name: string;
  readonly mime: string;
  readonly kind: MediaKind;
  readonly width: number;
  readonly height: number;
  /** Epoch milliseconds of capture (EXIF) or the file's last-modified date. */
  readonly takenAt: number;
  /** Plaintext size in bytes, for progress and sorting. */
  readonly size: number;
  readonly duration?: number;
  readonly caption?: string;
  /** Actual encoding of the sealed preview (WebP, or PNG on older Safari). */
  readonly thumbMime?: string;
}

/** A single gallery item, fully serialisable (safe for IndexedDB). */
export interface MediaItem extends MediaDimensions {
  /** `${channelId}:${messageId}` — stable across sessions. */
  readonly id: string;
  readonly channelId: string;
  readonly channelTitle: string;
  readonly messageId: number;
  /** Message holding the encrypted WebP preview (vault uploads only). */
  readonly thumbMessageId?: number;
  readonly kind: MediaKind;
  readonly source: MediaSource;
  readonly takenAt: number;
  readonly fileName: string;
  readonly mimeType: string;
  readonly size: number;
  readonly duration?: number;
  readonly caption?: string;
  /** Encoding of the cached preview (WebP, or PNG on older Safari). */
  readonly thumbMime?: string;
  /** False while a preview is still being generated or was never uploaded. */
  readonly hasThumb: boolean;
  /** Present when the original lives inside a packed bundle document. */
  readonly packed?: PackedItemLocation;
  /** Present when the preview lives inside the same packed bundle. */
  readonly packedThumb?: PackedSliceLocation;
}

/** Pagination cursor for `messages.getHistory`. */
export interface TimelineOffset {
  readonly id: number;
  readonly date: number;
}

export interface TimelinePage {
  readonly items: readonly MediaItem[];
  readonly next?: TimelineOffset;
}

export interface DayGroup {
  readonly key: string;
  readonly label: string;
  readonly items: readonly MediaItem[];
}

export interface MonthGroup {
  readonly key: string;
  readonly label: string;
  readonly count: number;
  readonly days: readonly DayGroup[];
}

export interface UploadProgress {
  readonly total: number;
  readonly completed: number;
  readonly failed: number;
  readonly currentName: string;
  /** 0..1 for the file currently being uploaded. */
  readonly currentFraction: number;
  /** True while the crypto worker is deriving keys or encoding thumbnails. */
  readonly processing: boolean;
}

export interface UploadResult {
  readonly uploaded: number;
  readonly failed: readonly { readonly name: string; readonly reason: string }[];
}

/** A channel the user can select as a media source. */
export interface ChannelSummary {
  readonly id: string;
  readonly title: string;
  readonly username?: string;
  readonly memberCount?: number;
  readonly kind: 'channel' | 'supergroup' | 'group';
  readonly isCreator: boolean;
  readonly isSelected: boolean;
}

export interface ChannelAvatar {
  readonly channelId: string;
  readonly blob: Blob;
}

export interface TelegramAccount {
  readonly id: string;
  readonly displayName: string;
  readonly username?: string;
  readonly phone?: string;
}

/** Persisted, passphrase-protected marker used to validate the vault key. */
export interface VaultProfile {
  readonly salt: string;
  readonly verifier: string;
  readonly iterations: number;
  readonly createdAt: number;
}

export type ThemeMode = 'light' | 'dark';

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

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
