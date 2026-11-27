import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { VaultProvider, useVault } from '../state/VaultProvider';
import { Onboarding } from '../screens/Onboarding';
import { colors } from '../theme';

function Gate(): React.JSX.Element {
  const { stage } = useVault();
  if (stage !== 'ready') return <Onboarding />;
  return (
    <>
      <StatusBar style="dark" />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.bg },
        }}
      />
    </>
  );
}

export default function RootLayout(): React.JSX.Element {
  return (
    <SafeAreaProvider>
      <VaultProvider>
        <Gate />
      </VaultProvider>
    </SafeAreaProvider>
  );
}
