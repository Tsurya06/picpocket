/**
 * Channel vault headers.
 *
 * A header is a small public message stored in the channel itself:
 *
 *   TGP1H:<base64url JSON>
 *   { "v": 1, "saltB64": "...", "verifierB64": "TGP1V:..." }
 *
 * The salt and verifier are exactly what the owner's vault profile holds, so
 * any device that signs into the same account can find the header, derive the
 * same key with the same passphrase, and decrypt existing items. Nothing
 * secret is published: the verifier is an encrypted known plaintext, and the
 * salt is public by design.
 */
import { META_CAPTION_PREFIX } from './captions';

export const CHANNEL_HEADER_PREFIX = 'TGP1H:';

export interface ChannelHeader {
  readonly v: 1;
  readonly saltB64: string;
  readonly verifierB64: string;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const toBase64Url = (value: string): string => {
  let binary = '';
  const bytes = textEncoder.encode(value);
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const fromBase64Url = (value: string): string => {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return textDecoder.decode(bytes);
};

export const channelHeaderCaption = (header: ChannelHeader): string =>
  `${CHANNEL_HEADER_PREFIX}${toBase64Url(JSON.stringify(header))}`;

export const isChannelHeaderCaption = (caption: string | null | undefined): boolean =>
  typeof caption === 'string' && caption.startsWith(CHANNEL_HEADER_PREFIX);

export const parseChannelHeader = (
  caption: string | null | undefined,
): ChannelHeader | null => {
  if (!isChannelHeaderCaption(caption) || typeof caption !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(fromBase64Url(caption.slice(CHANNEL_HEADER_PREFIX.length)));
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
    return { v: 1, saltB64: candidate.saltB64, verifierB64: candidate.verifierB64 };
  } catch {
    return null;
  }
};

/** Header captions must never be mistaken for media metadata captions. */
export const isVaultCaption = (caption: string | null | undefined): boolean =>
  typeof caption === 'string' && caption.startsWith(META_CAPTION_PREFIX);
