/**
 * A channel header is a public message holding the channel's vault salt and
 * verifier, so any device signing into the same account can derive the key.
 */
import { CHANNEL_HEADER_PREFIX } from './captions';
import { fromBase64Url, toBase64Url, utf8ToBytes } from '../encoding';

export interface ChannelHeader {
  readonly v: 1;
  readonly saltB64: string;
  readonly verifierB64: string;
  readonly recovery?: unknown;
  readonly passphraseWrap?: unknown;
}

export const channelHeaderCaption = (header: ChannelHeader): string =>
  `${CHANNEL_HEADER_PREFIX}${toBase64Url(utf8ToBytes(JSON.stringify(header)))}`;

export const parseChannelHeader = (
  caption: string | null | undefined,
): ChannelHeader | null => {
  if (typeof caption !== 'string' || !caption.startsWith(CHANNEL_HEADER_PREFIX)) return null;
  try {
    const parsed: unknown = JSON.parse(
      new TextDecoder().decode(fromBase64Url(caption.slice(CHANNEL_HEADER_PREFIX.length))),
    );
    if (typeof parsed !== 'object' || parsed === null) return null;
    const candidate = parsed as Record<string, unknown>;
    if (
      candidate.v !== 1 ||
      typeof candidate.saltB64 !== 'string' ||
      typeof candidate.verifierB64 !== 'string' ||
      !candidate.verifierB64.startsWith('TGP1V:') ||
      candidate.saltB64.length === 0
    ) {
      return null;
    }
    return {
      v: 1,
      saltB64: candidate.saltB64,
      verifierB64: candidate.verifierB64,
      ...(candidate.recovery !== undefined ? { recovery: candidate.recovery } : {}),
      ...(candidate.passphraseWrap !== undefined
        ? { passphraseWrap: candidate.passphraseWrap }
        : {}),
    };
  } catch {
    return null;
  }
};
