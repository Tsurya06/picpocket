import { useCallback, useEffect, useState, type JSX } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { File, Paths } from 'expo-file-system';
import { useVault } from '../../state/VaultProvider';
import { vault } from '../../lib/crypto/vault';
import { telegramService } from '../../lib/telegram/service';
import { loadRemoteWhatsAppBackup } from '../../lib/whatsapp/sync';
import type { BackupMediaRef, WhatsAppBackupManifest } from '../../lib/whatsapp/types';
import { Button, Card, Chip, Notice, Screen } from '../../ui';
import { colors, radius, space } from '../../theme';

type Filter = 'all' | 'image' | 'video' | 'document';

const glyphFor = (ref: BackupMediaRef): string =>
  ref.category === 'image' ? '🖼️' : ref.category === 'video' ? '🎬' : '📄';

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

export default function VaultScreen(): JSX.Element {
  const { channel, account } = useVault();
  const [manifest, setManifest] = useState<WhatsAppBackupManifest | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [opening, setOpening] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ uri: string; name: string } | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    if (!channel) return;
    setLoading(true);
    setError(null);
    try {
      const found = await loadRemoteWhatsAppBackup(channel.id);
      setManifest(found);
      if (!found) setNote('No backup found in this channel yet. Run a WhatsApp backup first.');
      else setNote(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not read the backup index.');
    } finally {
      setLoading(false);
    }
  }, [channel]);

  useEffect(() => {
    setManifest(null);
    void load();
  }, [load]);

  const openMedia = async (ref: BackupMediaRef): Promise<void> => {
    if (!channel || ref.messageId === undefined) {
      setError('This media entry has no Telegram message attached.');
      return;
    }
    setOpening(ref.path);
    setError(null);
    setNote(null);
    try {
      const raw = await telegramService.downloadOriginal(channel.id, ref.messageId);
      const plain = vault.decryptBytes(raw, channel.id);
      const cached = new File(Paths.cache, `view-${ref.path.split('/').pop() ?? 'media'}`);
      if (cached.exists) cached.delete();
      cached.create({ intermediates: true });
      await cached.write(plain);
      if (ref.category === 'image') setPreview({ uri: cached.uri, name: cached.name });
      else setNote(`Saved to ${cached.uri}`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not open this file.');
    } finally {
      setOpening(null);
    }
  };

  const media = manifest?.media ?? [];
  const visible = media.filter((ref) => filter === 'all' || ref.category === filter);
  const photos = media.filter((ref) => ref.category === 'image').length;
  const videos = media.filter((ref) => ref.category === 'video').length;
  const docs = media.filter((ref) => ref.category === 'document').length;

  return (
    <Screen style={styles.screen}>
      <FlatList
        data={visible}
        keyExtractor={(item) => item.path}
        numColumns={2}
        columnWrapperStyle={styles.column}
        contentContainerStyle={styles.list}
        ListHeaderComponent={
          <View style={styles.header}>
            <Card
              title={channel ? `Backup: ${channel.title}` : 'No channel selected'}
              subtitle={
                account
                  ? `Signed in as ${account.displayName}`
                  : 'Select a channel in Settings to see its backups.'
              }
            >
              {manifest ? (
                <Text style={styles.meta}>
                  {formatBytes(manifest.totalBytes)} · {media.length} media ·{' '}
                  {manifest.database ? `DB ${formatBytes(manifest.database.size)}` : 'chat DB reused'}
                </Text>
              ) : null}
              <View style={styles.filters}>
                <Chip label={`All ${media.length}`} active={filter === 'all'} onPress={() => setFilter('all')} />
                <Chip label={`Photos ${photos}`} active={filter === 'image'} onPress={() => setFilter('image')} />
                <Chip label={`Videos ${videos}`} active={filter === 'video'} onPress={() => setFilter('video')} />
                <Chip label={`Docs ${docs}`} active={filter === 'document'} onPress={() => setFilter('document')} />
              </View>
              <Button label="Refresh" variant="secondary" small busy={loading} onPress={() => void load()} />
              {error ? <Notice tone="error">{error}</Notice> : null}
              {note ? <Notice tone="info">{note}</Notice> : null}
            </Card>
          </View>
        }
        renderItem={({ item }) => (
          <Pressable style={styles.tile} onPress={() => void openMedia(item)}>
            <Text style={styles.tileGlyph}>{glyphFor(item)}</Text>
            <Text style={styles.tileName} numberOfLines={2}>
              {item.path.split('/').pop() ?? item.path}
            </Text>
            <Text style={styles.tileMeta}>{formatBytes(item.size)}</Text>
            {opening === item.path ? (
              <ActivityIndicator size="small" color={colors.accent} style={styles.tileBusy} />
            ) : null}
          </Pressable>
        )}
        ListEmptyComponent={
          loading ? (
            <View style={styles.center}>
              <ActivityIndicator color={colors.accent} />
              <Text style={styles.empty}>Reading the sealed index…</Text>
            </View>
          ) : (
            <View style={styles.center}>
              <Text style={styles.empty}>Nothing here yet.</Text>
            </View>
          )
        }
      />

      <Modal visible={preview !== null} animationType="fade" onRequestClose={() => setPreview(null)}>
        <View style={styles.modal}>
          <Pressable style={styles.modalClose} onPress={() => setPreview(null)}>
            <Text style={styles.modalCloseText}>Close</Text>
          </Pressable>
          {preview ? <Image source={{ uri: preview.uri }} style={styles.image} resizeMode="contain" /> : null}
          {preview ? <Text style={styles.modalCaption}>{preview.name}</Text> : null}
        </View>
      </Modal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  screen: { padding: 0 },
  list: { padding: space(4), paddingBottom: space(12) },
  header: { gap: space(2) },
  meta: { fontSize: 12, color: colors.muted },
  filters: { flexDirection: 'row', flexWrap: 'wrap', gap: space(2), marginVertical: space(2) },
  column: { gap: space(3) },
  tile: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: space(3),
    gap: 4,
    marginBottom: space(3),
    minHeight: 108,
  },
  tileGlyph: { fontSize: 20 },
  tileName: { fontSize: 12, color: colors.ink, fontWeight: '500' },
  tileMeta: { fontSize: 11, color: colors.muted },
  tileBusy: { position: 'absolute', right: space(2), top: space(2) },
  center: { alignItems: 'center', gap: space(2), paddingVertical: space(8) },
  empty: { fontSize: 12, color: colors.muted, textAlign: 'center' },
  modal: { flex: 1, backgroundColor: '#000000', justifyContent: 'center' },
  modalClose: { position: 'absolute', top: 56, right: 20, zIndex: 2, padding: 8 },
  modalCloseText: { color: '#ffffff', fontSize: 15, fontWeight: '600' },
  image: { width: '100%', height: '80%' },
  modalCaption: { color: '#ffffff', fontSize: 12, textAlign: 'center', padding: space(4) },
});
