import { type JSX, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { colors, radius, space } from './theme';

export function Screen({
  children,
  style,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}): JSX.Element {
  return <View style={[styles.screen, style]}>{children}</View>;
}

export function Card({
  title,
  subtitle,
  children,
}: {
  title?: string;
  subtitle?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <View style={styles.card}>
      {title ? <Text style={styles.cardTitle}>{title}</Text> : null}
      {subtitle ? <Text style={styles.cardSubtitle}>{subtitle}</Text> : null}
      {children}
    </View>
  );
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
  busy = false,
  small = false,
}: {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
  busy?: boolean;
  small?: boolean;
}): JSX.Element {
  const background =
    variant === 'primary' ? colors.accent : variant === 'danger' ? colors.dangerSoft : colors.surface;
  const textColor =
    variant === 'primary' ? colors.accentInk : variant === 'danger' ? colors.danger : colors.ink;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled || busy}
      style={({ pressed }) => [
        styles.button,
        small && styles.buttonSmall,
        { backgroundColor: background, opacity: disabled || busy ? 0.5 : pressed ? 0.8 : 1 },
        variant === 'secondary' ? styles.buttonOutline : null,
      ]}
    >
      {busy ? <ActivityIndicator size="small" color={textColor} /> : null}
      <Text style={[styles.buttonLabel, small && styles.buttonLabelSmall, { color: textColor }]}>
        {label}
      </Text>
    </Pressable>
  );
}

export function Toggle({
  label,
  description,
  value,
  onValueChange,
}: {
  label: string;
  description?: string;
  value: boolean;
  onValueChange: (next: boolean) => void;
}): JSX.Element {
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: value }}
      onPress={() => onValueChange(!value)}
      style={styles.toggleRow}
    >
      <View style={styles.toggleText}>
        <Text style={styles.toggleLabel}>{label}</Text>
        {description ? <Text style={styles.toggleDescription}>{description}</Text> : null}
      </View>
      <View style={[styles.switchTrack, value && styles.switchTrackOn]}>
        <View style={[styles.switchThumb, value && styles.switchThumbOn]} />
      </View>
    </Pressable>
  );
}

export function Chip({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}): JSX.Element {
  return (
    <Pressable
      onPress={onPress}
      style={[styles.chip, active && styles.chipActive]}
      accessibilityRole="button"
    >
      <Text style={[styles.chipLabel, active && styles.chipLabelActive]}>{label}</Text>
    </Pressable>
  );
}

export function ProgressBar({
  fraction,
  label,
}: {
  fraction: number;
  label?: string;
}): JSX.Element {
  const percent = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
  return (
    <View style={styles.progressWrap}>
      <View style={styles.progressTrack}>
        <View style={[styles.progressFill, { width: `${percent}%` }]} />
      </View>
      {label ? (
        <Text style={styles.progressLabel} numberOfLines={2}>
          {label}
        </Text>
      ) : null}
    </View>
  );
}

export function Notice({
  tone,
  children,
}: {
  tone: 'info' | 'error' | 'success';
  children: ReactNode;
}): JSX.Element {
  const palette =
    tone === 'error'
      ? { bg: colors.dangerSoft, fg: colors.danger }
      : tone === 'success'
        ? { bg: colors.successSoft, fg: colors.success }
        : { bg: colors.accentSoft, fg: colors.accent };
  return (
    <View style={[styles.notice, { backgroundColor: palette.bg }]}>
      <Text style={[styles.noticeText, { color: palette.fg }]}>{children}</Text>
    </View>
  );
}

export function Label({ children }: { children: ReactNode }): JSX.Element {
  return <Text style={styles.label}>{children}</Text>;
}

export function Value({ children }: { children: ReactNode }): JSX.Element {
  return <Text style={styles.value}>{children}</Text>;
}

export function Row({ children }: { children: ReactNode }): JSX.Element {
  return <View style={styles.row}>{children}</View>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg, padding: space(4) },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: space(4),
    gap: space(2),
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    marginBottom: space(3),
  },
  cardTitle: { fontSize: 15, fontWeight: '600', color: colors.ink },
  cardSubtitle: { fontSize: 12, color: colors.muted, lineHeight: 17 },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space(2),
    paddingVertical: space(3),
    paddingHorizontal: space(4),
    borderRadius: radius.md,
  },
  buttonSmall: { paddingVertical: space(2), paddingHorizontal: space(3) },
  buttonOutline: { borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  buttonLabel: { fontSize: 14, fontWeight: '600' },
  buttonLabelSmall: { fontSize: 12 },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space(3),
    paddingVertical: space(2),
  },
  toggleText: { flex: 1, gap: 2 },
  toggleLabel: { fontSize: 14, color: colors.ink },
  toggleDescription: { fontSize: 11, color: colors.muted, lineHeight: 16 },
  switchTrack: {
    width: 46,
    height: 28,
    borderRadius: radius.pill,
    backgroundColor: colors.border,
    padding: 3,
    justifyContent: 'center',
  },
  switchTrackOn: { backgroundColor: colors.accent },
  switchThumb: {
    width: 22,
    height: 22,
    borderRadius: radius.pill,
    backgroundColor: '#ffffff',
  },
  switchThumbOn: { alignSelf: 'flex-end' },
  chip: {
    paddingVertical: space(2),
    paddingHorizontal: space(3),
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  chipActive: { backgroundColor: colors.accentSoft, borderColor: colors.accent },
  chipLabel: { fontSize: 12, color: colors.muted, fontWeight: '500' },
  chipLabelActive: { color: colors.accent },
  progressWrap: { gap: space(2) },
  progressTrack: {
    height: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.border,
    overflow: 'hidden',
  },
  progressFill: { height: 6, backgroundColor: colors.accent },
  progressLabel: { fontSize: 12, color: colors.muted, lineHeight: 17 },
  notice: { borderRadius: radius.md, padding: space(3) },
  noticeText: { fontSize: 12, lineHeight: 17 },
  label: { fontSize: 11, color: colors.muted, textTransform: 'uppercase', letterSpacing: 0.6 },
  value: { fontSize: 14, color: colors.ink },
  row: { flexDirection: 'row', gap: space(2), alignItems: 'center', flexWrap: 'wrap' },
});
