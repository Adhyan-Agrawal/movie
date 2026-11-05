import { useEffect, useState } from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import { colors, radius, spacing } from '../theme';
import { BROWSE_GAP, useBrowseLayout } from './layout';
import { useMotionEnabled } from './motion';

export function Skeletons({ kind = 'grid', label = 'Loading titles' }: { kind?: 'home' | 'grid' | 'detail' | 'person'; label?: string }) {
  const layout = useBrowseLayout();
  const motion = useMotionEnabled();
  const [opacity] = useState(() => new Animated.Value(1));
  useEffect(() => {
    opacity.setValue(1);
    if (!motion) return;
    const animation = Animated.loop(Animated.sequence([
      Animated.timing(opacity, { toValue: 0.5, duration: 900, useNativeDriver: true, isInteraction: false }),
      Animated.timing(opacity, { toValue: 1, duration: 900, useNativeDriver: true, isInteraction: false }),
    ]));
    animation.start();
    return () => { animation.stop(); opacity.stopAnimation(); };
  }, [motion, opacity]);

  return <View accessible accessibilityRole="progressbar" accessibilityLabel={label} accessibilityState={{ busy: true }} style={{ paddingHorizontal: layout.gutter, paddingVertical: spacing(4) }}>
    <Animated.View importantForAccessibility="no-hide-descendants" style={{ opacity }}>
      {kind === 'home' || kind === 'detail' ? <><View style={[styles.block, styles.hero, { aspectRatio: layout.wide ? 2.5 : 1.5 }]} /><View style={[styles.block, styles.title]} /><View style={[styles.block, styles.line]} /><View style={[styles.block, styles.action]} /></> : null}
      {kind === 'person' ? <View style={styles.profile}><View style={[styles.block, styles.portrait]} /><View style={[styles.block, styles.title]} /><View style={[styles.block, styles.line]} /></View> : null}
      <View style={styles.grid}>{Array.from({ length: layout.columns * 2 }, (_, i) => <View key={i} style={{ width: layout.cardWidth, gap: spacing(2) }}><View style={[styles.block, { aspectRatio: 2 / 3 }]} /><View style={[styles.block, styles.caption]} /><View style={[styles.block, styles.caption, { width: '65%' }]} /></View>)}</View>
    </Animated.View>
  </View>;
}

const styles = StyleSheet.create({
  block: { backgroundColor: colors.surfaceRaised, borderRadius: radius.md },
  hero: { width: '100%', marginBottom: spacing(5), borderRadius: radius.lg },
  title: { width: '70%', height: 32, marginBottom: spacing(3) },
  line: { width: '90%', height: 16, marginBottom: spacing(3) },
  action: { width: '50%', height: 56, marginBottom: spacing(8) },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: BROWSE_GAP, rowGap: spacing(6) },
  caption: { height: 12, borderRadius: radius.sm },
  profile: { alignItems: 'center', marginBottom: spacing(8) },
  portrait: { width: 136, height: 184, marginBottom: spacing(6) },
});
