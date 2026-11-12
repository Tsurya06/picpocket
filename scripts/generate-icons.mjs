/**
 * Generates the PWA icons with zero dependencies.
 * A tiny hand-rolled PNG encoder (zlib deflate + CRC32) keeps the repo free
 * of opaque binary assets.
 *
 * Usage: node scripts/generate-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const mix = (a, b, t) => a + (b - a) * clamp01(t);

/** Rounded-rect coverage with a 1px antialiased edge. */
function roundedRect(x, y, left, top, right, bottom, radius) {
  const cx = Math.min(Math.max(x, left + radius), right - radius);
  const cy = Math.min(Math.max(y, top + radius), bottom - radius);
  const dist = Math.hypot(x - cx, y - cy);
  return clamp01(radius - dist + 0.5);
}

/** Point-in-triangle test, used for the "mountain" motif. */
function insideTriangle(px, py, a, b, c) {
  const sign = (p1, p2, p3) =>
    (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1]);
  const d1 = sign([px, py], a, b);
  const d2 = sign([px, py], b, c);
  const d3 = sign([px, py], c, a);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

function draw(size, { fullBleed }) {
  const buf = Buffer.alloc(size * size * 4);
  const scale = size / 512;
  const inset = fullBleed ? 0 : 34 * scale;
  const radius = fullBleed ? 0 : 112 * scale;
  const left = inset;
  const top = inset;
  const right = size - inset;
  const bottom = size - inset;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      const alpha = roundedRect(px, py, left, top, right, bottom, radius);
      const i = (y * size + x) * 4;
      if (alpha <= 0) continue;

      // Diagonal indigo -> teal gradient.
      const t = clamp01((px - left + (py - top)) / (2 * (right - left)));
      let r = mix(56, 13, t);
      let g = mix(103, 148, t);
      let b = mix(214, 136, t);

      // Sun.
      const sunA = clamp01(46 * scale - Math.hypot(px - 168 * scale, py - 168 * scale) + 0.5);
      if (sunA > 0) {
        r = mix(r, 255, sunA);
        g = mix(g, 255, sunA);
        b = mix(b, 255, sunA);
      }

      // Mountains.
      const m1 = insideTriangle(
        px,
        py,
        [118 * scale, 372 * scale],
        [246 * scale, 190 * scale],
        [352 * scale, 372 * scale],
      );
      const m2 = insideTriangle(
        px,
        py,
        [250 * scale, 372 * scale],
        [338 * scale, 248 * scale],
        [420 * scale, 372 * scale],
      );
      const mountainA = Math.max(m1 ? 1 : 0, m2 ? 0.82 : 0);
      if (mountainA > 0) {
        r = mix(r, 255, mountainA);
        g = mix(g, 255, mountainA);
        b = mix(b, 255, mountainA);
      }

      buf[i] = Math.round(r);
      buf[i + 1] = Math.round(g);
      buf[i + 2] = Math.round(b);
      buf[i + 3] = Math.round(alpha * 255);
    }
  }
  return buf;
}

const targets = [
  { file: 'public/icons/icon-192.png', size: 192, fullBleed: false },
  { file: 'public/icons/icon-512.png', size: 512, fullBleed: false },
  { file: 'public/icons/icon-maskable-512.png', size: 512, fullBleed: true },
  { file: 'public/icons/apple-touch-icon.png', size: 180, fullBleed: true },
];

for (const target of targets) {
  const path = join(root, target.file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, encodePng(target.size, draw(target.size, target)));
  console.log(`wrote ${target.file}`);
}
