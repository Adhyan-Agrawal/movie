import { useEffect, useRef, useState } from 'react';
import { Dimensions, FlatList, ImageBackground, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, radius, spacing, type } from '../theme';
import { Badge, Button } from './ui';
import type { Title } from '../lib/types';

/**
 * Auto-advancing hero carousel (native twin of the web HeroCarousel).
 * Pages through the top trending titles every 7s, pauses while the user is
 * dragging, and renders dots for manual paging.
 */
const { width } = Dimensions.get('window');
const HERO_HEIGHT = Math.round(width * 1.1);
const ADVANCE_MS = 7000;

export function Hero({ titles, onPressTitle }: { titles: Title[]; onPressTitle: (t: Title) => void }) {
  const listRef = useRef<FlatList<Title>>(null);
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused || titles.length <= 1) return;
    const timer = setInterval(() => {
      setIndex((i) => {
        const next = (i + 1) % titles.length;
        listRef.current?.scrollToIndex({ index: next, animated: true });
        return next;
      });
    }, ADVANCE_MS);
    return () => clearInterval(timer);
  }, [paused, titles.length]);

  if (titles.length === 0) return null;

  return (
    <View style={styles.wrap}>
      <FlatList
        ref={listRef}
        data={titles}
        keyExtractor={(t) => t.id}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
        onScrollBeginDrag={() => setPaused(true)}
        onMomentumScrollEnd={(e) => {
          setIndex(Math.round(e.nativeEvent.contentOffset.x / width));
          setPaused(false);
        }}
        renderItem={({ item }) => (
          <ImageBackground
            source={item.backdropUrl ? { uri: item.backdropUrl } : undefined}
            style={styles.slide}
            imageStyle={styles.slideImage}
          >
            <View style={styles.scrim} />
            <View style={styles.content}>
              <View style={styles.badges}>
                {item.type === 'tv' ? <Badge label="Series" tone="info" /> : null}
                <Badge label={item.maturity} />
              </View>
              <Text style={styles.name} numberOfLines={2}>
                {item.name}
              </Text>
              <Text style={styles.meta} numberOfLines={1}>
                {[item.releaseYear || undefined, item.genres.slice(0, 2).join(', ')].filter(Boolean).join('  ·  ')}
              </Text>
              <Text style={styles.synopsis} numberOfLines={3}>
                {item.synopsis}
              </Text>
              <View style={styles.actions}>
                <Button label="▶  Play" onPress={() => onPressTitle(item)} />
                <Button label="Details" variant="secondary" onPress={() => onPressTitle(item)} />
              </View>
            </View>
          </ImageBackground>
        )}
      />
      <View style={styles.dots}>
        {titles.slice(0, 10).map((_t, i) => (
          <Pressable
            key={i}
            accessibilityRole="button"
            accessibilityLabel={`Show featured title ${i + 1}`}
            onPress={() => {
              setIndex(i);
              listRef.current?.scrollToIndex({ index: i, animated: true });
            }}
            style={[styles.dot, i === index ? styles.dotActive : null]}
          />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { height: HERO_HEIGHT, marginBottom: spacing(4) },
  slide: { width, height: HERO_HEIGHT, justifyContent: 'flex-end', backgroundColor: colors.surface },
  slideImage: { opacity: 0.85 },
  scrim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(8,9,12,0.55)' },
  content: { padding: spacing(4), gap: spacing(2) },
  badges: { flexDirection: 'row', gap: spacing(2) },
  name: { ...type.h1, color: colors.content },
  meta: { ...type.small, color: colors.contentMuted },
  synopsis: { ...type.small, color: colors.contentMuted },
  actions: { flexDirection: 'row', gap: spacing(2), marginTop: spacing(1) },
  dots: { position: 'absolute', bottom: spacing(2), alignSelf: 'center', flexDirection: 'row', gap: 6 },
  dot: { width: 7, height: 7, borderRadius: radius.pill, backgroundColor: colors.contentSubtle },
  dotActive: { width: 18, backgroundColor: colors.primary },
});
