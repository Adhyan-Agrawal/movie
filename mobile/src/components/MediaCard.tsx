import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, radius, spacing, type } from '../theme';
import type { Title } from '../lib/types';

/**
 * Poster card (native twin of the web MediaCard). `progress` (0..1) draws the
 * resume bar used by Continue Watching / My List.
 */
export function MediaCard({
  title,
  progress,
  onPress,
  width = 132,
}: {
  title: Title;
  progress?: number;
  onPress: () => void;
  width?: number;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${title.name}${title.releaseYear ? `, ${title.releaseYear}` : ''}`}
      style={({ pressed }) => [{ width, opacity: pressed ? 0.85 : 1 }]}
    >
      <View style={[styles.posterWrap, { height: width * 1.5 }]}>
        {title.posterUrl ? (
          <Image source={{ uri: title.posterUrl }} style={styles.poster} resizeMode="cover" />
        ) : (
          <View style={styles.posterFallback}>
            <Text style={styles.posterFallbackText} numberOfLines={2}>
              {title.name}
            </Text>
          </View>
        )}
        {typeof progress === 'number' ? (
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${Math.round(Math.min(1, Math.max(0, progress)) * 100)}%` }]} />
          </View>
        ) : null}
      </View>
      <Text style={styles.name} numberOfLines={2}>
        {title.name}
      </Text>
      <Text style={styles.meta} numberOfLines={1}>
        {[title.releaseYear || undefined, title.genres[0]].filter(Boolean).join(' · ')}
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
    borderWidth: 1,
    borderColor: colors.border,
  },
  poster: { width: '100%', height: '100%' },
  posterFallback: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing(2) },
  posterFallbackText: { ...type.small, color: colors.contentSubtle, textAlign: 'center' },
  progressTrack: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 3, backgroundColor: 'rgba(0,0,0,0.5)' },
  progressFill: { height: '100%', backgroundColor: colors.primary },
  name: { ...type.small, color: colors.content, fontWeight: '600', marginTop: spacing(1.5) },
  meta: { ...type.tiny, color: colors.contentSubtle, marginTop: 2 },
});
