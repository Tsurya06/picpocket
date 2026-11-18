const SAMPLE_RATE = 8_000;
const LOOP_SECONDS = 8;
const TONE_HZ = 60;
/**
 * Chrome & Chromium only exempt tabs from background throttling when the page
 * is playing audible media or holding a wake lock. An inaudible tone (1% volume)
 * keeps Chromium from suspending the sync process.
 */
const VOLUME = 0.01;

let audio: HTMLAudioElement | null = null;
let audioUrl: string | null = null;
let wanted = false;
let active = false;
let retryHandler: (() => void) | null = null;
let wakeLockSentinel: WakeLockSentinel | null = null;
const listeners = new Set<(active: boolean) => void>();

function setActive(next: boolean): void {
  if (active === next) return;
  active = next;
  for (const listener of listeners) {
    listener(active);
  }
}

/** Check if keep alive is currently active */
export function isSyncKeepAliveActive(): boolean {
  return active;
}

/** Lets the settings switch follow the automatic keep-alive state. */
export function subscribeSyncKeepAlive(listener: (active: boolean) => void): () => void {
  listeners.add(listener);
  listener(active);
  return () => {
    listeners.delete(listener);
  };
}

/** Creates a tiny looped WAV in memory so there is no extra network asset. */
function toneUrl(): string {
  if (audioUrl) return audioUrl;

  const sampleCount = SAMPLE_RATE * LOOP_SECONDS;
  const dataSize = sampleCount * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeText = (offset: number, text: string): void => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };

  writeText(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeText(8, 'WAVE');
  writeText(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, 'data');
  view.setUint32(40, dataSize, true);

  for (let index = 0; index < sampleCount; index += 1) {
    const sample = Math.sin((2 * Math.PI * TONE_HZ * index) / SAMPLE_RATE);
    view.setInt16(44 + index * 2, Math.round(sample * 0x7fff), true);
  }

  audioUrl = URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
  return audioUrl;
}

function ensureAudio(): HTMLAudioElement {
  if (audio) return audio;

  const element = new Audio(toneUrl());
  element.loop = true;
  element.volume = VOLUME;
  element.preload = 'auto';
  element.setAttribute('aria-hidden', 'true');
  element.style.display = 'none';
  element.addEventListener('play', () => setActive(true));
  element.addEventListener('pause', () => {
    if (!wanted) setActive(false);
  });
  document.body.appendChild(element);
  audio = element;
  return element;
}

async function requestWakeLock(): Promise<void> {
  if (typeof navigator === 'undefined' || !('wakeLock' in navigator)) return;
  try {
    if (!wakeLockSentinel || wakeLockSentinel.released) {
      wakeLockSentinel = await navigator.wakeLock.request('screen');
      wakeLockSentinel.addEventListener('release', () => {
        wakeLockSentinel = null;
      });
    }
  } catch {
    // Wake Lock may fail when page is in background or low battery
  }
}

function releaseWakeLock(): void {
  if (wakeLockSentinel) {
    try {
      void wakeLockSentinel.release();
    } catch {
      // Ignore release errors
    }
    wakeLockSentinel = null;
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (wanted && document.visibilityState === 'visible') {
      void requestWakeLock();
      if (audio && audio.paused) {
        void audio.play().catch(() => undefined);
      }
    }
  });
}

function updateMediaSession(): void {
  if (!('mediaSession' in navigator)) return;
  if (typeof MediaMetadata !== 'undefined') {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: 'PicPocket folder sync',
      artist: 'Syncing in background',
      album: 'PicPocket',
    });
  }
  navigator.mediaSession.playbackState = 'playing';
}

function clearMediaSession(): void {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = null;
  navigator.mediaSession.playbackState = 'none';
}

function removeRetryHandler(): void {
  if (!retryHandler) return;
  window.removeEventListener('pointerdown', retryHandler, true);
  retryHandler = null;
}

/**
 * Autoplay is blocked without a user gesture, so automatic on-open syncs arm a
 * one-shot pointerdown retry. A manual click starts inside the gesture.
 */
function armGestureRetry(): void {
  if (retryHandler || !wanted) return;

  retryHandler = () => {
    removeRetryHandler();
    if (!wanted) return;
    void requestWakeLock();
    void ensureAudio()
      .play()
      .then(() => {
        if (wanted) {
          setActive(true);
          updateMediaSession();
        }
      })
      .catch(() => {
        if (wanted) armGestureRetry();
      });
  };
  window.addEventListener('pointerdown', retryHandler, true);
}

/** Starts the keep-alive loop and wake lock. Safe to call repeatedly. */
export async function startSyncKeepAlive(): Promise<boolean> {
  if (typeof window === 'undefined') return false;

  wanted = true;
  void requestWakeLock();

  if (typeof Audio === 'undefined') return false;

  const element = ensureAudio();
  try {
    await element.play();
    removeRetryHandler();
    setActive(true);
    updateMediaSession();
    return true;
  } catch {
    armGestureRetry();
    return false;
  }
}

/** Stops the loop and releases wake lock when sync finishes or user turns it off. */
export function stopSyncKeepAlive(): void {
  wanted = false;
  removeRetryHandler();
  releaseWakeLock();
  if (audio) {
    audio.pause();
    audio.currentTime = 0;
  }
  setActive(false);
  clearMediaSession();
}
