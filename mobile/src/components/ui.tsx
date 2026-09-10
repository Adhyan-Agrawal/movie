import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { colors, radius, spacing, type } from '../theme';

/** Shared native UI primitives — the mobile twin of the web's components/ui. */

export function Screen({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.screen, style]}>{children}</View>;
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  size = 'md',
  disabled,
  loading,
  style,
}: {
  label: string;
  onPress?: () => void;
  variant?: 'primary' | 'secondary' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  disabled?: boolean;
  loading?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const height = size === 'lg' ? 52 : size === 'sm' ? 34 : 44;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        baseButton,
        { height, opacity: disabled ? 0.5 : pressed ? 0.85 : 1 },
        variant === 'primary' && { backgroundColor: colors.primary },
        variant === 'secondary' && { backgroundColor: colors.surfaceRaised, borderWidth: 1, borderColor: colors.border },
        variant === 'ghost' && { backgroundColor: 'transparent' },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={variant === 'primary' ? colors.primaryContrast : colors.content} />
      ) : (
        <Text
          style={[
            styles.buttonLabel,
            { fontSize: size === 'sm' ? 13 : 15 },
            variant === 'primary' && { color: colors.primaryContrast },
          ]}
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
}

export function Badge({
  label,
  tone = 'neutral',
}: {
  label: string;
  tone?: 'neutral' | 'primary' | 'info' | 'success' | 'warning';
}) {
  const bg =
    tone === 'primary'
      ? colors.primary
      : tone === 'info'
        ? colors.info + '22'
        : tone === 'success'
          ? colors.success + '22'
          : tone === 'warning'
            ? colors.warning + '22'
            : colors.surfaceRaised;
  const fg =
    tone === 'primary'
      ? colors.primaryContrast
      : tone === 'info'
        ? colors.info
        : tone === 'success'
          ? colors.success
          : tone === 'warning'
            ? colors.warning
            : colors.contentMuted;
  return (
    <View style={[styles.badge, { backgroundColor: bg }]}>
      <Text style={[styles.badgeLabel, { color: fg }]}>{label}</Text>
    </View>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <Text style={styles.sectionTitle}>{children}</Text>;
}

export function Loading({ label }: { label?: string }) {
  return (
    <View style={styles.center}>
      <ActivityIndicator color={colors.primary} />
      {label ? <Text style={styles.mutedText}>{label}</Text> : null}
    </View>
  );
}

export function EmptyState({ title, description }: { title: string; description?: string }) {
  return (
    <View style={styles.center}>
      <Text style={styles.emptyTitle}>{title}</Text>
      {description ? <Text style={styles.mutedText}>{description}</Text> : null}
    </View>
  );
}

/** Two-column-ish detail row ("Released  ·  2010"). */
export function MetaLine({ parts }: { parts: Array<string | undefined | null> }) {
  const items = parts.filter((p): p is string => Boolean(p && p.trim()));
  if (!items.length) return null;
  return (
    <Text style={styles.meta} numberOfLines={2}>
      {items.join('  ·  ')}
    </Text>
  );
}

const baseButton = {
  alignItems: 'center' as const,
  justifyContent: 'center' as const,
  paddingHorizontal: spacing(4),
  borderRadius: radius.md,
};

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.base },
  buttonLabel: { fontWeight: '600', color: colors.content },
  badge: { alignSelf: 'flex-start' as const, paddingHorizontal: spacing(2), paddingVertical: 3, borderRadius: radius.pill },
  badgeLabel: { ...type.tiny, textTransform: 'uppercase' as const, letterSpacing: 0.5 },
  sectionTitle: { ...type.h2, color: colors.content, paddingHorizontal: spacing(4), marginBottom: spacing(2) },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing(2), padding: spacing(6) },
  mutedText: { ...type.body, color: colors.contentMuted, textAlign: 'center' },
  emptyTitle: { ...type.h3, color: colors.content, textAlign: 'center' },
  meta: { ...type.small, color: colors.contentMuted },
});
