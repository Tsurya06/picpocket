import type { TimelineOffset } from './media';

/** Client credentials created at https://my.telegram.org/apps. */
export interface TelegramCredentials {
  readonly apiId: number;
  readonly apiHash: string;
}

/**
 * Stages the UI can render during an interactive login.
 * `qr` carries the tg:// URL that must be drawn as a QR code.
 */
export type LoginStage =
  | { readonly kind: 'idle' }
  | { readonly kind: 'phone' }
  | { readonly kind: 'code'; readonly hint?: string }
  | { readonly kind: 'password'; readonly hint?: string }
  | { readonly kind: 'qr'; readonly url: string; readonly expiresAt: number }
  | { readonly kind: 'connecting' }
  | { readonly kind: 'success' }
  | { readonly kind: 'error'; readonly message: string };

export type AuthStatus =
  | 'booting'
  | 'locked'
  | 'onboarding'
  | 'connecting'
  | 'vault'
  | 'ready'
  | 'error';

/** Raw, still-encrypted media descriptor returned by the MTProto layer. */
export interface RemoteMediaDescriptor {
  readonly channelId: string;
  readonly channelTitle: string;
  readonly messageId: number;
  readonly date: number;
  readonly fileName: string;
  readonly mimeType: string;
  readonly size: number;
  readonly width: number;
  readonly height: number;
  readonly duration?: number;
  readonly kind: 'photo' | 'video' | 'file';
  /** Vault caption when this is an encrypted item, `null` for direct media. */
  readonly vaultCaption: string | null;
  /** Thumbnail document message id for vault items. */
  readonly thumbMessageId?: number;
  readonly hasThumb: boolean;
}

export interface RemoteThumbRef {
  readonly mid: string;
  readonly messageId: number;
}

/** Encrypted index document that describes one packed bundle. */
export interface RemoteBundleRef {
  readonly channelId: string;
  readonly messageId: number;
  readonly bundleId: string;
}

export interface ChannelMediaBatch {
  readonly channelId: string;
  readonly channelTitle: string;
  readonly descriptors: readonly RemoteMediaDescriptor[];
  /** Encrypted preview documents keyed by the media id in their caption. */
  readonly thumbs: readonly RemoteThumbRef[];
  /** Sealed packed-bundle indexes discovered in this page. */
  readonly bundles: readonly RemoteBundleRef[];
  readonly next?: TimelineOffset;
}

export interface DownloadOptions {
  readonly onProgress?: (fraction: number, loadedBytes: number) => void;
  readonly signal?: AbortSignal;
  /** Called when Telegram asks this client to back off. */
  readonly onFloodWait?: (seconds: number) => void;
}
