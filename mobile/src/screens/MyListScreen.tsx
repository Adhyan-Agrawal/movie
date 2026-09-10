import { useCallback, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, radius, spacing, type } from '../theme';
import { Button, EmptyState, Loading, Screen } from '../components/ui';
import { MediaCard } from '../components/MediaCard';
import { currentUser, listWatchlist, toggleWatchlist } from '../lib/api';
import type { Title } from '../lib/types';
import type { RootStackParamList } from '../navigation';

type Nav = NativeStackNavigationProp<RootStackParamList>;

const COLUMNS = 3;
const GAP = spacing(3);
const H_PAD = spacing(4);

/**
 * The viewer's saved titles as a poster grid.
 *
 * The watchlist is per-account (RLS-scoped), so signed-out visitors get a
 * sign-in prompt rather than a misleadingly empty grid. Removal reuses
 * `toggleWatchlist` — the same call the bookmark button makes — then reloads,
 * so the grid always reflects what the server actually holds.
 */
export default function MyListScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();

  // `signedIn === null` while the session is still being resolved.
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [titles, setTitles] = useState<Title[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const cardWidth = Math.floor((width - H_PAD * 2 - GAP * (COLUMNS - 1)) / COLUMNS);

  const load = useCallback(async () => {
    const user = await currentUser();
    setSignedIn(Boolean(user));
    setTitles(user ? await listWatchlist() : []);
  }, []);

  // Reload on focus so a sign-in (or a bookmark toggled elsewhere) is reflected.
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  async function remove(title: Title) {
    if (removingId) return;
    setRemovingId(title.id);
    let ok = false;
    try {
      const res = await toggleWatchlist(title.id);
      ok = res.ok;
    } finally {
      setRemovingId(null);
    }
    // Drop it optimistically when the write landed; otherwise resync with the
    // server so the grid never lies about what's saved.
    if (ok) setTitles((prev) => prev.filter((t) => t.id !== title.id));
    else await load();
  }

  if (signedIn === null) {
    return (
      <Screen>
        <Loading label="Loading your list…" />
      </Screen>
    );
  }

  if (!signedIn) {
    return (
      <Screen>
        <View style={[styles.headerWrap, { paddingTop: insets.top + spacing(5) }]}>
          <Text style={styles.screenTitle}>My List</Text>
        </View>
        <EmptyState
          title="Sign in to build your list"
          description="Your saved titles sync across devices once you're signed in."
        />
        <View style={styles.cta}>
          <Button label="Sign in" onPress={() => navigation.navigate('Auth')} />
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <View style={[styles.headerWrap, { paddingTop: insets.top + spacing(5) }]}>
        <Text style={styles.screenTitle}>My List</Text>
        {titles.length > 0 ? (
          <Text style={styles.count}>{titles.length === 1 ? '1 title' : `${titles.length} titles`}</Text>
        ) : null}
      </View>
      <FlatList
        data={titles}
        keyExtractor={(t) => t.id}
        numColumns={COLUMNS}
        columnWrapperStyle={styles.column}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.contentMuted} />
        }
        ListEmptyComponent={
          <EmptyState
            title="Your list is empty"
            description="Tap the bookmark on any title to save it here."
          />
        }
        renderItem={({ item }) => (
          <View style={{ width: cardWidth }}>
            <MediaCard
              title={item}
              width={cardWidth}
              onPress={() => navigation.navigate('Title', { type: item.type, slug: item.slug })}
            />
            <Pressable
              onPress={() => remove(item)}
              disabled={removingId === item.id}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel={`Remove ${item.name} from your list`}
              style={({ pressed }) => [styles.removeBtn, { opacity: pressed ? 0.7 : 1 }]}
            >
              <Text style={styles.removeGlyph}>{removingId === item.id ? '…' : '✕'}</Text>
            </Pressable>
          </View>
        )}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  headerWrap: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    paddingHorizontal: spacing(4),
    paddingBottom: spacing(3),
  },
  screenTitle: { ...type.h1, color: colors.content },
  count: { ...type.small, color: colors.contentSubtle },
  list: { paddingHorizontal: H_PAD, paddingBottom: spacing(12), gap: GAP },
  column: { gap: GAP },
  cta: { paddingHorizontal: spacing(4), paddingBottom: spacing(8) },
  removeBtn: {
    position: 'absolute',
    top: spacing(1),
    right: spacing(1),
    width: 26,
    height: 26,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(8,9,12,0.78)',
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  removeGlyph: { color: colors.content, fontSize: 13, fontWeight: '700', lineHeight: 16 },
});
