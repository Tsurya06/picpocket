import { useState, type JSX } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useVault } from '../../state/VaultProvider';
import { Button, Card, Label, Notice, Screen, Value } from '../../ui';
import { colors, radius, space } from '../../theme';

export default function SettingsScreen(): JSX.Element {
  const { account, channel, channels, refreshChannels, selectChannel, lock, signOut, busy, error } =
    useVault();
  const [localError, setLocalError] = useState<string | null>(null);

  const choose = async (id: string, title: string): Promise<void> => {
    setLocalError(null);
    try {
      await selectChannel({ id, title });
    } catch (failure) {
      setLocalError(failure instanceof Error ? failure.message : 'Could not select that channel.');
    }
  };

  return (
    <Screen style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        {error ? <Notice tone="error">{error}</Notice> : null}
        {localError ? <Notice tone="error">{localError}</Notice> : null}

        <Card title="Telegram account">
          <Label>Signed in as</Label>
          <Value>{account?.displayName ?? '—'}</Value>
          {account?.username ? <Text style={styles.muted}>@{account.username}</Text> : null}
          <Text style={styles.muted}>
            The session is stored encrypted on this phone with your vault passphrase. Locking clears it from
            memory; signing out deletes it.
          </Text>
        </Card>

        <Card
          title="Vault channel"
          subtitle="Everything is written into this one channel. Pick an existing private channel or create one in Telegram first."
        >
          <Label>Current</Label>
          <Value>{channel ? channel.title : 'None selected'}</Value>
          <Button
            label="Reload channels"
            variant="secondary"
            small
            busy={busy}
            onPress={() => void refreshChannels()}
          />
          <View style={styles.list}>
            {channels.map((entry) => {
              const active = entry.id === channel?.id;
              return (
                <Pressable
                  key={entry.id}
                  onPress={() => void choose(entry.id, entry.title)}
                  style={[styles.channelRow, active && styles.channelRowActive]}
                >
                  <View style={styles.channelText}>
                    <Text style={styles.channelTitle} numberOfLines={1}>
                      {entry.title}
                    </Text>
                    <Text style={styles.channelMeta}>
                      {entry.kind}
                      {entry.isCreator ? ' · you own it' : ''}
                    </Text>
                  </View>
                  <Text style={[styles.check, active && styles.checkActive]}>{active ? '✓' : ''}</Text>
                </Pressable>
              );
            })}
            {channels.length === 0 ? (
              <Text style={styles.muted}>No channels found. Create a private channel in Telegram, then reload.</Text>
            ) : null}
          </View>
        </Card>

        <Card title="Security">
          <Text style={styles.muted}>
            Passphrase and vault salt never leave the phone. Telegram only ever receives encrypted bytes.
          </Text>
          <Button label="Lock vault" variant="secondary" onPress={() => void lock()} />
          <Button label="Sign out of Telegram" variant="danger" onPress={() => void signOut()} />
        </Card>

        <Card title="About">
          <Text style={styles.muted}>
            PicPocket mobile · React Native + Expo. Backup format matches the web app (PBKDF2-SHA256 600k,
            AES-256-GCM). Backup and restore work only on Android, because iOS has no shared WhatsApp folder.
          </Text>
        </Card>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  screen: { padding: 0 },
  content: { padding: space(4), paddingBottom: space(12), gap: space(3) },
  muted: { fontSize: 12, color: colors.muted, lineHeight: 17 },
  list: { gap: space(2), marginTop: space(2) },
  channelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space(3),
    padding: space(3),
    borderRadius: radius.md,
    backgroundColor: colors.bg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  channelRowActive: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  channelText: { flex: 1, gap: 2 },
  channelTitle: { fontSize: 14, color: colors.ink, fontWeight: '500' },
  channelMeta: { fontSize: 11, color: colors.muted },
  check: { fontSize: 15, color: 'transparent' },
  checkActive: { color: colors.accent },
});
