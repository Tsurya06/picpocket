import { Tabs } from 'expo-router';
import { Text } from 'react-native';
import { colors } from '../../theme';

const icon = (glyph: string) => (): React.JSX.Element =>
  <Text style={{ fontSize: 18 }}>{glyph}</Text>;

export default function TabsLayout(): React.JSX.Element {
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: colors.surface },
        headerTitleStyle: { fontSize: 16, color: colors.ink },
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.muted,
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Vault', tabBarIcon: icon('🗂️') }} />
      <Tabs.Screen name="whatsapp" options={{ title: 'WhatsApp', tabBarIcon: icon('💬') }} />
      <Tabs.Screen name="settings" options={{ title: 'Settings', tabBarIcon: icon('⚙️') }} />
    </Tabs>
  );
}
