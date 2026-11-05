import { useEffect, useRef, useState } from 'react';
import { Image, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { colors, spacing, type } from '../theme';
import { Icon } from './Icon';

export function Artwork({ uri, label, style, portrait = false }: { uri?: string | null; label: string; style?: StyleProp<ViewStyle>; portrait?: boolean }) {
  const [failed, setFailed] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<string | null>(null);
  const currentUri = useRef(uri);
  const alive = useRef(true);
  currentUri.current = uri;
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  const available = Boolean(uri && failed !== uri);
  return (
    <View accessible={false} importantForAccessibility="no-hide-descendants" style={[styles.frame, style]}>
      {(!available || loaded !== uri) ? <View style={styles.placeholder}>
        {portrait ? <Text style={styles.initial}>{label.slice(0, 1).toUpperCase()}</Text> : <Icon name="film" color={colors.contentSubtle} size={28} />}
        {!available && !portrait ? <Text style={styles.caption} numberOfLines={3}>{label}</Text> : null}
      </View> : null}
      {available && uri ? <Image
        key={uri}
        source={{ uri }}
        resizeMode="cover"
        style={styles.image}
        accessible={false}
        onLoad={() => { if (alive.current && currentUri.current === uri) setLoaded(uri); }}
        onError={() => { if (alive.current && currentUri.current === uri) setFailed(uri); }}
      /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { overflow: 'hidden', backgroundColor: colors.surfaceRaised },
  image: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, width: '100%', height: '100%' },
  placeholder: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing(3), padding: spacing(3) },
  caption: { ...type.small, color: colors.contentMuted, textAlign: 'center' },
  initial: { ...type.h1, color: colors.contentSubtle },
});
