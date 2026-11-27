import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Directory } from 'expo-file-system';
import { useVault } from '../../state/VaultProvider';
import { scanWhatsAppDirectory } from '../../lib/whatsapp/scan';
import {
  loadRemoteWhatsAppBackup,
  previewWhatsAppSync,
  restoreWhatsAppDatabase,
  syncWhatsAppBackup,
} from '../../lib/whatsapp/sync';
import type {
  BackupProgress,
  DirectoryScan,
  SyncPlanSummary,
} from '../../lib/whatsapp/types';
import { hasAnyMedia } from '../../lib/whatsapp/types';
import { isSyncDue } from '../../lib/schedule';
import { Button, Card, Label, Notice, ProgressBar, Screen, Toggle } from '../../ui';
import { colors, radius, space } from '../../theme';

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

const describe = (failure: unknown): string =>
  failure instanceof DOMException && failure.name === 'AbortError'
    ? 'Cancelled.'
    : failure instanceof Error && failure.message
      ? failure.message
      : 'Something went wrong. Please try again.';

export default function WhatsAppScreen(): JSX.Element {
  const {
    channel,
    folder,
    saveFolder,
    media,
    setMedia,
    autoSync,
    setAutoSync,
    scheduleTime,
    setScheduleTime,
    lastSyncAt,
    markSynced,
  } = useVault();

  const [scan, setScan] = useState<DirectoryScan | null>(null);
  const [summary, setSummary] = useState<SyncPlanSummary | null>(null);
  const [progress, setProgress] = useState<BackupProgress | null>(null);
  const [scanProgress, setScanProgress] = useState<{ files: number; directories: number } | null>(null);
  const [busy, setBusy] = useState<'pick' | 'scan' | 'sync' | 'restore' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [timeDraft, setTimeDraft] = useState(scheduleTime);

  const abortRef = useRef<AbortController | null>(null);
  const runningRef = useRef(false);
  const autoRanRef = useRef(false);

  useEffect(() => setTimeDraft(scheduleTime), [scheduleTime]);

  const pickFolder = async (): Promise<void> => {
    setBusy('pick');
    setError(null);
    setNote(null);
    try {
      const directory = await Directory.pickDirectoryAsync();
      const name = directory.name || 'WhatsApp';
      const isWhatsApp = /whatsapp/i.test(directory.uri) || /whatsapp/i.test(name);
      await saveFolder({ uri: directory.uri, name });
      setScan(null);
      setSummary(null);
      setNote(
        isWhatsApp
          ? `Folder set: ${name}. Tap Scan folder to read it.`
          : `Folder set: ${name}. If scanning finds no msgstore file, pick …/com.whatsapp/WhatsApp instead.`,
      );
    } catch (failure) {
      const message = describe(failure);
      if (!/cancel/i.test(message)) setError(message);
    } finally {
      setBusy(null);
    }
  };

  const scanOnly = useCallback(async (): Promise<DirectoryScan | null> => {
    if (!folder) {
      setError('Pick your WhatsApp folder first.');
      return null;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy('scan');
    setError(null);
    setNote(null);
    setScanProgress({ files: 0, directories: 0 });
    try {
      const result = await scanWhatsAppDirectory(new Directory(folder.uri), {
        signal: controller.signal,
        onProgress: (next) => setScanProgress({ files: next.files, directories: next.directories }),
      });
      setScan(result);
      if (channel) {
        const plan = await previewWhatsAppSync(channel.id, result, media);
        setSummary(plan);
      }
      if (!result.latestDatabase) {
        setError(
          'No msgstore*.db.crypt14/15 file found. Pick the WhatsApp folder itself (Android/media/com.whatsapp/WhatsApp), not a subfolder.',
        );
      }
      return result;
    } catch (failure) {
      setError(describe(failure));
      return null;
    } finally {
      abortRef.current = null;
      setScanProgress(null);
      setBusy(null);
    }
  }, [channel, folder, media]);

  const runBackup = useCallback(
    async (target: DirectoryScan | null): Promise<void> => {
      if (!channel) {
        setError('Select a vault channel in Settings first.');
        return;
      }
      const current = target ?? scan;
      if (!current) {
        setError('Scan the folder first.');
        return;
      }
      if (runningRef.current) return;
      runningRef.current = true;
      const controller = new AbortController();
      abortRef.current = controller;
      setBusy('sync');
      setError(null);
      setNote(null);
      setProgress({
        phase: 'database',
        fraction: 0,
        label: 'Preparing…',
        chunksDone: 0,
        chunksTotal: 0,
        filesDone: 0,
        filesTotal: 0,
        bytesDone: 0,
        bytesTotal: 0,
      });
      try {
        const result = await syncWhatsAppBackup({
          channelId: channel.id,
          scan: current,
          media,
          signal: controller.signal,
          onProgress: setProgress,
        });
        await markSynced();
        setNote(
          `Backup done: ${result.uploadedMedia} new media, ${
            result.databaseUploaded ? 'chat database uploaded' : 'chat database unchanged'
          }.`,
        );
        if (channel) setSummary(await previewWhatsAppSync(channel.id, current, media));
      } catch (failure) {
        setError(describe(failure));
      } finally {
        runningRef.current = false;
        abortRef.current = null;
        setBusy(null);
        setProgress(null);
      }
    },
    [channel, markSynced, media, scan],
  );

  const stop = (): void => {
    abortRef.current?.abort();
    setNote('Stopping after the current step…');
  };

  const restore = async (): Promise<void> => {
    if (!channel) {
      setError('Select a vault channel in Settings first.');
      return;
    }
    setBusy('restore');
    setError(null);
    setNote(null);
    try {
      const manifest = await loadRemoteWhatsAppBackup(channel.id);
      if (!manifest) {
        setError('No backup found in this channel.');
        return;
      }
      let target: Directory | null = null;
      try {
        target = await Directory.pickDirectoryAsync();
      } catch {
        target = null;
      }
      const outcome = await restoreWhatsAppDatabase(manifest, target, { onProgress: setProgress });
      setNote(
        outcome.location === 'whatsapp'
          ? `${outcome.fileName} saved to the folder you picked (${formatBytes(outcome.bytes)}). Open WhatsApp to finish restoring.`
          : `No folder picked, so the database was saved to the app cache (${formatBytes(outcome.bytes)}).`,
      );
    } catch (failure) {
      setError(describe(failure));
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };

  /* Daily check: only runs while the app is open, which is all a phone app can
     promise without a background task. */
  useEffect(() => {
    if (autoRanRef.current || !autoSync || !folder || !channel) return;
    if (!isSyncDue(lastSyncAt, scheduleTime)) return;
    autoRanRef.current = true;
    void (async () => {
      const result = await scanOnly();
      if (result) await runBackup(result);
    })();
  }, [autoSync, channel, folder, lastSyncAt, runBackup, scanOnly, scheduleTime]);

  const disabledReason = !channel
    ? 'Select a vault channel in Settings first.'
    : !folder
      ? 'Pick your WhatsApp folder to start.'
      : null;

  return (
    <Screen style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        {disabledReason ? <Notice tone="info">{disabledReason}</Notice> : null}
        {error ? <Notice tone="error">{error}</Notice> : null}
        {note ? <Notice tone="success">{note}</Notice> : null}

        <Card
          title="WhatsApp folder"
          subtitle="Android/media/com.whatsapp/WhatsApp — pick that folder once, Android remembers the permission."
        >
          <View style={styles.spread}>
            <Text style={styles.folder}>{folder ? folder.name : 'No folder selected'}</Text>
            <Button label="Choose" small variant="secondary" busy={busy === 'pick'} onPress={() => void pickFolder()} />
          </View>
          {folder ? <Text style={styles.path} numberOfLines={2}>{folder.uri}</Text> : null}
          <Button
            label="Scan folder"
            variant="secondary"
            busy={busy === 'scan'}
            disabled={!folder || busy !== null}
            onPress={() => void scanOnly()}
          />
          {scanProgress ? (
            <Text style={styles.path}>
              Reading… {scanProgress.files} files in {scanProgress.directories} folders
            </Text>
          ) : null}
          {scan ? (
            <Text style={styles.path}>
              {scan.files.length} files · {scan.latestDatabase ? scan.latestDatabase.name : 'no database'} ·{' '}
              {formatBytes(scan.totalBytes)}
              {scan.skipped > 0 ? ` · ${scan.skipped} skipped` : ''}
            </Text>
          ) : null}
        </Card>

        <Card title="What to back up" subtitle="Chat database is always included; media is optional.">
          <Toggle
            label="Photos"
            description="WhatsApp Images, GIFs, stickers"
            value={media.photos}
            onValueChange={(next) => setMedia({ ...media, photos: next })}
          />
          <Toggle
            label="Videos"
            description="WhatsApp Video"
            value={media.videos}
            onValueChange={(next) => setMedia({ ...media, videos: next })}
          />
          <Toggle
            label="PDFs & documents"
            description="WhatsApp Documents"
            value={media.documents}
            onValueChange={(next) => setMedia({ ...media, documents: next })}
          />
          <Text style={styles.path}>
            {hasAnyMedia(media)
              ? 'Selected media is encrypted and uploaded once; unchanged files are skipped next time.'
              : 'Chats only: the encrypted msgstore file is uploaded, media stays on the phone.'}
          </Text>
        </Card>

        <Card
          title="Automatic backup"
          subtitle="Only runs while the app is open — a phone app cannot wake itself at 3 AM."
        >
          <Toggle
            label="Daily check when the app opens"
            description="If today's check has not happened yet, the folder is scanned and new files are uploaded."
            value={autoSync}
            onValueChange={(next) => void setAutoSync(next)}
          />
          <View style={styles.timeRow}>
            <View style={styles.timeInputWrap}>
              <Label>Check after (HH:MM)</Label>
              <TextInput
                style={styles.timeInput}
                value={timeDraft}
                onChangeText={setTimeDraft}
                onEndEditing={() => void setScheduleTime(timeDraft)}
                keyboardType="numbers-and-punctuation"
                placeholder="03:00"
                placeholderTextColor={colors.muted}
              />
            </View>
            <Text style={styles.path}>
              {lastSyncAt ? `Last backup: ${new Date(lastSyncAt).toLocaleString()}` : 'Never backed up yet'}
            </Text>
          </View>
        </Card>

        <Card title="Run a backup" subtitle="Uploads the chat database plus the media types you enabled.">
          {summary ? (
            <Text style={styles.path}>
              Pending: {summary.pendingMediaCount} media ({formatBytes(summary.pendingBytes)}) ·{' '}
              {summary.databaseChanged ? 'chat database new' : 'chat database unchanged'}
            </Text>
          ) : null}
          {progress ? <ProgressBar fraction={progress.fraction} label={progress.label} /> : null}
          <View style={styles.actions}>
            <Button
              label={busy === 'sync' ? 'Backing up…' : 'Back up now'}
              busy={busy === 'sync'}
              disabled={!scan || busy !== null || !channel}
              onPress={() => void runBackup(null)}
            />
            {busy === 'sync' ? <Button label="Stop" variant="danger" small onPress={stop} /> : null}
          </View>
          <Button
            label="Scan + backup in one step"
            variant="secondary"
            disabled={busy !== null || !folder || !channel}
            onPress={() =>
              void (async () => {
                const result = await scanOnly();
                if (result) await runBackup(result);
              })()
            }
          />
        </Card>

        <Card
          title="Restore to WhatsApp"
          subtitle="Downloads the encrypted database from Telegram and writes the .crypt file back."
        >
          <Text style={styles.steps}>
            1. Pick the WhatsApp `Databases` folder — the file is written there directly.{'\n'}
            2. Force-stop WhatsApp before restoring so it re-reads the local file.{'\n'}
            3. Open WhatsApp and accept the restore prompt. Same phone number as the backup is required.
          </Text>
          <Button
            label="Restore database"
            variant="secondary"
            busy={busy === 'restore'}
            disabled={busy !== null || !channel}
            onPress={() => void restore()}
          />
          {busy === 'restore' && progress ? (
            <ProgressBar fraction={progress.fraction} label={progress.label} />
          ) : null}
          <Text style={styles.warn}>
            Media is stored encrypted in Telegram but is not copied back into WhatsApp's media folders, so old
            photos stay inside PicPocket until you open them here.
          </Text>
        </Card>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  screen: { padding: 0 },
  content: { padding: space(4), paddingBottom: space(12), gap: space(3) },
  spread: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space(3) },
  folder: { fontSize: 15, fontWeight: '600', color: colors.ink, flex: 1 },
  path: { fontSize: 12, color: colors.muted, lineHeight: 17 },
  steps: { fontSize: 12, color: colors.muted, lineHeight: 19 },
  warn: { fontSize: 11, color: colors.muted, lineHeight: 16, marginTop: space(2) },
  actions: { flexDirection: 'row', gap: space(2), alignItems: 'center' },
  timeRow: { gap: space(2), marginTop: space(2) },
  timeInputWrap: { gap: space(1) },
  timeInput: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: space(3),
    paddingVertical: space(2),
    fontSize: 15,
    color: colors.ink,
    backgroundColor: colors.bg,
    width: 110,
  },
});
