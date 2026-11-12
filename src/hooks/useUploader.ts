import { useCallback, useRef, useState } from 'react';
import type { UploadProgress, UploadResult } from '../types/media';
import { uploadBatch } from '../services/media/uploader';

export interface UploaderApi {
  progress: UploadProgress | null;
  result: UploadResult | null;
  upload: (files: readonly File[], targetChannelId: string, encrypt: boolean) => Promise<void>;
  cancel: () => void;
  dismiss: () => void;
}

/**
 * Batch uploader: small vault items are packed into ~32 MB containers, large
 * files use the standalone path, and every RPC is serialised by the anti-ban
 * guard. Progress still tracks one file at a time for the pill.
 */
export function useUploader(onFinished?: () => void): UploaderApi {
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [result, setResult] = useState<UploadResult | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const busyRef = useRef(false);

  const upload = useCallback(
    async (files: readonly File[], targetChannelId: string, encrypt: boolean) => {
      if (busyRef.current || files.length === 0) return;
      if (!targetChannelId) {
        setResult({
          uploaded: 0,
          failed: [{ name: files[0]?.name ?? 'Upload', reason: 'Select a channel first.' }],
        });
        return;
      }

      busyRef.current = true;
      const controller = new AbortController();
      abortRef.current = controller;
      setResult(null);

      let completed = 0;
      let failed = 0;
      const failures: { name: string; reason: string }[] = [];

      setProgress({
        total: files.length,
        completed: 0,
        failed: 0,
        currentName: files[0]?.name ?? '',
        currentFraction: 0,
        processing: true,
      });

      try {
        const results = await uploadBatch({
          channelId: targetChannelId,
          files,
          encrypt,
          signal: controller.signal,
          onItemStart: (_index, file) => {
            setProgress((current) =>
              current
                ? { ...current, currentName: file.name, currentFraction: 0, processing: true }
                : current,
            );
          },
          onItemProgress: (_index, fraction) => {
            setProgress((current) =>
              current ? { ...current, currentFraction: fraction, processing: false } : current,
            );
          },
          onBundleProgress: (label) => {
            setProgress((current) =>
              current ? { ...current, currentName: label, processing: true } : current,
            );
          },
          onFloodWait: (seconds) => {
            setProgress((current) =>
              current
                ? {
                    ...current,
                    currentName: `Telegram asked to slow down — resuming in ${seconds}s`,
                    processing: true,
                  }
                : current,
            );
          },
        });

        results.forEach((result) => {
          if (result.outcome) completed += 1;
          else {
            failed += 1;
            failures.push({ name: result.file.name, reason: result.error ?? 'Upload failed.' });
          }
        });
      } catch (caught) {
        if (!controller.signal.aborted) {
          failed = files.length - completed;
          failures.push({
            name: files[0]?.name ?? 'Upload',
            reason: caught instanceof Error ? caught.message : 'Upload failed.',
          });
        }
      }

      setProgress((current) =>
        current
          ? {
              ...current,
              completed,
              failed,
              currentFraction: 1,
              processing: false,
            }
          : current,
      );

      busyRef.current = false;
      abortRef.current = null;
      setProgress((current) => (current ? { ...current, processing: false } : current));
      setResult({ uploaded: completed, failed: failures });
      if (completed > 0) onFinished?.();
    },
    [onFinished],
  );

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    busyRef.current = false;
    setProgress((current) => (current ? { ...current, processing: false } : current));
  }, []);

  const dismiss = useCallback(() => {
    if (busyRef.current) return;
    setProgress(null);
    setResult(null);
  }, []);

  return { progress, result, upload, cancel, dismiss };
}
