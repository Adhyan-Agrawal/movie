import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { colors, radius, spacing, type } from '../theme';
import { Icon, type IconName } from './Icon';
import { useBrowseLayout } from './layout';

export function Screen({ children, style, safeSides = false }: { children: ReactNode; style?: StyleProp<ViewStyle>; safeSides?: boolean }) {
  return safeSides ? <SafeAreaView edges={['left', 'right']} style={[styles.screen, style]}>{children}</SafeAreaView> : <View style={[styles.screen, style]}>{children}</View>;
}

export function Button({ label, onPress, variant = 'primary', size = 'md', disabled, loading, style, icon, accessibilityLabel }: {
  label: string;
  onPress?: () => void;
  variant?: 'primary' | 'secondary' | 'ghost' | 'light';
  size?: 'sm' | 'md' | 'lg';
  disabled?: boolean;
  loading?: boolean;
  style?: StyleProp<ViewStyle>;
  icon?: IconName;
  accessibilityLabel?: string;
}) {
  const blocked = Boolean(disabled || loading);
  const foreground = variant === 'primary' ? colors.primaryContrast : variant === 'light' ? colors.base : colors.content;
  return <Pressable
    onPress={onPress}
    disabled={blocked}
    accessibilityRole="button"
    accessibilityLabel={accessibilityLabel ?? label}
    accessibilityState={{ disabled: blocked, busy: Boolean(loading) }}
    style={({ pressed }) => [styles.button, { minHeight: size === 'lg' ? 56 : 48, opacity: disabled ? 0.5 : pressed ? 0.8 : 1 },
      variant === 'primary' && { backgroundColor: colors.primary },
      variant === 'light' && { backgroundColor: colors.content },
      variant === 'secondary' && { backgroundColor: colors.surfaceRaised, borderWidth: 1, borderColor: colors.borderStrong },
      style]}
  >
    {loading ? <ActivityIndicator color={foreground} size="small" /> : icon ? <Icon name={icon} color={foreground} size={18} /> : null}
    <Text style={[styles.buttonLabel, { color: foreground, fontSize: size === 'sm' ? 13 : 15 }]}>{label}</Text>
  </Pressable>;
}

export function IconButton({ icon, label, onPress, disabled = false }: { icon: IconName; label: string; onPress: () => void; disabled?: boolean }) {
  return <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }}
    style={({ pressed }) => [styles.iconButton, { opacity: disabled ? 0.35 : pressed ? 0.7 : 1 }]}>
    <Icon name={icon} />
  </Pressable>;
}

export function FilterChip({ label, active = false, onPress, accessibilityLabel }: { label: string; active?: boolean; onPress: () => void; accessibilityLabel?: string }) {
  const layout = useBrowseLayout();
  return <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? label} accessibilityState={{ selected: active }}
    style={({ pressed }) => [styles.chip, { maxWidth: layout.width - layout.gutter * 2, borderRadius: layout.largeText ? radius.md : radius.pill }, active && styles.chipActive, { opacity: pressed ? 0.75 : 1 }]}>
    <Text style={[styles.chipLabel, active && { color: colors.content, fontWeight: '700', textDecorationLine: 'underline' }]}>{label}</Text>
  </Pressable>;
}

export function Badge({ label, tone = 'neutral' }: { label: string; tone?: 'neutral' | 'primary' | 'info' | 'success' | 'warning' }) {
  const foreground = tone === 'primary' ? colors.content : tone === 'info' ? colors.info : tone === 'success' ? colors.success : tone === 'warning' ? colors.warning : colors.contentMuted;
  return <View style={[styles.badge, { borderColor: tone === 'primary' ? colors.primary + '77' : tone === 'neutral' ? colors.borderStrong : foreground + '55', backgroundColor: tone === 'primary' ? colors.primary + '22' : colors.surface }]}><Text style={[styles.badgeLabel, { color: foreground }]}>{label}</Text></View>;
}

export function SectionTitle({ children, description, actionLabel = 'See all', onAction }: { children: ReactNode; description?: string; actionLabel?: string; onAction?: () => void }) {
  const { gutter } = useBrowseLayout();
  return <View style={[styles.sectionHeading, { paddingHorizontal: gutter }]}>
    <View style={styles.sectionCopy}><Text accessibilityRole="header" style={styles.sectionTitle}>{children}</Text>{description ? <Text style={styles.sectionDescription}>{description}</Text> : null}</View>
    {onAction ? <Pressable accessibilityRole="button" accessibilityLabel={`${actionLabel} ${typeof children === 'string' ? children : 'titles'}`} onPress={onAction} style={({ pressed }) => [styles.sectionAction, { opacity: pressed ? 0.7 : 1 }]}><Text style={styles.actionLabel}>{actionLabel}</Text><Icon name="chevron-right" size={15} color={colors.primary} /></Pressable> : null}
  </View>;
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  return <View style={styles.center} accessible accessibilityRole="progressbar" accessibilityLabel={label} accessibilityState={{ busy: true }}><ActivityIndicator color={colors.primary} /><Text style={styles.mutedText}>{label}</Text></View>;
}

export function EmptyState({ title, description, icon = 'film', actionLabel, onAction, compact = false }: { title: string; description?: string; icon?: IconName; actionLabel?: string; onAction?: () => void; compact?: boolean }) {
  return <View style={[styles.center, compact && styles.compact]}>
    <View style={styles.stateIcon}><Icon name={icon} color={colors.primary} size={26} /></View>
    <Text accessibilityRole="header" style={styles.emptyTitle}>{title}</Text>
    {description ? <Text style={styles.mutedText}>{description}</Text> : null}
    {actionLabel && onAction ? <Button label={actionLabel} onPress={onAction} variant="secondary" style={styles.stateAction} /> : null}
  </View>;
}

export function Notice({ title, description, actionLabel, onAction }: { title: string; description?: string; actionLabel?: string; onAction?: () => void }) {
  return <View style={styles.notice}>
    <View style={styles.noticeCopy} accessibilityLiveRegion="polite"><Text style={styles.noticeTitle}>{title}</Text>{description ? <Text style={styles.noticeText}>{description}</Text> : null}</View>
    {actionLabel && onAction ? <Button label={actionLabel} variant="ghost" size="sm" onPress={onAction} /> : null}
  </View>;
}

export function MetaLine({ parts }: { parts: Array<string | undefined | null> }) {
  const items = parts.filter((part): part is string => Boolean(part && part.trim()));
  return items.length ? <Text style={styles.meta}>{items.join('  \u00b7  ')}</Text> : null;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.base },
  button: { minWidth: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing(2), paddingHorizontal: spacing(4), paddingVertical: spacing(3), borderRadius: radius.md },
  buttonLabel: { fontWeight: '700', lineHeight: 21, flexShrink: 1, textAlign: 'center' },
  iconButton: { minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center', borderRadius: radius.pill, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.surface },
  chip: { minWidth: 48, minHeight: 48, paddingHorizontal: spacing(4), paddingVertical: spacing(3), justifyContent: 'center', borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  chipActive: { borderColor: colors.primary + '88', backgroundColor: colors.primary + '14' },
  chipLabel: { ...type.small, fontWeight: '600', color: colors.contentMuted, flexShrink: 1 },
  badge: { alignSelf: 'flex-start', maxWidth: '100%', paddingHorizontal: spacing(2), paddingVertical: spacing(1), borderRadius: radius.sm, borderWidth: 1, backgroundColor: colors.surface },
  badgeLabel: { ...type.tiny, fontWeight: '600', flexShrink: 1 },
  sectionHeading: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing(2), marginBottom: spacing(4) },
  sectionCopy: { flex: 1, minWidth: 170, gap: spacing(1) },
  sectionTitle: { ...type.h2, color: colors.content },
  sectionDescription: { ...type.small, color: colors.contentMuted },
  sectionAction: { minWidth: 48, minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing(1), paddingHorizontal: spacing(2) },
  actionLabel: { ...type.small, fontWeight: '600', color: colors.content },
  center: { flexGrow: 1, minHeight: 280, alignItems: 'center', justifyContent: 'center', gap: spacing(3), padding: spacing(7) },
  compact: { minHeight: 180, paddingVertical: spacing(5) },
  stateIcon: { width: 64, height: 64, borderRadius: radius.lg, backgroundColor: colors.surfaceRaised, alignItems: 'center', justifyContent: 'center', marginBottom: spacing(1) },
  mutedText: { ...type.body, color: colors.contentMuted, textAlign: 'center', maxWidth: 400 },
  emptyTitle: { ...type.h2, color: colors.content, textAlign: 'center', maxWidth: 440 },
  stateAction: { marginTop: spacing(2), minWidth: 160, maxWidth: '100%' },
  meta: { ...type.small, color: colors.contentMuted },
  notice: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing(2), padding: spacing(4), borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.md, backgroundColor: colors.surface },
  noticeCopy: { flex: 1, minWidth: 180, gap: spacing(1) },
  noticeTitle: { ...type.small, fontWeight: '600', color: colors.content },
  noticeText: { ...type.small, color: colors.contentMuted },
});
