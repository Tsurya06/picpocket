import type { MediaKind } from '../../types/media';
import { cryptoClient } from '../crypto/cryptoClient';

export interface PreparedMedia {
  /** Sanitised origin bytes (EXIF/XMP stripped for images). */
  readonly original: ArrayBuffer;
  readonly thumb: { readonly bytes: ArrayBuffer; readonly mime: string } | null;
  readonly width: number;
  readonly height: number;
  readonly kind: MediaKind;
  readonly takenAt: number;
  readonly strippedBytes: number;
  readonly duration?: number;
}

const POSTER_MAX_EDGE = 512;
const POSTER_QUALITY = 0.82;
const VIDEO_LOAD_TIMEOUT_MS = 15_000;

interface VideoProbe {
  readonly thumb: Blob | null;
  readonly width: number;
  readonly height: number;
  readonly duration: number;
}

const waitForEvent = (target: HTMLVideoElement, event: 'loadeddata' | 'seeked'): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error('Timed out while reading the video.'));
    }, VIDEO_LOAD_TIMEOUT_MS);
    const onDone = (): void => {
      cleanup();
      resolve();
    };
    const onError = (): void => {
      cleanup();
      reject(new Error('This video format cannot be decoded by the browser.'));
    };
    const cleanup = (): void => {
      window.clearTimeout(timeout);
      target.removeEventListener(event, onDone);
      target.removeEventListener('error', onError);
    };
    target.addEventListener(event, onDone, { once: true });
    target.addEventListener('error', onError, { once: true });
  });

/**
 * Videos cannot be decoded inside a worker (no <video> there), so the poster
 * frame is rendered on the main thread with a muted, off-screen element and
 * then encrypted in the worker like any other bytes.
 */
async function probeVideo(file: File): Promise<VideoProbe> {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.preload = 'metadata';
  video.muted = true;
  video.playsInline = true;
  video.crossOrigin = 'anonymous';

  try {
    video.src = url;
    await waitForEvent(video, 'loadeddata');
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    if (duration > 0) {
      video.currentTime = Math.min(1, Math.max(0.1, duration * 0.1));
      try {
        await waitForEvent(video, 'seeked');
      } catch {
        // Poster at t=0 is still better than nothing.
      }
    }

    const width = video.videoWidth;
    const height = video.videoHeight;
    if (width === 0 || height === 0) return { thumb: null, width, height, duration };

    const scale = Math.min(1, POSTER_MAX_EDGE / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext('2d');
    if (!context) return { thumb: null, width, height, duration };
    context.imageSmoothingQuality = 'high';
    context.drawImage(video, 0, 0, canvas.width, canvas.height);

    const thumb = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((blob) => resolve(blob), 'image/webp', POSTER_QUALITY);
    });
    return { thumb, width, height, duration };
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}

export async function prepareImageFile(file: File): Promise<PreparedMedia> {
  const data = await file.arrayBuffer();
  const mime = file.type || 'image/jpeg';
  const result = await cryptoClient.prepareMedia({
    data,
    mime,
    name: file.name,
    lastModified: file.lastModified || Date.now(),
  });
  return {
    original: result.stripped,
    thumb: result.thumb
      ? { bytes: result.thumb, mime: result.thumbMime ?? 'image/webp' }
      : null,
    width: result.width,
    height: result.height,
    kind: 'photo',
    takenAt: result.takenAt,
    strippedBytes: result.strippedBytes,
  };
}

export async function prepareVideoFile(file: File): Promise<PreparedMedia> {
  const original = await file.arrayBuffer();
  let probe: VideoProbe = { thumb: null, width: 0, height: 0, duration: 0 };
  try {
    probe = await probeVideo(file);
  } catch {
    // Fall back to an upload without a poster.
  }

  const thumb = probe.thumb
    ? { bytes: await probe.thumb.arrayBuffer(), mime: probe.thumb.type || 'image/webp' }
    : null;

  return {
    original,
    thumb,
    width: probe.width,
    height: probe.height,
    kind: 'video',
    // Videos carry no EXIF timestamp we can trust client-side.
    takenAt: file.lastModified || Date.now(),
    strippedBytes: 0,
    duration: probe.duration > 0 ? probe.duration : undefined,
  };
}

/**
 * Anything that is not an image or video is sealed as-is (PDF, ZIP, audio…).
 * There is no preview to generate, so the grid shows a file card instead.
 */
export async function prepareGenericFile(file: File): Promise<PreparedMedia> {
  return {
    original: await file.arrayBuffer(),
    thumb: null,
    width: 0,
    height: 0,
    kind: 'file',
    takenAt: file.lastModified || Date.now(),
    strippedBytes: 0,
  };
}

export async function prepareFile(file: File): Promise<PreparedMedia> {
  if (file.type.startsWith('video/')) return prepareVideoFile(file);
  if (file.type.startsWith('image/')) return prepareImageFile(file);
  return prepareGenericFile(file);
}
