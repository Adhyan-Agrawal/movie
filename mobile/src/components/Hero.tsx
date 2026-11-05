import { useEffect, useRef, useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { colors, radius, spacing, type } from '../theme';
import { Button, IconButton, MetaLine } from './ui';
import { Artwork } from './Artwork';
import { useBrowseLayout } from './layout';
import { useMotionEnabled } from './motion';
import type { Title } from '../lib/types';

/** Featured films stay still until the viewer chooses to swipe or page. */
export function Hero({ titles, onPressTitle }: { titles: Title[]; onPressTitle: (title: Title) => void }) {
  const layout = useBrowseLayout();
  const slideWidth = layout.width - layout.gutter * 2;
  const motion = useMotionEnabled();
  const listRef = useRef<FlatList<Title>>(null);
  const indexRef = useRef(0);
  const [index, setIndex] = useState(0);
  indexRef.current = index;

  useEffect(() => {
    const next = Math.max(0, Math.min(indexRef.current, titles.length - 1));
    setIndex(next);
    if (titles.length) listRef.current?.scrollToOffset({ offset: next * slideWidth, animated: false });
  }, [slideWidth, titles.length]);

  function page(next: number) {
    const clamped = Math.max(0, Math.min(next, titles.length - 1));
    setIndex(clamped);
    listRef.current?.scrollToIndex({ index: clamped, animated: motion });
  }

  if (!titles.length) return null;
  return <View style={[styles.wrap, { marginHorizontal: layout.gutter }]}>
    <FlatList
      ref={listRef}
      data={titles}
      keyExtractor={(title) => title.id}
      horizontal
      pagingEnabled
      showsHorizontalScrollIndicator={false}
      initialNumToRender={2}
      windowSize={3}
      getItemLayout={(_, i) => ({ length: slideWidth, offset: slideWidth * i, index: i })}
      onScrollToIndexFailed={({ index: failed }) => listRef.current?.scrollToOffset({ offset: failed * slideWidth, animated: false })}
      onMomentumScrollEnd={(event) => setIndex(Math.max(0, Math.min(titles.length - 1, Math.round(event.nativeEvent.contentOffset.x / slideWidth))))}
      renderItem={({ item }) => <View style={[styles.slide, { width: slideWidth }, layout.wide && styles.wideSlide]}>
        <Artwork uri={item.backdropUrl ?? item.posterUrl} label={item.name} style={layout.wide ? styles.wideArt : styles.art} />
        <View style={[styles.content, layout.wide && styles.wideContent]}>
          <Text style={styles.eyebrow}>IN THE SPOTLIGHT</Text>
          <Text accessibilityRole="header" style={styles.name}>{item.name}</Text>
          <MetaLine parts={[item.type === 'tv' ? 'Series' : 'Film', item.releaseYear ? String(item.releaseYear) : undefined, item.genres.slice(0, 2).join(', ')]} />
          {item.synopsis ? <Text style={styles.synopsis} numberOfLines={layout.largeText ? undefined : 3}>{item.synopsis}</Text> : null}
          <Button label="View title" variant="primary" icon="chevron-right" onPress={() => onPressTitle(item)} style={styles.action} accessibilityLabel={`View ${item.name}`} />
        </View>
      </View>}
    />
    {titles.length > 1 ? <View style={styles.pagination}>
      <Text accessibilityLabel={`Featured title ${index + 1} of ${titles.length}`} style={styles.counter}>{String(index + 1).padStart(2, '0')}<Text style={styles.counterMuted}> / {String(titles.length).padStart(2, '0')}</Text></Text>
      <View style={styles.arrows}><IconButton icon="chevron-left" label="Previous featured title" onPress={() => page(index - 1)} disabled={index === 0} /><IconButton icon="chevron-right" label="Next featured title" onPress={() => page(index + 1)} disabled={index >= titles.length - 1} /></View>
    </View> : null}
  </View>;
}

const styles = StyleSheet.create({
  wrap: { marginBottom: spacing(8) },
  slide: { backgroundColor: colors.surface, borderRadius: radius.lg, overflow: 'hidden', borderWidth: 1, borderColor: colors.border },
  wideSlide: { flexDirection: 'row', minHeight: 340 },
  art: { width: '100%', aspectRatio: 1.55 },
  wideArt: { width: '56%', alignSelf: 'stretch' },
  content: { padding: spacing(5), gap: spacing(3) },
  wideContent: { flex: 1, padding: spacing(7), justifyContent: 'center' },
  eyebrow: { ...type.tiny, fontWeight: '700', letterSpacing: 1.8, color: colors.contentMuted },
  name: { ...type.h1, color: colors.content },
  synopsis: { ...type.body, color: colors.contentMuted },
  action: { alignSelf: 'flex-start', marginTop: spacing(2), minWidth: 156, maxWidth: '100%' },
  pagination: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: spacing(3) },
  counter: { ...type.small, fontWeight: '700', color: colors.content, fontVariant: ['tabular-nums'] },
  counterMuted: { color: colors.contentSubtle, fontWeight: '400' },
  arrows: { flexDirection: 'row', gap: spacing(2) },
});
