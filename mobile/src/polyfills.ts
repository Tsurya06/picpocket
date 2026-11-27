/**
 * Hermes has no WebCrypto and, depending on the RN build, no TextEncoder.
 * Everything below is loaded before any other module.
 */
import { getRandomBytes } from 'expo-crypto';
import { strFromU8, strToU8 } from 'fflate';

type Mutable = Record<string, unknown>;
const scope = globalThis as unknown as Mutable;

if (typeof scope.TextEncoder === 'undefined') {
  scope.TextEncoder = class {
    encode(input = ''): Uint8Array {
      return strToU8(String(input));
    }
  };
}

if (typeof scope.TextDecoder === 'undefined') {
  scope.TextDecoder = class {
    decode(input?: ArrayBuffer | ArrayBufferView): string {
      if (!input) return '';
      const bytes =
        input instanceof Uint8Array
          ? input
          : input instanceof ArrayBuffer
            ? new Uint8Array(input)
            : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
      return strFromU8(bytes);
    }
  };
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const encodeBase64 = (bytes: Uint8Array): string => {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    const triplet = (a << 16) | (b << 8) | c;
    out += B64[(triplet >> 18) & 63];
    out += B64[(triplet >> 12) & 63];
    out += i + 1 < bytes.length ? B64[(triplet >> 6) & 63] : '=';
    out += i + 2 < bytes.length ? B64[triplet & 63] : '=';
  }
  return out;
};

const decodeBase64 = (value: string): Uint8Array => {
  const clean = value.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let index = 0;
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    const digit = B64.indexOf(char);
    if (digit < 0) continue;
    buffer = (buffer << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[index] = (buffer >> bits) & 0xff;
      index += 1;
    }
  }
  return out.subarray(0, index);
};

if (typeof scope.btoa === 'undefined') {
  scope.btoa = (value: string): string => {
    const bytes = new Uint8Array(value.length);
    for (let i = 0; i < value.length; i += 1) bytes[i] = value.charCodeAt(i) & 0xff;
    return encodeBase64(bytes);
  };
}

if (typeof scope.atob === 'undefined') {
  scope.atob = (value: string): string =>
    String.fromCharCode(...decodeBase64(value));
}

const randomUUID = (): string => {
  const bytes = getRandomBytes(16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const existing = (scope.crypto as { getRandomValues?: unknown } | undefined) ?? {};

if (typeof existing.getRandomValues !== 'function') {
  scope.crypto = {
    ...existing,
    getRandomValues: <T extends Uint8Array>(array: T): T => {
      array.set(getRandomBytes(array.length));
      return array;
    },
    randomUUID,
  };
}
