/**
 * Telegram façade for the mobile vault.
 *
 * The session is memory-only inside mtcute; the caller exports it and stores
 * the sealed string, exactly like the web app does.
 */
import { InputMedia, MemoryStorage } from '@mtcute/core';
import { TelegramClient } from '@mtcute/core/client.js';
import { Platform } from 'react-native';
import type { Chat, Message } from '@mtcute/core';
import { cryptoProvider } from './cryptoProvider';
import { RnWebSocketTransport } from './transport';
import { CHANNEL_HEADER_PREFIX, isBackupManifestCaption } from './captions';
import { channelHeaderCaption, parseChannelHeader, type ChannelHeader } from './channelHeader';

export interface TelegramCredentials {
  readonly apiId: number;
  readonly apiHash: string;
}

export interface TelegramAccount {
  readonly id: string;
  readonly displayName: string;
  readonly username?: string;
}

export interface ChannelSummary {
  readonly id: string;
  readonly title: string;
  readonly username?: string;
  readonly kind: 'channel' | 'group' | 'supergroup';
  readonly isCreator: boolean;
}

export interface UploadInput {
  readonly channelId: string;
  readonly bytes: Uint8Array;
  readonly fileName: string;
  readonly caption?: string;
  readonly signal?: AbortSignal;
  readonly onProgress?: (fraction: number) => void;
  readonly onFloodWait?: (seconds: number) => void;
}

const FALLBACK_MODEL = 'Android Device';
const APP_VERSION = '1.0.0 (mobile)';

const toPeerId = (channelId: string): string | number =>
  /^-?\d+$/.test(channelId.trim()) ? Number(channelId.trim()) : channelId.trim();

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Telegram flood limits pause the whole flow instead of failing the backup. */
async function withFloodWait<T>(run: () => Promise<T>, onWait?: (seconds: number) => void): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      const match = /FLOOD_WAIT_(\d+)/i.exec(errorMessage(error));
      if (!match || attempt >= 3) throw error;
      const seconds = Math.min(Number(match[1] ?? 0), 120);
      onWait?.(seconds);
      await sleep(seconds * 1000);
    }
  }
}

const rnPlatform = {
  beforeExit: () => () => undefined,
  log: () => undefined,
  getDefaultLogLevel: () => null,
  getDeviceModel: () => `${Platform.OS} device`,
  normalizeFile: (file: unknown) => ({ file }),
};

class TelegramService {
  private client: TelegramClient | null = null;
  private account: TelegramAccount | null = null;
  private readonly chats = new Map<string, Chat>();
  private pendingPhone: { phone: string; phoneCodeHash: string } | null = null;

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
    const client = new TelegramClient({
      apiId: credentials.apiId,
      apiHash: credentials.apiHash,
      storage: new MemoryStorage(),
      crypto: cryptoProvider,
      transport: new RnWebSocketTransport() as never,
      platform: rnPlatform as never,
      initConnectionOptions: {
        deviceModel: FALLBACK_MODEL,
        systemVersion: Platform.Version ? String(Platform.Version) : '1.0',
        appVersion: APP_VERSION,
        langCode: 'en',
        systemLangCode: 'en',
        langPack: 'web',
      },
    } as never);
    this.client = client;
    return client;
  }

  private mapAccount(user: { id: string | number; displayName: string; username?: string | null }): TelegramAccount {
    return {
      id: String(user.id),
      displayName: user.displayName || 'Telegram user',
      ...(user.username ? { username: user.username } : {}),
    };
  }

  dispose(): void {
    const client = this.client;
    this.client = null;
    this.account = null;
    this.chats.clear();
    this.pendingPhone = null;
    if (client) void client.destroy().catch(() => undefined);
  }

  /** Sends the login code; returns true when the number is already signed in. */
  async sendCode(
    credentials: TelegramCredentials,
    phone: string,
  ): Promise<{ authorized: boolean }> {
    const client = this.createClient(credentials);
    const sent = await withFloodWait(() => client.sendCode({ phone }));
    if (!('phoneCodeHash' in sent)) {
      this.account = this.mapAccount(sent);
      return { authorized: true };
    }
    this.pendingPhone = { phone, phoneCodeHash: sent.phoneCodeHash };
    return { authorized: false };
  }

  /** Throws `PASSWORD_NEEDED` through the returned flag when 2FA is on. */
  async submitCode(code: string): Promise<{ passwordNeeded: boolean }> {
    if (!this.pendingPhone) throw new Error('Request a login code first.');
    const client = this.requireClient();
    const { phone, phoneCodeHash } = this.pendingPhone;
    try {
      const user = await withFloodWait(() =>
        client.signIn({ phone, phoneCodeHash, phoneCode: code }),
      );
      this.account = this.mapAccount(user);
      return { passwordNeeded: false };
    } catch (error) {
      const message = errorMessage(error);
      if (/SESSION_PASSWORD_NEEDED|PASSWORD_REQUIRED/i.test(message)) {
        return { passwordNeeded: true };
      }
      throw error;
    }
  }

  async submitPassword(password: string): Promise<void> {
    const client = this.requireClient();
    const user = await withFloodWait(() => client.checkPassword({ password }));
    this.account = this.mapAccount(user);
  }

  async exportSession(): Promise<string> {
    return this.requireClient().exportSession();
  }

  async connectWithSession(
    credentials: TelegramCredentials,
    session: string,
  ): Promise<TelegramAccount> {
    const client = this.createClient(credentials);
    await client.importSession(session);
    await client.connect();
    const user = await client.getMe();
    this.account = this.mapAccount(user);
    return this.account;
  }

  private async resolveChat(channelId: string): Promise<Chat> {
    const cached = this.chats.get(channelId);
    if (cached) return cached;
    const chat = await withFloodWait(() => this.requireClient().getChat(toPeerId(channelId)));
    this.chats.set(String(chat.id), chat);
    this.chats.set(channelId, chat);
    return chat;
  }

  async listChannels(): Promise<ChannelSummary[]> {
    const client = this.requireClient();
    const summaries: ChannelSummary[] = [];
    await withFloodWait(async () => {
      for await (const dialog of client.iterDialogs({ limit: 200, archived: 'keep' })) {
        const peer = dialog.peer;
        if (peer.type !== 'chat') continue;
        if (peer.chatType === 'community' || peer.chatType === 'monoforum') continue;
        this.chats.set(String(peer.id), peer);
        summaries.push({
          id: String(peer.id),
          title: peer.title,
          ...(peer.username ? { username: peer.username } : {}),
          kind:
            peer.chatType === 'supergroup' || peer.chatType === 'gigagroup'
              ? 'supergroup'
              : peer.chatType === 'group'
                ? 'group'
                : 'channel',
          isCreator: peer.isCreator,
        });
      }
    });
    return summaries.sort((a, b) => a.title.localeCompare(b.title));
  }

  async createChannel(title: string): Promise<ChannelSummary> {
    const chat = await withFloodWait(() =>
      this.requireClient().createChannel({
        title: title.trim(),
        description: 'Encrypted media vault created by PicPocket.',
      }),
    );
    this.chats.set(String(chat.id), chat);
    return {
      id: String(chat.id),
      title: chat.title,
      kind: 'channel',
      isCreator: true,
    };
  }

  async getHistory(channelId: string, limit = 60): Promise<Message[]> {
    const chat = await this.resolveChat(channelId);
    const page = await withFloodWait(() => this.requireClient().getHistory(chat.inputPeer, { limit }));
    return [...page];
  }

  async findBackupManifests(channelId: string): Promise<number[]> {
    const messages = await this.getHistory(channelId, 100);
    return messages
      .filter((message) => isBackupManifestCaption(message.text))
      .map((message) => message.id);
  }

  async findChannelHeader(
    channelId: string,
  ): Promise<{ messageId: number; header: ChannelHeader } | null> {
    const messages = await this.getHistory(channelId, 100);
    for (const message of messages) {
      const header = parseChannelHeader(message.text);
      if (header) return { messageId: message.id, header };
    }
    return null;
  }

  /** Finds a vault header anywhere in the account, used after a reinstall. */
  async findAnyVaultHeader(): Promise<{ channelId: string; header: ChannelHeader } | null> {
    const results = await withFloodWait(() =>
      this.requireClient().searchGlobal({
        query: CHANNEL_HEADER_PREFIX.replace(/:$/, ''),
        limit: 50,
      }),
    );
    for (const message of results) {
      const header = parseChannelHeader(message.text);
      if (!header) continue;
      const peerId = message.chat?.id;
      if (peerId === undefined) continue;
      return { channelId: String(peerId), header };
    }
    return null;
  }

  async publishChannelHeader(channelId: string, header: ChannelHeader): Promise<number> {
    const chat = await this.resolveChat(channelId);
    const message = await withFloodWait(() =>
      this.requireClient().sendText(chat.inputPeer, channelHeaderCaption(header)),
    );
    return message.id;
  }

  async uploadEncrypted(input: UploadInput): Promise<number> {
    const client = this.requireClient();
    const chat = await this.resolveChat(input.channelId);
    const uploaded = await client.uploadFile({
      file: input.bytes,
      fileName: input.fileName,
      fileMime: 'application/octet-stream',
      progressCallback: (done: number, total: number) => {
        input.onProgress?.(total > 0 ? done / total : 0);
      },
      ...(input.signal ? { abortSignal: input.signal } : {}),
    });
    const message = await withFloodWait(
      () =>
        client.sendMedia(
          chat.inputPeer,
          InputMedia.document(uploaded, {
            fileName: input.fileName,
            fileMime: 'application/octet-stream',
          }),
          input.caption ? { caption: input.caption } : {},
        ),
      input.onFloodWait,
    );
    return message.id;
  }

  async downloadOriginal(
    channelId: string,
    messageId: number,
    options: { signal?: AbortSignal; onProgress?: (fraction: number) => void } = {},
  ): Promise<Uint8Array> {
    const client = this.requireClient();
    const chat = await this.resolveChat(channelId);
    const [message] = await client.getMessages(chat.inputPeer, [messageId]);
    if (!message?.media) throw new Error('This message has no downloadable file.');
    return withFloodWait(() =>
      client.downloadAsBuffer(message.media as never, {
        progressCallback: (done: number, total: number) => {
          options.onProgress?.(total > 0 ? done / total : 0);
        },
        ...(options.signal ? { abortSignal: options.signal } : {}),
      }),
    );
  }

  async deleteMessages(channelId: string, ids: readonly number[]): Promise<void> {
    if (ids.length === 0) return;
    const chat = await this.resolveChat(channelId);
    await withFloodWait(() =>
      this.requireClient().deleteMessagesById(chat.inputPeer, [...ids]),
    );
  }
}

export const telegramService = new TelegramService();
