/**
 * Caption conventions used by the vault:
 *
 *   origin document  →  "TGP1M:<base64url(iv|ciphertext)>"   (sealed metadata)
 *   preview document →  "TGP1T:<mediaId>"                     (link only)
 *   WhatsApp chunk    →  "WAB1C:<backupId>:<index>:<total>"
 *   WhatsApp manifest →  "WAB1M:<backupId>"
 *
 * Captions are the only routing signal, so older clients and other Telegram
 * apps simply render an opaque `.bin` file. Nothing readable leaks.
 */

export const META_CAPTION_PREFIX = 'TGP1M:';
export const THUMB_CAPTION_PREFIX = 'TGP1T:';

export const isMetaCaption = (caption: string | null | undefined): boolean =>
  typeof caption === 'string' && caption.startsWith(META_CAPTION_PREFIX);

export const thumbCaptionFor = (mediaId: string): string => `${THUMB_CAPTION_PREFIX}${mediaId}`;

export const parseThumbCaption = (caption: string | null | undefined): string | null => {
  if (typeof caption !== 'string' || !caption.startsWith(THUMB_CAPTION_PREFIX)) return null;
  const id = caption.slice(THUMB_CAPTION_PREFIX.length).trim();
  return id.length > 0 ? id : null;
};

export const BUNDLE_DOC_PREFIX = 'TGB1C:';
export const BUNDLE_INDEX_PREFIX = 'TGB1B:';

export const bundleDocCaption = (bundleId: string): string => `${BUNDLE_DOC_PREFIX}${bundleId}`;
export const bundleIndexCaption = (bundleId: string): string => `${BUNDLE_INDEX_PREFIX}${bundleId}`;

export const isBundleCaption = (caption: string | null | undefined): boolean =>
  typeof caption === 'string' &&
  (caption.startsWith(BUNDLE_DOC_PREFIX) || caption.startsWith(BUNDLE_INDEX_PREFIX));

export const parseBundleIndexCaption = (
  caption: string | null | undefined,
): { bundleId: string } | null => {
  if (typeof caption !== 'string' || !caption.startsWith(BUNDLE_INDEX_PREFIX)) return null;
  const bundleId = caption.slice(BUNDLE_INDEX_PREFIX.length).trim();
  return bundleId.length > 0 ? { bundleId } : null;
};

export const BACKUP_CHUNK_PREFIX = 'WAB1C:';
export const BACKUP_MANIFEST_PREFIX = 'WAB1M:';

export const isBackupCaption = (caption: string | null | undefined): boolean =>
  typeof caption === 'string' &&
  (caption.startsWith(BACKUP_CHUNK_PREFIX) || caption.startsWith(BACKUP_MANIFEST_PREFIX));

export const isBackupManifestCaption = (caption: string | null | undefined): boolean =>
  typeof caption === 'string' && caption.startsWith(BACKUP_MANIFEST_PREFIX);

export const backupChunkCaption = (backupId: string, index: number, total: number): string =>
  `${BACKUP_CHUNK_PREFIX}${backupId}:${index}:${total}`;

export const backupManifestCaption = (backupId: string): string =>
  `${BACKUP_MANIFEST_PREFIX}${backupId}`;

export const parseBackupManifestCaption = (
  caption: string | null | undefined,
): { backupId: string } | null => {
  if (!isBackupManifestCaption(caption) || typeof caption !== 'string') return null;
  const backupId = caption.slice(BACKUP_MANIFEST_PREFIX.length).trim();
  return backupId.length > 0 ? { backupId } : null;
};
