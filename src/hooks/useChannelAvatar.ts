import { useEffect, useState } from 'react';
import { getCachedAvatar, putCachedAvatar } from '../services/cache/db';
import { telegramService } from '../services/telegram/mtprotoClient';

/** Channel photos are small; cache them once and reuse across sessions. */
export function useChannelAvatar(channelId: string, enabled = true): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) {
      setUrl(null);
      return;
    }

    let cancelled = false;
    let objectUrl: string | null = null;

    void (async () => {
      try {
        const cached = await getCachedAvatar(`channel:${channelId}`);
        let blob = cached;
        if (!blob) {
          blob = (await telegramService.getChannelAvatar(channelId)) ?? undefined;
          if (blob) await putCachedAvatar(`channel:${channelId}`, blob);
        }
        if (!blob || cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      } catch {
        // Avatar failures are cosmetic; fall back to initials.
      }
    })();

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [channelId, enabled]);

  return url;
}
