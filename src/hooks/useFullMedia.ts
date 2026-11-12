import { useEffect, useState } from 'react';
import type { MediaItem } from '../types/media';
import { cryptoClient } from '../services/crypto/cryptoClient';
import { describeError, telegramService } from '../services/telegram/mtprotoClient';

export interface FullMediaState {
  readonly url: string | null;
  readonly loading: boolean;
  readonly progress: number;
  readonly error: string | null;
  readonly mimeType: string | null;
}

const idle: FullMediaState = {
  url: null,
  loading: false,
  progress: 0,
  error: null,
  mimeType: null,
};

/**
 * Streams the original from Telegram and decrypts it in the worker on demand.
 * The resulting object URL is revoked when the viewer closes or navigates.
 */
export function useFullMedia(item: MediaItem | null, enabled = true): FullMediaState {
  const [state, setState] = useState<FullMediaState>(idle);

  useEffect(() => {
    if (!item || !enabled) {
      setState(idle);
      return;
    }

    let cancelled = false;
    let objectUrl: string | null = null;
    setState({ ...idle, loading: true });

    void (async () => {
      try {
        const onProgress = (fraction: number): void => {
          if (!cancelled) setState((current) => ({ ...current, progress: fraction }));
        };

        const download = item.packed
          ? await telegramService.downloadRange(
              item.channelId,
              item.packed.bundleMessageId,
              item.packed.byteOffset,
              item.packed.byteLength,
              { onProgress },
            )
          : await telegramService.downloadOriginal(item.channelId, item.messageId, {
              onProgress,
            });

        const plaintext = item.packed
          ? await cryptoClient.decryptPacked(download.bytes)
          : item.source === 'vault' || download.encrypted
            ? await cryptoClient.decryptBytes(download.bytes)
            : download.bytes;

        if (cancelled) return;
        const mimeType =
          item.source === 'vault' ? item.mimeType || 'application/octet-stream' : download.mimeType;
        const blob = new Blob([plaintext], { type: mimeType });
        objectUrl = URL.createObjectURL(blob);
        setState({
          url: objectUrl,
          loading: false,
          progress: 1,
          error: null,
          mimeType: blob.type,
        });
      } catch (caught) {
        if (!cancelled) {
          setState({ ...idle, error: describeError(caught) });
        }
      }
    })();

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [enabled, item]);

  return state;
}
