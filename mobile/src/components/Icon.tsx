import { StyleSheet, View } from 'react-native';
import { colors } from '../theme';

export type IconName = 'play' | 'search' | 'plus' | 'check' | 'close' | 'chevron-right' | 'chevron-left' | 'bookmark' | 'filter' | 'film';

/** Small native shapes keep navigation independent of icon fonts. */
export function Icon({ name, color = colors.content, size = 20 }: { name: IconName; color?: string; size?: number }) {
  return (
    <View accessible={false} importantForAccessibility="no-hide-descendants" pointerEvents="none" style={[styles.frame, { width: size, height: size }]}>
      {name === 'play' ? <View style={{ borderLeftWidth: size * 0.55, borderTopWidth: size * 0.34, borderBottomWidth: size * 0.34, borderLeftColor: color, borderTopColor: 'transparent', borderBottomColor: 'transparent', marginLeft: 3 }} /> : null}
      {name === 'search' ? <><View style={{ width: size * 0.65, height: size * 0.65, borderWidth: 1.8, borderColor: color, borderRadius: size, position: 'absolute', left: 1, top: 1 }} /><View style={{ width: size * 0.4, height: 1.8, backgroundColor: color, position: 'absolute', right: 0, bottom: 3, transform: [{ rotate: '45deg' }] }} /></> : null}
      {name === 'plus' || name === 'close' ? <View style={[styles.frame, { width: size, height: size, transform: [{ rotate: name === 'close' ? '45deg' : '0deg' }] }]}><View style={{ position: 'absolute', width: size * 0.7, height: 1.8, backgroundColor: color }} /><View style={{ position: 'absolute', height: size * 0.7, width: 1.8, backgroundColor: color }} /></View> : null}
      {name === 'check' ? <View style={{ width: size * 0.55, height: size * 0.3, borderLeftWidth: 2, borderBottomWidth: 2, borderColor: color, transform: [{ rotate: '-45deg' }], marginTop: -3 }} /> : null}
      {name === 'chevron-right' || name === 'chevron-left' ? <View style={{ width: size * 0.4, height: size * 0.4, borderTopWidth: 1.8, borderRightWidth: 1.8, borderColor: color, transform: [{ rotate: name === 'chevron-right' ? '45deg' : '-135deg' }] }} /> : null}
      {name === 'bookmark' ? <View style={{ width: size * 0.6, height: size * 0.8, borderWidth: 1.8, borderColor: color, borderTopLeftRadius: 2, borderTopRightRadius: 2 }} /> : null}
      {name === 'filter' ? <>{[0.2, 0.5, 0.8].map((position, i) => <View key={i} style={{ position: 'absolute', top: size * position, width: size * (0.85 - i * 0.22), height: 1.8, backgroundColor: color }} />)}</> : null}
      {name === 'film' ? <View style={{ width: size * 0.85, height: size * 0.7, borderWidth: 1.5, borderColor: color, borderRadius: 3, justifyContent: 'space-evenly' }}>{[0, 1].map((i) => <View key={i} style={{ height: 1.5, backgroundColor: color }} />)}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({ frame: { alignItems: 'center', justifyContent: 'center', flexShrink: 0 } });
