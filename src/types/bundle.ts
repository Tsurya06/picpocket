import type { PackedSliceLocation, VaultMetadata } from './media';
import { isVaultMetadata } from './media';

/**
 * Sealed index for one `bundle_<uuid>.bin` container.
 *
 * The bundle itself is a plain concatenation of individually AES-256-GCM sealed
 * items; without this index the bytes are unusable. The index is encrypted with
 * the vault key before upload, so filenames, MIME types and offsets never leak.
 */
export interface MediaBundleEntry {
  readonly meta: VaultMetadata;
  readonly origin: PackedSliceLocation;
  readonly thumb: PackedSliceLocation | null;
}

export interface MediaBundleIndex {
  readonly v: 1;
  readonly bundleId: string;
  readonly channelId: string;
  readonly createdAt: number;
  readonly bundleMessageId: number;
  readonly entries: readonly MediaBundleEntry[];
}

const isSlice = (value: unknown): value is PackedSliceLocation => {
  if (typeof value !== 'object' || value === null) return false;
  const slice = value as Record<string, unknown>;
  return (
    typeof slice.bundleMessageId === 'number' &&
    typeof slice.byteOffset === 'number' &&
    Number.isInteger(slice.byteOffset) &&
    slice.byteOffset >= 0 &&
    typeof slice.byteLength === 'number' &&
    Number.isInteger(slice.byteLength) &&
    slice.byteLength > 0
  );
};

const isEntry = (value: unknown): value is MediaBundleEntry => {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  if (!isVaultMetadata(entry.meta) || !isSlice(entry.origin)) return false;
  return entry.thumb === null || isSlice(entry.thumb);
};

export function isMediaBundleIndex(value: unknown): value is MediaBundleIndex {
  if (typeof value !== 'object' || value === null) return false;
  const index = value as Record<string, unknown>;
  return (
    index.v === 1 &&
    typeof index.bundleId === 'string' &&
    typeof index.channelId === 'string' &&
    typeof index.createdAt === 'number' &&
    typeof index.bundleMessageId === 'number' &&
    Array.isArray(index.entries) &&
    index.entries.every(isEntry)
  );
}
