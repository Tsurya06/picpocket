import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { VaultProfile } from '../types/media';
import { getChannelKeyRow, putChannelKeyRow, type ChannelKeyRow } from '../services/cache/db';
import { cryptoClient } from '../services/crypto/cryptoClient';
import { describeError, telegramService } from '../services/telegram/mtprotoClient';

/** Key availability for one selected channel. */
export type ChannelVaultState = 'checking' | 'ready' | 'locked';

export interface ChannelVaultApi {
  readonly states: ReadonlyMap<string, ChannelVaultState>;
  /** Channels whose header exists but needs a passphrase different from ours. */
  readonly lockedIds: readonly string[];
  /** False while the per-channel header scan is still running. */
  readonly settled: boolean;
  /** Bumped whenever a channel key becomes available, so timelines re-decode. */
  readonly version: number;
  readonly error: string | null;
  readonly unlock: (channelId: string, passphrase: string) => Promise<boolean>;
  readonly recheck: () => void;
}

/**
 * Cross-device vault synchronisation.
 *
 * The first device to open a channel publishes a `TGP1H:` header holding the
 * salt and verifier of the owner's vault. Every later device finds that header,
 * re-derives the same channel key from the same passphrase, and caches it in
 * the worker — without ever touching the primary vault profile, so viewing a
 * shared channel can never lock the user out of their own vault.
 */
export function useChannelVaults(options: {
  readonly channelIds: readonly string[];
  readonly enabled: boolean;
  readonly profile: VaultProfile | null;
}): ChannelVaultApi {
  const { channelIds, enabled, profile } = options;
  const idKey = useMemo(() => [...channelIds].sort().join('|'), [channelIds]);
  const ids = useMemo(() => (idKey.length === 0 ? [] : idKey.split('|')), [idKey]);

  const [states, setStates] = useState<Map<string, ChannelVaultState>>(new Map());
  const [settled, setSettled] = useState(false);
  const [version, setVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [recheckToken, setRecheckToken] = useState(0);

  const runRef = useRef(0);
  /** Channels whose key was already available, so a rescan does not re-trigger reloads. */
  const readyRef = useRef(new Set<string>());

  const mark = useCallback((channelId: string, state: ChannelVaultState) => {
    setStates((current) => {
      if (current.get(channelId) === state) return current;
      const next = new Map(current);
      next.set(channelId, state);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!enabled || !profile || ids.length === 0) {
      setStates(new Map());
      setSettled(!enabled ? false : true);
      return;
    }

    const run = runRef.current + 1;
    runRef.current = run;
    let cancelled = false;

    // Keep any channel that is already resolved instead of flashing "checking".
    setStates((current) => {
      const next = new Map<string, ChannelVaultState>();
      for (const id of ids) next.set(id, current.get(id) ?? 'checking');
      return next;
    });
    setSettled(false);
    setError(null);

    void (async () => {
      let opened = 0;

      for (const channelId of ids) {
        if (cancelled || runRef.current !== run) return;
        try {
          const cached = await getChannelKeyRow(channelId);
          if (cancelled || runRef.current !== run) return;

          if (cached) {
            const matched = await cryptoClient.syncChannelHeader(
              channelId,
              cached.saltB64,
              cached.verifierB64,
            );
            if (cancelled || runRef.current !== run) return;
            if (matched) {
              if (!readyRef.current.has(channelId)) {
                readyRef.current.add(channelId);
                opened += 1;
              }
              mark(channelId, 'ready');
              continue;
            }
            // The cached header belongs to another vault; scan the channel for
            // one that opens with our passphrase before giving up.
          }

          const headers = await telegramService.findChannelHeaders(channelId);
          if (cancelled || runRef.current !== run) return;

          // A channel can carry several headers when different vaults wrote to
          // it; the first one that opens with our passphrase is ours.
          let matchedAny = false;
          for (const candidate of headers) {
            const matched = await cryptoClient.syncChannelHeader(
              channelId,
              candidate.header.saltB64,
              candidate.header.verifierB64,
            );
            if (cancelled || runRef.current !== run) return;
            if (!matched) continue;
            await putChannelKeyRow({
              channelId,
              saltB64: candidate.header.saltB64,
              verifierB64: candidate.header.verifierB64,
            });
            if (!readyRef.current.has(channelId)) {
              readyRef.current.add(channelId);
              opened += 1;
            }
            matchedAny = true;
            mark(channelId, 'ready');
            break;
          }
          if (matchedAny) continue;

          const ours = headers.find((entry) => entry.header.saltB64 === profile.salt);
          if (!ours) {
            // Publish our own header so devices sharing this passphrase can
            // find it, even when another vault already wrote to the channel.
            // Read-only channels reject the write; the primary key still works.
            try {
              await telegramService.publishChannelHeader(channelId, {
                v: 1,
                saltB64: profile.salt,
                verifierB64: profile.verifier,
              });
            } catch {
              // No posting rights here.
            }
          }
          if (cancelled || runRef.current !== run) return;

          const firstHeader = headers[0];
          if (firstHeader) {
            // Nothing opened: remember the header so the banner can prompt for
            // this specific channel's passphrase.
            await putChannelKeyRow({
              channelId,
              saltB64: firstHeader.header.saltB64,
              verifierB64: firstHeader.header.verifierB64,
            });
            mark(channelId, 'locked');
          } else {
            // No header at all and we could not publish one: use the primary key.
            readyRef.current.add(channelId);
            mark(channelId, 'ready');
          }
        } catch (caught) {
          if (cancelled || runRef.current !== run) return;
          setError(describeError(caught));
          mark(channelId, 'locked');
        }
      }

      if (cancelled || runRef.current !== run) return;
      setSettled(true);
      if (opened > 0) setVersion((value) => value + 1);
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled, ids, mark, profile, recheckToken]);

  /**
   * Unlocks one channel. Works even when the header was never cached locally:
   * it is looked up in Telegram on demand, so a device that skipped the initial
   * scan can still be unlocked from the banner.
   */
  const unlock = useCallback(
    async (channelId: string, passphrase: string): Promise<boolean> => {
      setError(null);
      try {
        let row: Omit<ChannelKeyRow, 'lastUsed'> | undefined =
          await getChannelKeyRow(channelId);
        if (!row) {
          const found = await telegramService.findChannelHeader(channelId);
          if (!found) {
            setError(
              'This channel has not published a vault header yet. Press refresh after the device that uploaded to it opens PicPocket once.',
            );
            return false;
          }
          row = {
            channelId,
            saltB64: found.header.saltB64,
            verifierB64: found.header.verifierB64,
          };
          await putChannelKeyRow(row);
        }
        await cryptoClient.unlockChannel(
          channelId,
          passphrase,
          row.saltB64,
          row.verifierB64,
        );
        mark(channelId, 'ready');
        setVersion((value) => value + 1);
        return true;
      } catch (caught) {
        setError(describeError(caught));
        return false;
      }
    },
    [mark],
  );

  const recheck = useCallback(() => {
    setRecheckToken((value) => value + 1);
  }, []);

  const lockedIds = ids.filter((id) => states.get(id) === 'locked');

  return { states, lockedIds, settled, version, error, unlock, recheck };
}
