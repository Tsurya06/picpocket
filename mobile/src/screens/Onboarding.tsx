import { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useVault } from '../state/VaultProvider';
import { Button, Card, Label, Notice } from '../ui';
import { colors, radius, space } from '../theme';

type LoginStep = 'phone' | 'code' | 'password';

export function Onboarding(): React.JSX.Element {
  const {
    stage,
    busy,
    error,
    info,
    hasVault,
    saveCredentials,
    unlockVault,
    sendLoginCode,
    submitLoginCode,
    submitLoginPassword,
  } = useVault();

  const [apiId, setApiId] = useState('');
  const [apiHash, setApiHash] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [loginStep, setLoginStep] = useState<LoginStep>('phone');
  const [localError, setLocalError] = useState<string | null>(null);

  const run = async (action: () => Promise<void>): Promise<void> => {
    setLocalError(null);
    try {
      await action();
    } catch (failure) {
      setLocalError(failure instanceof Error ? failure.message : 'Something went wrong.');
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <View style={styles.brand}>
            <Text style={styles.logo}>PicPocket</Text>
            <Text style={styles.tagline}>
              Private vault in your own Telegram channel — WhatsApp chats, photos, videos and PDFs.
            </Text>
          </View>

          {stage === 'loading' ? (
            <Card>
              <View style={styles.center}>
                <ActivityIndicator color={colors.accent} />
                <Text style={styles.help}>Opening the vault…</Text>
              </View>
            </Card>
          ) : null}

          {info ? <Notice tone="info">{info}</Notice> : null}
          {error ? <Notice tone="error">{error}</Notice> : null}
          {localError ? <Notice tone="error">{localError}</Notice> : null}

          {stage === 'credentials' ? (
            <Card
              title="1. Telegram app credentials"
              subtitle="Create an app at my.telegram.org/apps and copy api_id and api_hash. They stay on this phone."
            >
              <Label>api_id</Label>
              <TextInput
                style={styles.input}
                value={apiId}
                onChangeText={setApiId}
                keyboardType="number-pad"
                placeholder="12345678"
                placeholderTextColor={colors.muted}
                autoCorrect={false}
              />
              <Label>api_hash</Label>
              <TextInput
                style={styles.input}
                value={apiHash}
                onChangeText={setApiHash}
                placeholder="0123456789abcdef0123456789abcdef"
                placeholderTextColor={colors.muted}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <Button
                label="Continue"
                busy={busy}
                onPress={() =>
                  void run(async () => {
                    await saveCredentials(Number(apiId.trim()), apiHash.trim());
                  })
                }
              />
            </Card>
          ) : null}

          {stage === 'unlock' ? (
            <Card
              title={hasVault ? '2. Unlock the vault' : '2. Create a vault passphrase'}
              subtitle={
                hasVault
                  ? 'Use the same passphrase you use on the web app so both read the same backups.'
                  : 'At least 8 characters. This key encrypts everything before it reaches Telegram, and it is never uploaded.'
              }
            >
              <Label>Passphrase</Label>
              <TextInput
                style={styles.input}
                value={passphrase}
                onChangeText={setPassphrase}
                secureTextEntry
                placeholder="••••••••"
                placeholderTextColor={colors.muted}
              />
              <Button
                label={hasVault ? 'Unlock vault' : 'Create vault'}
                busy={busy}
                disabled={passphrase.length < 8}
                onPress={() =>
                  void run(async () => {
                    await unlockVault(passphrase, hasVault ? 'unlock' : 'create');
                  })
                }
              />
            </Card>
          ) : null}

          {stage === 'login' ? (
            <Card
              title="3. Sign in to Telegram"
              subtitle="Your account is used only to read and write this vault's channels."
            >
              {loginStep === 'phone' ? (
                <>
                  <Label>Phone number</Label>
                  <TextInput
                    style={styles.input}
                    value={phone}
                    onChangeText={setPhone}
                    keyboardType="phone-pad"
                    placeholder="+91 98765 43210"
                    placeholderTextColor={colors.muted}
                    autoComplete="tel"
                  />
                  <Button
                    label="Send code"
                    busy={busy}
                    disabled={phone.trim().length < 6}
                    onPress={() =>
                      void run(async () => {
                        const result = await sendLoginCode(phone);
                        if (!result.authorized) setLoginStep('code');
                      })
                    }
                  />
                </>
              ) : null}

              {loginStep === 'code' ? (
                <>
                  <Label>Login code from Telegram</Label>
                  <TextInput
                    style={styles.input}
                    value={code}
                    onChangeText={setCode}
                    keyboardType="number-pad"
                    placeholder="12345"
                    placeholderTextColor={colors.muted}
                  />
                  <Button
                    label="Verify code"
                    busy={busy}
                    disabled={code.trim().length < 3}
                    onPress={() =>
                      void run(async () => {
                        const result = await submitLoginCode(code);
                        if (result.passwordNeeded) setLoginStep('password');
                      })
                    }
                  />
                  <Button
                    label="Use a different number"
                    variant="secondary"
                    small
                    onPress={() => setLoginStep('phone')}
                  />
                </>
              ) : null}

              {loginStep === 'password' ? (
                <>
                  <Label>Two-step password</Label>
                  <TextInput
                    style={styles.input}
                    value={password}
                    onChangeText={setPassword}
                    secureTextEntry
                    placeholder="Your Telegram cloud password"
                    placeholderTextColor={colors.muted}
                  />
                  <Button
                    label="Sign in"
                    busy={busy}
                    disabled={password.length < 1}
                    onPress={() => void run(async () => { await submitLoginPassword(password); })}
                  />
                </>
              ) : null}
            </Card>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
  content: { padding: space(4), gap: space(3) },
  brand: { gap: space(2), paddingVertical: space(4) },
  logo: { fontSize: 28, fontWeight: '700', color: colors.ink },
  tagline: { fontSize: 13, color: colors.muted, lineHeight: 19 },
  center: { alignItems: 'center', gap: space(2) },
  help: { fontSize: 12, color: colors.muted },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: space(3),
    paddingVertical: space(3),
    fontSize: 15,
    color: colors.ink,
    backgroundColor: colors.bg,
  },
});
