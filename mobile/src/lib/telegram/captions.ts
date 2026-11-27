/** Caption conventions shared with the web app. */
export const META_CAPTION_PREFIX = 'TGP1M:';
export const THUMB_CAPTION_PREFIX = 'TGP1T:';
export const BACKUP_CHUNK_PREFIX = 'WAB1C:';
export const BACKUP_MANIFEST_PREFIX = 'WAB1M:';
export const CHANNEL_HEADER_PREFIX = 'TGP1H:';

export const isMetaCaption = (caption: string | null | undefined): boolean =>
  typeof caption === 'string' && caption.startsWith(META_CAPTION_PREFIX);

export const isBackupCaption = (caption: string | null | undefined): boolean =>
  typeof caption === 'string' &&
  (caption.startsWith(BACKUP_CHUNK_PREFIX) || caption.startsWith(BACKUP_MANIFEST_PREFIX));

export const isBackupManifestCaption = (caption: string | null | undefined): boolean =>
  typeof caption === 'string' && caption.startsWith(BACKUP_MANIFEST_PREFIX);

export const backupChunkCaption = (backupId: string, index: number, total: number): string =>
  `${BACKUP_CHUNK_PREFIX}${backupId}:${index}:${total}`;

export const backupManifestCaption = (backupId: string): string =>
  `${BACKUP_MANIFEST_PREFIX}${backupId}`;

export const thumbCaptionFor = (mediaId: string): string => `${THUMB_CAPTION_PREFIX}${mediaId}`;

export const parseThumbCaption = (caption: string | null | undefined): string | null => {
  if (typeof caption !== 'string' || !caption.startsWith(THUMB_CAPTION_PREFIX)) return null;
  const id = caption.slice(THUMB_CAPTION_PREFIX.length).trim();
  return id.length > 0 ? id : null;
};
