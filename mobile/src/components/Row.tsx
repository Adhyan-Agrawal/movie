import { FlatList, StyleSheet, View } from 'react-native';
import { spacing } from '../theme';
import { SectionTitle } from './ui';
import { MediaCard } from './MediaCard';
import type { Title } from '../lib/types';
import { useBrowseLayout } from './layout';

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
  captionById,
  variant = 'poster',
  onPressAll,
}: {
  heading: string;
  reason?: string;
  titles: Title[];
  onPressTitle: (title: Title) => void;
  progressById?: Record<string, number | undefined>;
  captionById?: Record<string, string | undefined>;
  variant?: 'poster' | 'landscape';
  onPressAll?: () => void;
}) {
  const layout = useBrowseLayout();
  if (titles.length === 0) return null;
  return (
    <View style={styles.wrap}>
      <SectionTitle description={reason} onAction={onPressAll}>{heading}</SectionTitle>
      <FlatList
        data={titles}
        keyExtractor={(t) => t.id}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={[styles.list, { paddingHorizontal: layout.gutter }]}
        initialNumToRender={4}
        maxToRenderPerBatch={6}
        windowSize={5}
        renderItem={({ item }) => (
          <MediaCard
            title={item}
            variant={variant}
            width={variant === 'landscape' ? layout.landscapeWidth : layout.shelfWidth}
            onPress={() => onPressTitle(item)}
            caption={captionById?.[item.id]}
            {...(progressById?.[item.id] !== undefined ? { progress: progressById[item.id] } : {})}
          />
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginBottom: spacing(9) },
  list: { gap: spacing(3) },
});
