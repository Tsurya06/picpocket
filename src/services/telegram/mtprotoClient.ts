import { InputMedia, MemoryStorage, TelegramClient, User } from '@mtcute/web';
import type { Chat, Document, Message, MessageMedia, Photo, Video } from '@mtcute/web';
import type {
  ChannelMediaBatch,
  DownloadOptions,
  LoginStage,
  RemoteBundleRef,
  RemoteMediaDescriptor,
  RemoteThumbRef,
  TelegramCredentials,
} from '../../types/telegram';
import type { ChannelSummary, TelegramAccount, TimelineOffset } from '../../types/media';
import {
  isBackupCaption,
  isBackupManifestCaption,
  isBundleCaption,
  isMetaCaption,
  parseBundleIndexCaption,
  parseThumbCaption,
} from './captions';
import { antiBan } from './antiBan';
import {
  channelHeaderCaption,
  parseChannelHeader,
  type ChannelHeader,
} from './channelHeader';

/** Thin, typed façade over mtcute's MTProto client.

 * Design constraints enforced here:
 *  - `MemoryStorage` only: nothing — not even an auth key — is persisted by
 *    the library. The caller seals `exportSession()` with the vault key.
 *  - Every read/write is scoped to an explicit channel id supplied by the UI.
 *  - No Node APIs, no proxy, no server: browser WebSocket transport only.
 *  - Every RPC goes through `antiBan`, so flood waits pause the whole queue
 *    instead of silently retrying a single call.
 */
type WaiterKind = 'phone' | 'code' | 'password';

interface Waiter {
  resolve: (value: string) => void;
  reject: (reason: Error) => void;
}

export interface LoginOptions {
  readonly credentials: TelegramCredentials;
  readonly mode: 'phone' | 'qr';
  readonly phone?: string;
  readonly onStage: (stage: LoginStage) => void;
  readonly signal?: AbortSignal;
}

export interface RawDownload {
  readonly bytes: ArrayBuffer;
  readonly mimeType: string;
  readonly encrypted: boolean;
}

export interface ThumbDownload {
  readonly bytes: ArrayBuffer;
  readonly encrypted: boolean;
}

export interface UploadEncryptedInput {
  readonly channelId: string;
  readonly bytes: ArrayBuffer;
  readonly fileName: string;
  readonly caption: string;
  readonly onProgress?: (fraction: number) => void;
  readonly signal?: AbortSignal;
  readonly onFloodWait?: (seconds: number) => void;
}

export interface UploadDirectInput {
  readonly channelId: string;
  readonly file: File;
  readonly kind: 'photo' | 'video' | 'file';
  readonly caption?: string;
  readonly width?: number;
  readonly height?: number;
  readonly duration?: number;
  readonly onProgress?: (fraction: number) => void;
  readonly signal?: AbortSignal;
  readonly onFloodWait?: (seconds: number) => void;
}

export interface UploadAlbumItem {
  readonly file: File;
  readonly kind: 'photo' | 'video';
  readonly caption?: string;
  readonly width?: number;
  readonly height?: number;
  readonly duration?: number;
}

export interface UploadAlbumInput {
  readonly channelId: string;
  readonly items: readonly UploadAlbumItem[];
  readonly onProgress?: (fraction: number) => void;
  readonly signal?: AbortSignal;
  readonly onFloodWait?: (seconds: number) => void;
}

const APP_VERSION = '1.0.0';
const FALLBACK_DEVICE_MODEL = 'Desktop Chrome PWA';
const FALLBACK_SYSTEM_VERSION = 'Win32';
const FALLBACK_LANG_CODE = 'en';

const DIALOG_LIMIT = 400;
const MEDIA_PAGE_SIZE = 60;
const MANIFEST_SCAN_LIMIT = 200;
const HEADER_SCAN_LIMIT = 100;
const RANGE_ALIGNMENT = 4096;

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

const clampFraction = (loaded: number, total: number): number => {
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.min(1, Math.max(0, loaded / total));
};

export const describeError = (error: unknown): string => {
  if (error instanceof Error) {
    const message = error.message || 'Unknown Telegram error.';
    if (/FLOOD_WAIT_(\d+)/.test(message)) {
      const seconds = /FLOOD_WAIT_(\d+)/.exec(message)?.[1];
      return `Telegram rate limit reached. Please wait ${seconds ?? 'a few'} seconds and try again.`;
    }
    if (/AUTH_KEY_UNREGISTERED|SESSION_REVOKED|USER_DEACTIVATED/.test(message)) {
      return 'This Telegram session is no longer valid. Sign in again.';
    }
    if (/CHANNEL_PRIVATE|CHAT_ADMIN_REQUIRED/.test(message)) {
      return 'You do not have access to post in this channel.';
    }
    return message;
  }
  return 'Something went wrong while talking to Telegram.';
};

const mapAccount = (user: User | null): TelegramAccount => {
  if (!user) {
    return { id: 'unknown', displayName: 'Telegram account' };
  }
  const username = user.username ?? undefined;
  const phone = user.phoneNumber ?? undefined;
  const displayName = user.displayName.trim() || username || `Account ${user.id}`;
  return { id: String(user.id), displayName, username, phone };
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isPasswordRequired = (error: unknown): boolean =>
  /SESSION_PASSWORD_NEEDED/i.test(errorMessage(error));

/** Media mtcute can hand back as a linear, seekable file. */
type DownloadableMedia = Photo | Video | Document;

const isDownloadable = (media: MessageMedia): media is DownloadableMedia =>
  media !== null &&
  (media.type === 'photo' || media.type === 'video' || media.type === 'document');

const mimeFor = (media: DownloadableMedia): string =>
  media.type === 'photo' ? 'image/jpeg' : media.mimeType;

/** mtcute treats numeric strings as usernames, so RPCs need real numbers. */
const toPeerId = (channelId: string): string | number => {
  const trimmed = channelId.trim();
  return /^-?\d+$/.test(trimmed) ? Number(trimmed) : trimmed;
};

const chatKind = (chat: Chat): ChannelSummary['kind'] => {
  if (chat.chatType === 'supergroup' || chat.chatType === 'gigagroup') return 'supergroup';
  if (chat.chatType === 'group') return 'group';
  return 'channel';
};

const memberCountOf = (chat: Chat): number | undefined => {
  const raw = chat.raw;
  if (raw._ === 'channel' && typeof raw.participantsCount === 'number') {
    return raw.participantsCount;
  }
  return undefined;
};

export class TelegramVaultService {
  private client: TelegramClient | null = null;
  // Tracks clients that have already been destroyed, so a stale login catch
  // never calls destroy() twice on the same instance.
  private readonly disposedClients = new WeakSet<TelegramClient>();
  private readonly chats = new Map<string, Chat>();
  private readonly waiters = new Map<WaiterKind, Waiter>();
  private abortController: AbortController | null = null;
  private onStage: ((stage: LoginStage) => void) | null = null;
  private account: TelegramAccount | null = null;

  get isConnected(): boolean {
    return this.client !== null;
  }

  get currentAccount(): TelegramAccount | null {
    return this.account;
  }

  private requireClient(): TelegramClient {
    if (!this.client) throw new Error('Telegram is not connected yet.');
    return this.client;
  }

  private createClient(credentials: TelegramCredentials): TelegramClient {
    this.dispose();

    /* ── Realistic device & client fingerprinting ─────────────────── */
    // A blank/generic fingerprint makes an interactive client look like a
    // script, which is exactly what triggers automated-behaviour flags.
    const nav = typeof navigator === 'undefined' ? null : navigator;
    const isMobile = nav !== null && /Mobile|Android|iPhone|iPad/i.test(nav.userAgent);
    const deviceModel = isMobile ? 'Android PWA' : FALLBACK_DEVICE_MODEL;
    const systemVersion = (nav?.platform || FALLBACK_SYSTEM_VERSION).trim() || FALLBACK_SYSTEM_VERSION;
    const langCode = (nav?.language || FALLBACK_LANG_CODE).trim() || FALLBACK_LANG_CODE;

    const client = new TelegramClient({
      apiId: credentials.apiId,
      apiHash: credentials.apiHash,
      // Deliberately in-memory: the session is exported and sealed by the vault.
      storage: new MemoryStorage(),
      /* ── Realistic fingerprint ─────────────────────────────────── */
      // mtcute fills these into `initConnection`, the handshake fields
      // Telegram fingerprints. The web transport is WSS-only in @mtcute/web.
      initConnectionOptions: {
        deviceModel,
        systemVersion,
        appVersion: APP_VERSION,
        langCode,
        systemLangCode: langCode,
        langPack: 'web',
      },
    });
    this.client = client;
    return client;
  }

  private emitStage(stage: LoginStage): void {
    this.onStage?.(stage);
  }

  /* ---------------------------------------------------------------- */
  /* Authentication                                                     */

  private waitFor(kind: WaiterKind): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const pending = this.waiters.get(kind);
      if (pending) {
        this.waiters.delete(kind);
        pending.reject(new Error('Superseded by a newer login prompt.'));
      }
      if (this.abortController?.signal.aborted) {
        reject(new Error('Login cancelled.'));
        return;
      }
      this.waiters.set(kind, { resolve, reject });
    });
  }

  /* ---------------------------------------------------------------- */
  /* Login façade used by useTelegramAuth                              */

  async login(options: LoginOptions): Promise<{ account: TelegramAccount; session: string }> {
    const { credentials, mode, phone, onStage, signal } = options;

    if (mode === 'phone' && !phone) {
      throw new Error('Enter your phone number in international format.');
    }

    const controller = new AbortController();
    // `createClient` disposes the previous client, which also clears the stage
    // callback and abort controller. Install the new ones afterwards so QR
    // stage updates are not dropped.
    const client = this.createClient(credentials);
    this.abortController = controller;
    this.onStage = onStage;
    if (signal) {
      signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    this.emitStage({ kind: 'connecting' });

    try {
      const user =
        mode === 'qr'
          ? await this.loginWithQr(client, controller.signal)
          : await this.loginWithPhone(client, phone ?? '', controller.signal);

      const account = mapAccount(user);
      this.account = account;
      const session = await client.exportSession();
      return { account, session };
    } catch (error) {
      // A cancelled attempt can settle after the next login has already created
      // its own client; never dispose that newer client from the stale catch.
      // If cancel (or a replacement login) already destroyed this client, skip
      // the duplicate destroy() to avoid "Network manager is destroyed" noise.
      if (this.client === client) {
        this.dispose();
      } else if (!this.disposedClients.has(client)) {
        this.disposedClients.add(client);
        void client.destroy().catch(() => undefined);
      }
      throw error;
    } finally {
      if (this.abortController === controller) this.abortController = null;
    }
  }

  private async loginWithQr(client: TelegramClient, signal: AbortSignal): Promise<User> {
    return client.start({
      qrCodeHandler: (url: string, expires: Date): void => {
        this.emitStage({ kind: 'qr', url, expiresAt: expires.getTime() });
      },
      password: (): Promise<string> => this.promptPassword(),
      invalidCodeCallback: (type): void => {
        if (type === 'password') {
          this.emitStage({ kind: 'password', hint: 'That password was rejected. Try again.' });
        }
      },
      abortSignal: signal,
    });
  }

  /**
   * Phone login is explicit instead of `client.start` so the code and 2FA
   * stages map directly onto the app's login UI. Accounts are never created
   * automatically; an unregistered number gets the server's own error.
   */
  private async loginWithPhone(
    client: TelegramClient,
    phone: string,
    signal: AbortSignal,
  ): Promise<User> {
    const sent = await client.sendCode({ phone, abortSignal: signal });
    if (sent instanceof User) return sent;

    const phoneCode = await this.promptCode();

    try {
      return await client.signIn({
        phone,
        phoneCodeHash: sent.phoneCodeHash,
        phoneCode,
        abortSignal: signal,
      });
    } catch (error) {
      if (isPasswordRequired(error)) {
        return this.completeTwoFactor(client, signal);
      }
      throw error;
    }
  }

  private async promptCode(): Promise<string> {
    this.emitStage({ kind: 'code' });
    return this.waitFor('code');
  }

  private promptPassword(): Promise<string> {
    this.emitStage({ kind: 'password' });
    return this.waitFor('password');
  }

  private async completeTwoFactor(
    client: TelegramClient,
    signal: AbortSignal,
  ): Promise<User> {
    for (;;) {
      const password = await this.promptPassword();
      try {
        return await client.checkPassword({ password, abortSignal: signal });
      } catch (error) {
        if (!/PASSWORD_HASH_INVALID/i.test(errorMessage(error))) throw error;
        this.emitStage({ kind: 'password', hint: 'That password was rejected. Try again.' });
      }
    }
  }

  submitCode(code: string): void {
    const waiter = this.waiters.get('code');
    if (waiter) {
      this.waiters.delete('code');
      waiter.resolve(code);
    }
  }

  submitPassword(password: string): void {
    const waiter = this.waiters.get('password');
    if (waiter) {
      this.waiters.delete('password');
      waiter.resolve(password);
    }
  }

  cancelLogin(): void {
    // Only tear down the client when a login is actually in progress; a stray
    // cancel must never kill an already-connected session. The abortController
    // is set for the lifetime of a login attempt and cleared otherwise.
    const controller = this.abortController;
    const wasLogin = controller !== null;
    controller?.abort();
    this.abortController = null;
    for (const [, waiter] of this.waiters) {
      waiter.reject(new Error('Login cancelled.'));
    }
    this.waiters.clear();
    this.onStage = null;
    if (wasLogin) {
      // Dispose the client immediately so its socket does not stay open until
      // the next attempt. Stale login catches detect the already-disposed
      // client via the disposedClients set and skip a duplicate destroy().
      const client = this.client;
      this.client = null;
      this.account = null;
      this.chats.clear();
      if (client) {
        this.disposedClients.add(client);
        void client.destroy().catch(() => undefined);
      }
    }
  }

  async connectWithSession(
    credentials: TelegramCredentials,
    session: string,
  ): Promise<TelegramAccount> {
    const client = this.createClient(credentials);
    await client.importSession(session);
    await client.connect();
    const user = await client.getMe();
    const account = mapAccount(user);
    this.account = account;
    return account;
  }

  /* ---------------------------------------------------------------- */
  /* Channels                                                           */

  private toSummary(chat: Chat, isSelected = false): ChannelSummary {
    const username = chat.username ?? undefined;
    const memberCount = memberCountOf(chat);
    return {
      id: String(chat.id),
      title: chat.title,
      ...(username ? { username } : {}),
      ...(memberCount !== undefined ? { memberCount } : {}),
      kind: chatKind(chat),
      isCreator: chat.isCreator,
      isSelected,
    };
  }

  private async resolveChat(channelId: string): Promise<Chat> {
    const cached = this.chats.get(channelId);
    if (cached) return cached;
    const client = this.requireClient();
    const chat = await antiBan.run(() => client.getChat(toPeerId(channelId)), { kind: 'read' });
    this.chats.set(String(chat.id), chat);
    this.chats.set(channelId, chat);
    return chat;
  }

  /**
   * Every channel and group the signed-in account belongs to, read-only ones
   * included, so existing shared libraries can be browsed. Community and
   * monoforum wrappers are skipped: they are containers, not media peers.
   */
  async listChannels(): Promise<ChannelSummary[]> {
    const client = this.requireClient();
    const summaries: ChannelSummary[] = [];

    await antiBan.run(
      async () => {
        for await (const dialog of client.iterDialogs({
          limit: DIALOG_LIMIT,
          archived: 'keep',
        })) {
          const peer = dialog.peer;
          if (peer.type !== 'chat') continue;
          const chat = peer;
          if (chat.chatType === 'community' || chat.chatType === 'monoforum') continue;
          this.chats.set(String(chat.id), chat);
          summaries.push(this.toSummary(chat));
        }
      },
      { kind: 'read' },
    );

    return summaries.sort((a, b) => a.title.localeCompare(b.title));
  }

  async createVaultChannel(title: string): Promise<ChannelSummary> {
    const trimmed = title.trim();
    if (trimmed.length === 0) throw new Error('Choose a name for the new vault channel.');
    const client = this.requireClient();
    const chat = await antiBan.run(
      () =>
        client.createChannel({
          title: trimmed,
          description: 'Encrypted media vault created by PicPocket.',
        }),
      { kind: 'write' },
    );
    this.chats.set(String(chat.id), chat);
    return { ...this.toSummary(chat), isCreator: true, isSelected: false };
  }

  async getChannelAvatar(channelId: string): Promise<Blob | null> {
    const client = this.requireClient();
    const chat = await this.resolveChat(channelId);
    const photo = chat.photo;
    if (!photo) return null;
    const bytes = await antiBan.run(() => client.downloadAsBuffer(photo.big), {
      kind: 'read',
    });
    return new Blob([toArrayBuffer(bytes)], { type: 'image/jpeg' });
  }

  /* ---------------------------------------------------------------- */
  /* History / timeline                                                 */

  private async loadMessage(channelId: string, messageId: number): Promise<Message> {
    const client = this.requireClient();
    const chat = await this.resolveChat(channelId);
    const messages = await antiBan.run(
      () => client.getMessages(chat.inputPeer, [messageId]),
      { kind: 'read' },
    );
    const message = messages[0];
    if (!message) throw new Error(`Message ${messageId} was not found in this channel.`);
    return message;
  }

  /**
   * One page of channel history, split into vault descriptors, sealed preview
   * references and packed-bundle indexes. Pagination uses Telegram's own
   * `next` cursor so two pages can never overlap.
   */
  async fetchMediaBatch(
    channelId: string,
    params: { readonly offset?: TimelineOffset } = {},
  ): Promise<ChannelMediaBatch> {
    const client = this.requireClient();
    const chat = await this.resolveChat(channelId);

    return antiBan.run(
      async () => {
        const page = await client.getHistory(chat.inputPeer, {
          limit: MEDIA_PAGE_SIZE,
          ...(params.offset ? { offset: params.offset } : {}),
        });

        const descriptors: RemoteMediaDescriptor[] = [];
        const thumbs: RemoteThumbRef[] = [];
        const bundles: RemoteBundleRef[] = [];

        for (const message of page) {
          const caption = message.text;
          if (isBackupCaption(caption)) continue;

          const media = message.media;
          if (!media) continue;

          if (media.type === 'document') {
            const bundleIndex = parseBundleIndexCaption(caption);
            if (bundleIndex) {
              bundles.push({
                channelId,
                messageId: message.id,
                bundleId: bundleIndex.bundleId,
              });
              continue;
            }
            if (isBundleCaption(caption)) continue;

            const thumbId = parseThumbCaption(caption);
            if (thumbId) {
              thumbs.push({ mid: thumbId, messageId: message.id });
              continue;
            }

            if (isMetaCaption(caption)) {
              descriptors.push({
                channelId,
                channelTitle: chat.title,
                messageId: message.id,
                date: message.date.getTime(),
                fileName: `vault_${message.id}.bin`,
                mimeType: 'application/octet-stream',
                size: media.fileSize ?? 0,
                width: 0,
                height: 0,
                kind: 'file',
                vaultCaption: caption,
                hasThumb: false,
              });
              continue;
            }

            descriptors.push({
              channelId,
              channelTitle: chat.title,
              messageId: message.id,
              date: message.date.getTime(),
              fileName: media.fileName ?? `document_${message.id}`,
              mimeType: media.mimeType,
              size: media.fileSize ?? 0,
              width: 0,
              height: 0,
              kind: 'file',
              vaultCaption: null,
              hasThumb: media.thumbnails.length > 0,
            });
            continue;
          }

          if (media.type === 'photo') {
            descriptors.push({
              channelId,
              channelTitle: chat.title,
              messageId: message.id,
              date: message.date.getTime(),
              fileName: `photo_${message.id}.jpg`,
              mimeType: 'image/jpeg',
              size: media.fileSize ?? 0,
              width: media.width,
              height: media.height,
              kind: 'photo',
              vaultCaption: null,
              hasThumb: media.thumbnails.length > 0,
            });
            continue;
          }

          if (media.type === 'video') {
            descriptors.push({
              channelId,
              channelTitle: chat.title,
              messageId: message.id,
              date: message.date.getTime(),
              fileName: media.fileName ?? `video_${message.id}.mp4`,
              mimeType: media.mimeType,
              size: media.fileSize ?? 0,
              width: media.width,
              height: media.height,
              duration: media.duration,
              kind: 'video',
              vaultCaption: null,
              hasThumb: media.thumbnails.length > 0,
            });
          }
        }

        return {
          channelId,
          channelTitle: chat.title,
          descriptors,
          thumbs,
          bundles,
          ...(page.next ? { next: { id: page.next.id, date: page.next.date } } : {}),
        };
      },
      { kind: 'read' },
    );
  }

  async findBackupManifests(
    channelId: string,
  ): Promise<ReadonlyArray<{ readonly messageId: number }>> {
    const client = this.requireClient();
    const chat = await this.resolveChat(channelId);
    return antiBan.run(
      async () => {
        const page = await client.getHistory(chat.inputPeer, { limit: MANIFEST_SCAN_LIMIT });
        const refs: { messageId: number }[] = [];
        for (const message of page) {
          if (isBackupManifestCaption(message.text)) {
            refs.push({ messageId: message.id });
          }
        }
        return refs;
      },
      { kind: 'read' },
    );
  }

  /* ---------------------------------------------------------------- */
  /* Channel vault headers                                              */

  /**
   * Looks for a `TGP1H:` header in the channel's recent history. The header is
   * posted once by whichever device first initialises the channel, so a scan
   * of the newest messages is enough for every later device to find it.
   */
  async findChannelHeaders(
    channelId: string,
  ): Promise<ReadonlyArray<{ readonly messageId: number; readonly header: ChannelHeader }>> {
    const client = this.requireClient();
    const chat = await this.resolveChat(channelId);
    return antiBan.run(
      async () => {
        const page = await client.getHistory(chat.inputPeer, { limit: HEADER_SCAN_LIMIT });
        const headers: Array<{ messageId: number; header: ChannelHeader }> = [];
        for (const message of page) {
          const header = parseChannelHeader(message.text);
          if (header) headers.push({ messageId: message.id, header });
        }
        return headers;
      },
      { kind: 'read' },
    );
  }

  async findChannelHeader(
    channelId: string,
  ): Promise<{ readonly messageId: number; readonly header: ChannelHeader } | null> {
    const headers = await this.findChannelHeaders(channelId);
    return headers[0] ?? null;
  }

  /** Publishes the channel vault header so other devices can derive its key. */
  async publishChannelHeader(channelId: string, header: ChannelHeader): Promise<number> {
    const client = this.requireClient();
    const chat = await this.resolveChat(channelId);
    const message = await antiBan.run(
      () => client.sendText(chat.inputPeer, channelHeaderCaption(header)),
      { kind: 'write' },
    );
    return message.id;
  }

  /* ---------------------------------------------------------------- */
  /* Downloads                                                          */

  async downloadOriginal(
    channelId: string,
    messageId: number,
    options?: DownloadOptions,
  ): Promise<RawDownload> {
    const client = this.requireClient();
    const message = await this.loadMessage(channelId, messageId);
    const media = message.media;
    if (!isDownloadable(media)) {
      throw new Error('This message does not contain a downloadable file.');
    }

    const caption = message.text;
    const encrypted =
      isMetaCaption(caption) || isBundleCaption(caption) || isBackupCaption(caption);

    const bytes = await antiBan.run(
      () =>
        client.downloadAsBuffer(media, {
          ...(media.fileSize !== undefined ? { fileSize: media.fileSize } : {}),
          progressCallback: (downloaded, total) =>
            options?.onProgress?.(clampFraction(downloaded, total), downloaded),
          ...(options?.signal ? { abortSignal: options.signal } : {}),
        }),
      {
        kind: 'read',
        ...(options?.signal ? { signal: options.signal } : {}),
        ...(options?.onFloodWait ? { onFloodWait: options.onFloodWait } : {}),
      },
    );

    return { bytes: toArrayBuffer(bytes), mimeType: mimeFor(media), encrypted };
  }

  /**
   * Downloads an exact byte slice of a packed bundle. mtcute requires offsets
   * aligned to 4 KB, so the range is expanded and trimmed back afterwards.
   */
  async downloadRange(
    channelId: string,
    messageId: number,
    byteOffset: number,
    byteLength: number,
    options?: DownloadOptions,
  ): Promise<RawDownload> {
    if (byteLength <= 0) throw new Error('The requested media slice is empty.');

    const client = this.requireClient();
    const message = await this.loadMessage(channelId, messageId);
    const media = message.media;
    if (!isDownloadable(media)) {
      throw new Error('This message does not contain a downloadable bundle.');
    }

    const alignedOffset = Math.floor(byteOffset / RANGE_ALIGNMENT) * RANGE_ALIGNMENT;
    const delta = byteOffset - alignedOffset;

    const bytes = await antiBan.run(
      () =>
        client.downloadAsBuffer(media, {
          offset: alignedOffset,
          limit: delta + byteLength,
          progressCallback: (downloaded, total) =>
            options?.onProgress?.(clampFraction(downloaded, total), downloaded),
          ...(options?.signal ? { abortSignal: options.signal } : {}),
        }),
      {
        kind: 'read',
        ...(options?.signal ? { signal: options.signal } : {}),
        ...(options?.onFloodWait ? { onFloodWait: options.onFloodWait } : {}),
      },
    );

    const slice = bytes.subarray(delta, delta + byteLength);
    if (slice.byteLength !== byteLength) {
      throw new Error('The bundle slice was shorter than expected.');
    }

    return { bytes: toArrayBuffer(slice), mimeType: mimeFor(media), encrypted: true };
  }

  /**
   * A preview for a gallery tile: the sealed preview document for vault items,
   * or Telegram's own smallest thumbnail for direct media.
   */
  async downloadThumb(
    channelId: string,
    messageId: number,
    thumbMessageId?: number,
  ): Promise<ThumbDownload> {
    const client = this.requireClient();

    if (thumbMessageId !== undefined) {
      const message = await this.loadMessage(channelId, thumbMessageId);
      const media = message.media;
      if (!isDownloadable(media)) {
        throw new Error('The preview message does not contain a file.');
      }
      const bytes = await antiBan.run(() => client.downloadAsBuffer(media), {
        kind: 'read',
      });
      return { bytes: toArrayBuffer(bytes), encrypted: true };
    }

    const message = await this.loadMessage(channelId, messageId);
    const media = message.media;
    if (!isDownloadable(media)) {
      throw new Error('This message does not contain a downloadable file.');
    }

    const thumb = media.thumbnails[media.thumbnails.length - 1];
    if (!thumb) throw new Error('No preview was stored for this message.');

    const bytes = await antiBan.run(() => client.downloadAsBuffer(thumb), {
      kind: 'read',
    });
    return { bytes: toArrayBuffer(bytes), encrypted: false };
  }

  /* ---------------------------------------------------------------- */
  /* Uploads                                                            */

  async uploadEncrypted(input: UploadEncryptedInput): Promise<number> {
    const client = this.requireClient();
    const data = new Uint8Array(input.bytes);
    const chat = await this.resolveChat(input.channelId);

    // 1. Stream file chunks to Telegram DC first (independent of message write queue)
    const uploaded = await client.uploadFile({
      file: data,
      fileName: input.fileName,
      fileMime: 'application/octet-stream',
      progressCallback: (uploadedBytes, total) =>
        input.onProgress?.(clampFraction(uploadedBytes, total)),
      ...(input.signal ? { abortSignal: input.signal } : {}),
    });

    // 2. Only wrap the message posting in the rate-limited write queue.
    // If sendMedia hits a FLOOD_WAIT, it sleeps and retries *without* re-uploading file bytes!
    const message = await antiBan.run(
      () =>
        client.sendMedia(
          chat.inputPeer,
          InputMedia.document(uploaded, {
            fileName: input.fileName,
            fileMime: 'application/octet-stream',
          }),
          {
            ...(input.caption.length > 0 ? { caption: input.caption } : {}),
          },
        ),
      {
        kind: 'write',
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.onFloodWait ? { onFloodWait: input.onFloodWait } : {}),
      },
    );

    return message.id;
  }

  async uploadDirect(input: UploadDirectInput): Promise<number> {
    const client = this.requireClient();
    const mime = input.file.type || 'application/octet-stream';
    const chat = await this.resolveChat(input.channelId);

    // 1. Stream file chunks to DC first
    const uploaded = await client.uploadFile({
      file: input.file,
      fileName: input.file.name,
      fileMime: mime,
      progressCallback: (uploadedBytes, total) =>
        input.onProgress?.(clampFraction(uploadedBytes, total)),
      ...(input.signal ? { abortSignal: input.signal } : {}),
    });

    const media =
      input.kind === 'photo'
        ? InputMedia.photo(uploaded)
        : input.kind === 'video'
          ? InputMedia.video(uploaded, {
              width: input.width,
              height: input.height,
              duration: input.duration,
              supportsStreaming: true,
            })
          : InputMedia.document(uploaded, {
              fileName: input.file.name,
              fileMime: mime,
            });

    // 2. Post the message via rate-limited write queue using cached inputPeer
    const message = await antiBan.run(
      () =>
        client.sendMedia(chat.inputPeer, media, {
          ...(input.caption && input.caption.length > 0 ? { caption: input.caption } : {}),
        }),
      {
        kind: 'write',
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.onFloodWait ? { onFloodWait: input.onFloodWait } : {}),
      },
    );

    return message.id;
  }

  /**
   * Official Telegram Album specification (messages.sendMultiMedia):
   * Batches up to 10 photos/videos into a single album transaction,
   * reducing message count and avoiding single-post flood limits.
   */
  async uploadDirectAlbum(input: UploadAlbumInput): Promise<number[]> {
    if (input.items.length === 0) return [];
    if (input.items.length > 10) {
      throw new Error('Telegram media albums can contain at most 10 items.');
    }

    const client = this.requireClient();
    const chat = await this.resolveChat(input.channelId);

    // 1. Upload each item's file chunks sequentially
    const totalItems = input.items.length;
    type AlbumMedia =
      | ReturnType<typeof InputMedia.photo>
      | ReturnType<typeof InputMedia.video>;
    const uploadedMedias: AlbumMedia[] = [];

    for (let i = 0; i < totalItems; i += 1) {
      const item = input.items[i];
      if (!item) continue;
      if (input.signal?.aborted) throw new DOMException('Upload cancelled.', 'AbortError');

      const mime = item.file.type || 'application/octet-stream';
      const uploaded = await client.uploadFile({
        file: item.file,
        fileName: item.file.name,
        fileMime: mime,
        progressCallback: (loaded, total) => {
          const itemFraction = clampFraction(loaded, total);
          input.onProgress?.(clampFraction((i + itemFraction) / totalItems, 1));
        },
        ...(input.signal ? { abortSignal: input.signal } : {}),
      });

      const media =
        item.kind === 'video'
          ? InputMedia.video(uploaded, {
              caption: item.caption,
              width: item.width,
              height: item.height,
              duration: item.duration,
              supportsStreaming: true,
            })
          : InputMedia.photo(uploaded, {
              caption: item.caption,
            });

      uploadedMedias.push(media);
    }

    // 2. Dispatch the album via sendMediaGroup in the rate-limited write queue
    const messages = await antiBan.run(
      () => client.sendMediaGroup(chat.inputPeer, uploadedMedias),
      {
        kind: 'write',
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.onFloodWait ? { onFloodWait: input.onFloodWait } : {}),
      },
    );

    return messages.map((m) => m.id);
  }

  async deleteMessages(channelId: string, messageIds: readonly number[]): Promise<void> {
    if (messageIds.length === 0) return;
    const client = this.requireClient();
    const chat = await this.resolveChat(channelId);
    await antiBan.run(
      () => client.deleteMessagesById(chat.inputPeer, [...messageIds]),
      { kind: 'write' },
    );
  }

  /* ---------------------------------------------------------------- */
  /* Session                                                            */

  dispose(): void {
    const client = this.client;
    if (client) this.disposedClients.add(client);
    this.client = null;
    this.account = null;
    this.onStage = null;
    this.abortController = null;
    for (const [, waiter] of this.waiters) {
      waiter.reject(new Error('Telegram client disposed.'));
    }
    this.waiters.clear();
    this.chats.clear();
    if (client) void client.destroy().catch(() => undefined);
  }
}

// Re-exported so callers can type download payloads without importing mtcute.
export type { DownloadOptions };

export const telegramService = new TelegramVaultService();
