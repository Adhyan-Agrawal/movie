import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useNavigation, type CompositeNavigationProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, spacing, type } from '../theme';
import { Button, EmptyState, FilterChip, Notice, Screen } from '../components/ui';
import { MediaCard } from '../components/MediaCard';
import { Skeletons } from '../components/Skeletons';
import { BROWSE_GAP, useBrowseLayout } from '../components/layout';
import { currentUser, listWatchlist, toggleWatchlist } from '../lib/api';
import type { Title } from '../lib/types';
import type { RootStackParamList, TabParamList } from '../navigation';

type Nav = CompositeNavigationProp<BottomTabNavigationProp<TabParamList>, NativeStackNavigationProp<RootStackParamList>>;

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
  const layout = useBrowseLayout();
  const request = useRef(0);
  const mounted = useRef(true);

  // `signedIn === null` while the session is still being resolved.
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [titles, setTitles] = useState<Title[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [removeFailed, setRemoveFailed] = useState(false);
  const [filter, setFilter] = useState<'all' | 'movie' | 'tv'>('all');

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; request.current++; };
  }, []);

  const load = useCallback(async () => {
    const current = ++request.current;
    try {
      const user = await currentUser();
      if (current !== request.current) return;
      const saved = user ? await listWatchlist() : [];
      if (current !== request.current) return;
      setSignedIn(Boolean(user));
      setTitles(saved);
      setLoadFailed(false);
    } catch {
      if (current !== request.current) return;
      setSignedIn(false);
      setTitles([]);
      setLoadFailed(true);
    }
  }, []);

  // Reload on focus so a sign-in (or a bookmark toggled elsewhere) is reflected.
  useFocusEffect(
    useCallback(() => {
      void load();
      return () => { request.current++; };
    }, [load]),
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try { await load(); } finally { if (mounted.current) setRefreshing(false); }
  }, [load]);

  async function remove(title: Title) {
    if (removingId) return;
    setRemoveFailed(false);
    setRemovingId(title.id);
    let ok = false;
    try {
      const res = await toggleWatchlist(title.id);
      ok = res.ok;
    } catch {
      ok = false;
    } finally {
      if (mounted.current) setRemovingId(null);
    }
    if (!mounted.current) return;
    // Drop it optimistically when the write landed; otherwise resync with the
    // server so the grid never lies about what's saved.
    if (ok) setTitles((prev) => prev.filter((t) => t.id !== title.id));
    else { setRemoveFailed(true); await load().catch(() => {}); }
  }

  const header = <View style={[styles.headerWrap, { paddingTop: insets.top + spacing(5), paddingHorizontal: layout.gutter, maxWidth: layout.width }]}>
    <Text accessibilityRole="header" style={styles.screenTitle}>My List</Text><Text style={styles.subtitle}>{signedIn && titles.length ? `${titles.length} ${titles.length === 1 ? 'title' : 'titles'}, saved for later.` : 'Keep your next watch close.'}</Text>
  </View>;
  const visible = titles.filter((title) => filter === 'all' || title.type === filter);

  if (signedIn === null) {
    return (
      <Screen safeSides>{header}
        <ScrollView style={{ width: '100%', maxWidth: layout.width, alignSelf: 'center' }}><Skeletons label="Loading My List" /></ScrollView>
      </Screen>
    );
  }

  if (loadFailed) return <Screen safeSides>{header}<EmptyState icon="bookmark" title="Your list didn't load" description="If you're offline, reconnect and try again. Your saved titles are still yours." actionLabel="Try again" onAction={() => void onRefresh()} /></Screen>;

  if (!signedIn) {
    return (
      <Screen safeSides>{header}
        <EmptyState
          title="Sign in to build your list"
          description="Your saved titles sync across devices once you're signed in."
          icon="bookmark"
          actionLabel="Sign in"
          onAction={() => navigation.navigate('Auth')}
        />
      </Screen>
    );
  }

  return (
    <Screen safeSides>
      {header}
      {titles.length ? <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.filters} contentContainerStyle={[styles.filterContent, { paddingHorizontal: layout.gutter }]}>{([{ id: 'all', label: 'All' }, { id: 'movie', label: 'Films' }, { id: 'tv', label: 'Series' }] as const).map((item) => <FilterChip key={item.id} label={item.label} active={filter === item.id} onPress={() => setFilter(item.id)} accessibilityLabel={`Show saved ${item.label.toLowerCase()}`} />)}</ScrollView> : null}
      {removeFailed ? <View style={{ marginHorizontal: layout.gutter, marginBottom: spacing(4) }}><Notice title="That title couldn't be removed" description="Your list has been checked again. Please try once more." /></View> : null}
      <FlatList
        key={layout.columns}
        data={visible}
        keyExtractor={(t) => t.id}
        numColumns={layout.columns}
        columnWrapperStyle={styles.column}
        style={{ width: '100%', maxWidth: layout.width, alignSelf: 'center' }}
        contentContainerStyle={[styles.list, { paddingHorizontal: layout.gutter, paddingBottom: spacing(10) + insets.bottom, flexGrow: visible.length ? 0 : 1 }]}
        initialNumToRender={12}
        maxToRenderPerBatch={12}
        windowSize={5}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.contentMuted} />
        }
        ListEmptyComponent={
          <EmptyState
            icon="bookmark"
            title={titles.length ? `No ${filter === 'movie' ? 'films' : 'series'} saved yet` : 'A place for your next favorite'}
            description={titles.length ? 'Switch to All to see your saved titles.' : 'Add films and series to My List from any title page.'}
            actionLabel={titles.length ? 'Show all' : 'Explore titles'}
            onAction={titles.length ? () => setFilter('all') : () => navigation.navigate('Home')}
          />
        }
        renderItem={({ item }) => (
          <View style={{ width: layout.cardWidth, gap: spacing(1) }}>
            <MediaCard
              title={item}
              width={layout.cardWidth}
              onPress={() => navigation.navigate('Title', { type: item.type, slug: item.slug })}
            />
            <Button
              label="Remove"
              variant="ghost"
              size="sm"
              onPress={() => remove(item)}
              disabled={Boolean(removingId && removingId !== item.id)}
              loading={removingId === item.id}
              accessibilityLabel={`Remove ${item.name} from your list`}
              style={styles.removeButton}
            />
          </View>
        )}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  headerWrap: {
    width: '100%',
    alignSelf: 'center',
    gap: spacing(3),
    paddingBottom: spacing(5),
  },
  screenTitle: { ...type.h1, color: colors.content },
  subtitle: { ...type.small, color: colors.contentMuted },
  filters: { flexGrow: 0, marginBottom: spacing(6) },
  filterContent: { gap: spacing(2) },
  list: { gap: spacing(6) },
  column: { gap: BROWSE_GAP },
  removeButton: { paddingHorizontal: spacing(1), alignSelf: 'stretch' },
});
