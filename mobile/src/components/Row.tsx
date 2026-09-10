import { FlatList, StyleSheet, Text, View } from 'react-native';
import { colors, spacing } from '../theme';
import { SectionTitle } from './ui';
import { MediaCard } from './MediaCard';
import type { Title } from '../lib/types';

/**
 * Horizontal shelf of poster cards. `progressById` lets a caller (Continue
 * Watching / My List) show a resume bar per title without changing the shape.
 */
export function Row({
  heading,
  reason,
  titles,
  onPressTitle,
  progressById,
}: {
  heading: string;
  reason?: string;
  titles: Title[];
  onPressTitle: (title: Title) => void;
  progressById?: Record<string, number | undefined>;
}) {
  if (titles.length === 0) return null;
  return (
    <View style={styles.wrap}>
      <SectionTitle>{heading}</SectionTitle>
      {reason ? <Text style={styles.reason}>{reason}</Text> : null}
      <FlatList
        data={titles}
        keyExtractor={(t) => t.id}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => (
          <MediaCard
            title={item}
            onPress={() => onPressTitle(item)}
            {...(progressById?.[item.id] !== undefined ? { progress: progressById[item.id] } : {})}
          />
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginBottom: spacing(6) },
  reason: { color: colors.contentSubtle, fontSize: 12, paddingHorizontal: spacing(4), marginTop: -spacing(1), marginBottom: spacing(2) },
  list: { paddingHorizontal: spacing(4), gap: spacing(3) },
});
