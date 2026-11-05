import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { colors, radius, spacing, type } from '../theme';
import type { Title } from '../lib/types';
import { Artwork } from './Artwork';
import { Icon } from './Icon';

/**
 * Poster card (native twin of the web MediaCard). `progress` (0..1) draws the
 * resume bar used by Continue Watching / My List.
 */
export function MediaCard({
  title,
  progress,
  onPress,
  width = 132,
  variant = 'poster',
  caption,
}: {
  title: Title;
  progress?: number;
  onPress: () => void;
  width?: number;
  variant?: 'poster' | 'landscape';
  caption?: string;
}) {
  const { fontScale } = useWindowDimensions();
  const watched = typeof progress === 'number' && Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : undefined;
  const landscape = variant === 'landscape';
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${caption ? `${caption}, ` : ''}${title.name}${title.releaseYear ? `, ${title.releaseYear}` : ''}${watched !== undefined ? `, ${Math.round(watched * 100)} percent watched` : ''}`}
      accessibilityHint={landscape ? 'Continue watching' : 'View title details'}
      style={({ pressed }) => [{ width, opacity: pressed ? 0.75 : 1 }]}
    >
      <View style={[styles.posterWrap, { aspectRatio: landscape ? 16 / 9 : 2 / 3 }]}>
        <Artwork uri={landscape ? title.backdropUrl ?? title.posterUrl : title.posterUrl} label={title.name} style={styles.art} />
        {landscape ? <View style={styles.playMark}><Icon name="play" size={17} /></View> : null}
        {watched !== undefined ? (
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${Math.round(watched * 100)}%` }]} />
          </View>
        ) : null}
      </View>
      <Text style={[styles.name, landscape && styles.landscapeName]} numberOfLines={fontScale > 1.3 ? undefined : 2}>
        {title.name}
      </Text>
      <Text style={styles.meta} numberOfLines={fontScale > 1.3 ? undefined : 2}>
        {caption ?? [title.type === 'tv' ? 'Series' : 'Film', title.releaseYear || undefined].filter(Boolean).join(' \u00b7 ')}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  posterWrap: {
    width: '100%',
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: colors.surfaceRaised,
  },
  art: { width: '100%', height: '100%' },
  playMark: { position: 'absolute', left: spacing(3), bottom: spacing(3), width: 38, height: 38, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(8,10,12,0.78)', borderWidth: 1, borderColor: '#ffffff33' },
  progressTrack: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 3, backgroundColor: 'rgba(0,0,0,0.65)' },
  progressFill: { height: '100%', backgroundColor: colors.primary },
  name: { ...type.small, color: colors.content, fontWeight: '600', marginTop: spacing(2) },
  landscapeName: { ...type.h3, fontWeight: '600' },
  meta: { ...type.tiny, color: colors.contentMuted, marginTop: spacing(1) },
});
