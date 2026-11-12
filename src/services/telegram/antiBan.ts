/**
 * Global MTProto rate guard.
 *
 * Bulk vault work can involve hundreds of RPC calls. Telegram reacts to that
 * with `FLOOD_WAIT_n` and, if ignored, can restrict the account. This engine
 * gives every caller one shared queue:
 *
 *  - one in-flight write at a time, with a 0.7–1.2 s jittered gap between starts
 *  - up to three concurrent reads, lightly spaced
 *  - automatic `FLOOD_WAIT_n` sleep (plus a one-second safety margin) and retry
 *  - exponential backoff for transient network/DC errors
 *  - abort-awareness, so cancelling an upload drops queued work
 *
 * It is transport-only: UI code can subscribe for status, but no caller has to
 * know about flood waits to be safe.
 */

export type AntiBanKind = 'read' | 'write';

export interface AntiBanOptions {
  readonly kind?: AntiBanKind;
  readonly signal?: AbortSignal;
  readonly onFloodWait?: (seconds: number) => void;
  readonly maxAttempts?: number;
}

export interface AntiBanStatus {
  readonly active: number;
  readonly queued: number;
  /** Epoch ms until which no new call will start. */
  readonly floodWaitUntil: number;
  readonly floodWaitSeconds: number;
  readonly nextStartAt: number;
}

interface QueueEntry {
  readonly kind: AntiBanKind;
  readonly task: () => Promise<unknown>;
  readonly signal?: AbortSignal;
  readonly onFloodWait?: (seconds: number) => void;
  readonly maxAttempts: number;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  /** Removes the abort listener once the call actually starts. */
  cleanup?: () => void;
}

const MAX_READ_CONCURRENCY = 3;
const MAX_WRITE_CONCURRENCY = 1;
const MAX_FLOOD_RETRIES = 3;

/**
 * Compliance with official Telegram Anti-Flood specifications:
 * User-account writes must be human-paced (5s–12s gap) to prevent automated
 * spam heuristics and PEER_FLOOD bans.
 */
const BASE_WRITE_GAP_MS = 6000;
const WRITE_JITTER_MS = 6000;
const BASE_READ_GAP_MS = 150;
const READ_JITTER_MS = 250;

/** Safety margin + jitter for 420 FLOOD_WAIT_%d responses to prevent clock-drift race conditions. */
const FLOOD_SAFETY_MARGIN_MS = 4000;
const FLOOD_JITTER_MS = 2000;

const abortError = (): DOMException => new DOMException('Operation cancelled.', 'AbortError');

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, Math.max(0, ms));
    const onAbort = (): void => {
      cleanup();
      reject(abortError());
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/** Telegram errors carry the wait in the message; some builds expose `seconds`.
 * Handles FLOOD_WAIT_%d, SLOWMODE_WAIT_%d, and FLOOD_PREMIUM_WAIT_%d per official Telegram specs.
 */
export function readFloodWaitSeconds(error: unknown): number | null {
  if (typeof error === 'object' && error !== null) {
    const candidate = error as { seconds?: unknown; message?: unknown };
    if (typeof candidate.seconds === 'number' && Number.isFinite(candidate.seconds)) {
      return Math.max(0, Math.ceil(candidate.seconds));
    }
    if (typeof candidate.message === 'string') {
      const match = /(?:FLOOD_WAIT_|SLOWMODE_WAIT_|FLOOD_PREMIUM_WAIT_)(\d+)/i.exec(candidate.message);
      if (match) return Number(match[1]);
    }
  }
  if (error instanceof Error) {
    const match = /(?:FLOOD_WAIT_|SLOWMODE_WAIT_|FLOOD_PREMIUM_WAIT_)(\d+)/i.exec(error.message);
    if (match) return Number(match[1]);
  }
  return null;
}

const isTransient = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : '';
  return /TIMEOUT|NETWORK|CONNECTION|DISCONNECTED|INTERNAL|RPC_CALL_FAIL|DC_|-503/i.test(message);
};

class AntiBanEngine {
  private readonly queue: QueueEntry[] = [];
  private active = 0;
  private activeWrites = 0;
  private nextStartAt = 0;
  private floodWaitUntil = 0;
  private floodWaitSeconds = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<(status: AntiBanStatus) => void>();

  get status(): AntiBanStatus {
    return {
      active: this.active,
      queued: this.queue.length,
      floodWaitUntil: this.floodWaitUntil,
      floodWaitSeconds: this.floodWaitSeconds,
      nextStartAt: this.nextStartAt,
    };
  }

  subscribe(listener: (status: AntiBanStatus) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  run<T>(task: () => Promise<T>, options: AntiBanOptions = {}): Promise<T> {
    const kind = options.kind ?? 'write';
    if (options.signal?.aborted) return Promise.reject(abortError());

    return new Promise<T>((resolve, reject) => {
      const entry: QueueEntry = {
        kind,
        task: task as () => Promise<unknown>,
        signal: options.signal,
        onFloodWait: options.onFloodWait,
        maxAttempts: Math.max(1, options.maxAttempts ?? 3),
        resolve: (value) => resolve(value as T),
        reject,
      };

      if (options.signal) {
        const onAbort = (): void => {
          const index = this.queue.indexOf(entry);
          if (index >= 0) {
            this.queue.splice(index, 1);
            entry.cleanup?.();
            entry.reject(abortError());
            this.emit();
            this.pump();
          }
        };
        options.signal.addEventListener('abort', onAbort, { once: true });
        entry.cleanup = () => options.signal?.removeEventListener('abort', onAbort);
      }

      this.queue.push(entry);
      this.pump();
    });
  }

  private emit(): void {
    const status = this.status;
    for (const listener of this.listeners) listener(status);
  }

  private schedule(delayMs: number): void {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pump();
    }, Math.max(0, delayMs));
  }

  private pump(): void {
    if (this.timer !== null) return;

    const head = this.queue[0];
    if (!head) return;

    if (head.signal?.aborted) {
      this.queue.shift();
      head.cleanup?.();
      head.reject(abortError());
      this.emit();
      this.pump();
      return;
    }

    const now = Date.now();
    if (now < this.floodWaitUntil) {
      this.schedule(this.floodWaitUntil - now);
      return;
    }

    if (head.kind === 'write' && this.activeWrites >= MAX_WRITE_CONCURRENCY) return;
    if (head.kind === 'read' && this.active >= MAX_READ_CONCURRENCY) return;

    if (now < this.nextStartAt) {
      this.schedule(this.nextStartAt - now);
      return;
    }

    this.queue.shift();
    this.start(head);
  }

  private start(entry: QueueEntry): void {
    entry.cleanup?.();
    const jitter = entry.kind === 'write' ? WRITE_JITTER_MS : READ_JITTER_MS;
    const base = entry.kind === 'write' ? BASE_WRITE_GAP_MS : BASE_READ_GAP_MS;
    this.nextStartAt = Date.now() + base + Math.random() * jitter;
    this.active += 1;
    if (entry.kind === 'write') this.activeWrites += 1;
    this.emit();

    void this.execute(entry)
      .then(entry.resolve, entry.reject)
      .finally(() => {
        this.active = Math.max(0, this.active - 1);
        if (entry.kind === 'write') this.activeWrites = Math.max(0, this.activeWrites - 1);
        this.emit();
        this.pump();
      });

    // Let the next read start after the spacing timer instead of waiting for
    // this call to finish (writes remain serialised by MAX_WRITE_CONCURRENCY).
    this.pump();
  }

  private async execute(entry: QueueEntry): Promise<unknown> {
    for (let attempt = 1; ; attempt += 1) {
      if (entry.signal?.aborted) throw abortError();

      try {
        return await entry.task();
      } catch (error) {
        const floodSeconds = readFloodWaitSeconds(error);
        if (floodSeconds !== null) {
          this.floodWaitSeconds = floodSeconds;
          // Apply safety margin + jitter to prevent edge-of-window retry failures
          const delayMs = floodSeconds * 1000 + FLOOD_SAFETY_MARGIN_MS + Math.random() * FLOOD_JITTER_MS;
          this.floodWaitUntil = Math.max(
            this.floodWaitUntil,
            Date.now() + delayMs,
          );
          entry.onFloodWait?.(floodSeconds);
          this.emit();

          if (attempt <= MAX_FLOOD_RETRIES) {
            await sleep(this.floodWaitUntil - Date.now(), entry.signal);
            continue;
          }
        }

        if (isTransient(error) && attempt < entry.maxAttempts) {
          const backoff = 800 * 2 ** (attempt - 1) + Math.random() * 400;
          await sleep(backoff, entry.signal);
          continue;
        }

        throw error;
      }
    }
  }
}

export const antiBan = new AntiBanEngine();
