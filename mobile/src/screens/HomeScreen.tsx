import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  useWindowDimensions,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, radius, spacing, type } from '../theme';
import { Button, EmptyState, Loading, Screen, SectionTitle } from '../components/ui';
import { Hero } from '../components/Hero';
import { Row } from '../components/Row';
import { MediaCard } from '../components/MediaCard';
import { currentUser, fetchContinueWatching, listAllGenres } from '../lib/api';
import { fetchHome, getTitleBySlug, listTitles } from '../lib/catalog-bridge';
import { readGuestEntries } from '../lib/guest';
import type { ContinueEntry, MediaRow, Title } from '../lib/types';
import type { RootStackParamList } from '../navigation';

/**
 * Home — the catalog landing surface.
 *
 * Loads `fetchHome()` on mount and renders the auto-advancing hero carousel
 * followed by one shelf per returned row. Pull-to-refresh re-fetches the whole
 * payload. The screen is deliberately honest about state: a failed fetch or an
 * empty catalog shows an EmptyState (with a retry) instead of placeholder
 * titles, so nothing on screen is invented data.
 *
 * "Browse by genre" chips come from `listAllGenres()`; tapping one filters the
 * catalog with `listTitles({ genre })` and renders the results inline in a
 * three-column grid below the chips. Tapping again clears the selection.
 */

const COLUMN_GAP = spacing(3);
const MAX_GENRES = 18;

type DiscoveryFilter = NonNullable<Parameters<typeof listTitles>[0]> & { originalLanguage?: string; country?: string };
type Collection = { id: string; label: string; href?: string; filters: DiscoveryFilter };
type DiscoveryRow = MediaRow & { href?: string; filters?: DiscoveryFilter };

type LoadState = 'loading' | 'ready' | 'error';
type GenreState = 'idle' | 'loading' | 'ready' | 'error';

export default function HomeScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const cardWidth = Math.floor((width - spacing(4) * 2 - COLUMN_GAP * 2) / 3);
  const scroll = useRef<ScrollView>(null);
  const filterTop = useRef(0);

  const [state, setState] = useState<LoadState>('loading');
  const [hero, setHero] = useState<Title[]>([]);
  const [rows, setRows] = useState<DiscoveryRow[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [continueEntries, setContinueEntries] = useState<ContinueEntry[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const [genres, setGenres] = useState<string[]>([]);
  const [activeGenre, setActiveGenre] = useState<string | null>(null);
  const [genreTitles, setGenreTitles] = useState<Title[]>([]);
  const [genreState, setGenreState] = useState<GenreState>('idle');
  /** Monotonic id — only the newest genre request may write state. */
  const genreRequest = useRef(0);

  const openTitle = useCallback(
    (title: Title) => navigation.navigate('Title', { type: title.type, slug: title.slug }),
    [navigation],
  );

  /**
   * Resume from a Continue-Watching card. Entries saved before ids were
   * persisted (or guest rows) may lack tmdb/imdb ids — without one the bridge
   * returns no source, so resolve the catalog row first.
   */
  const playEntry = useCallback(
    async (entry: ContinueEntry) => {
      let t = entry.title;
      if (!t.tmdbId && !t.imdbId) {
        const fresh = await getTitleBySlug(t.type, t.slug).catch(() => null);
        if (fresh) t = fresh;
      }
      navigation.navigate('Player', {
        titleId: t.id,
        type: t.type,
        slug: t.slug,
        name: t.name,
        ...(t.posterUrl ? { posterUrl: t.posterUrl } : {}),
        ...(t.backdropUrl ? { backdropUrl: t.backdropUrl } : {}),
        ...(t.tmdbId ? { tmdbId: t.tmdbId } : {}),
        ...(t.imdbId ? { imdbId: t.imdbId } : {}),
        ...(entry.seasonNumber !== undefined ? { season: entry.seasonNumber } : {}),
        ...(entry.episodeNumber !== undefined ? { episode: entry.episodeNumber } : {}),
        ...(entry.episodeId ? { episodeId: entry.episodeId } : {}),
      });
    },
    [navigation],
  );

  /** Fetch the full home payload. Errors become an explicit error state. */
  const loadHome = useCallback(async (isRefresh: boolean) => {
    if (isRefresh) setRefreshing(true);
    else setState('loading');
    try {
      // Continue Watching lives on Home (not just the Account tab) — signed-in
      // viewers read their server rows, guests their device-local store. A
      // failure here must not sink the catalog, so it degrades to no shelf.
      const [data, continueEntries] = await Promise.all([
        fetchHome(),
        (async () => {
          try {
            const user = await currentUser();
            return user ? await fetchContinueWatching(12) : await readGuestEntries();
          } catch {
            return [];
          }
        })(),
      ]);
      setHero(data.hero);
      const discovery = data as typeof data & { collections?: Collection[]; forYou?: MediaRow | null };
      const publicRows = data.rows.filter((row) => row.titles.length > 0);
      setRows(discovery.forYou?.titles.length && !publicRows.some((row) => row.id === discovery.forYou!.id) ? [discovery.forYou, ...publicRows] : publicRows);
      setCollections(discovery.collections ?? []);
      setContinueEntries(continueEntries);
      setState('ready');
    } catch {
      setHero([]);
      setRows([]);
      setCollections([]);
      setContinueEntries([]);
      setState('error');
    } finally {
      if (isRefresh) setRefreshing(false);
    }
  }, []);

  /** Genres are a secondary section — a failure just hides the chips. */
  const loadGenres = useCallback(async () => {
    try {
      setGenres(await listAllGenres());
    } catch {
      setGenres([]);
    }
  }, []);

  useEffect(() => {
    void loadHome(false);
    void loadGenres();
  }, [loadHome, loadGenres]);

  useFocusEffect(useCallback(() => {
    void loadHome(false);
  }, [loadHome]));

  const onRefresh = useCallback(() => {
    void loadHome(true);
    void loadGenres();
  }, [loadHome, loadGenres]);

  /** Toggle a genre chip and swap the inline grid for its titles. */
  const onPressGenre = useCallback(
    async (genre: string, filters: DiscoveryFilter = { genre }) => {
      if (genre === activeGenre) {
        genreRequest.current += 1; // drop any in-flight load for the old chip
        setActiveGenre(null);
        setGenreTitles([]);
        setGenreState('idle');
        return;
      }
      const id = ++genreRequest.current;
      setActiveGenre(genre);
      setGenreTitles([]);
      setGenreState('loading');
      scroll.current?.scrollTo({ y: filterTop.current, animated: false });
      try {
        const list = await listTitles({ ...filters, pageSize: 30 });
        if (id !== genreRequest.current) return;
        setGenreTitles(list);
        setGenreState('ready');
      } catch {
        if (id !== genreRequest.current) return;
        setGenreState('error');
      }
    },
    [activeGenre],
  );

  const hasContent = hero.length > 0 || rows.length > 0;

  const discoverySection = genres.length > 0 || collections.length > 0 ? (
    <View style={styles.genreSection} onLayout={(event) => { filterTop.current = event.nativeEvent.layout.y; }}>
      <SectionTitle>Find your next favorite</SectionTitle>
      {collections.length ? <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.collectionChips}>
        {collections.map((item) => <Chip key={item.id} label={item.label} active={item.label === activeGenre} onPress={() => void onPressGenre(item.label, item.filters)} />)}
      </ScrollView> : null}
      <View style={styles.chips}>
        {genres.slice(0, MAX_GENRES).filter((genre) => !collections.some((item) => item.filters.genre === genre)).map((genre) => <Chip key={genre} label={genre} active={genre === activeGenre} onPress={() => void onPressGenre(genre)} />)}
      </View>
      {genreState === 'loading' ? <InlineLoading label={`Loading ${activeGenre}...`} /> : null}
      {genreState === 'error' ? <EmptyState title="Couldn't load that collection" description="Select it again to clear, then retry." /> : null}
      {genreState === 'ready' ? <Text accessibilityRole="header" accessibilityLiveRegion="polite" style={styles.resultsLabel}>{activeGenre} / {genreTitles.length} titles</Text> : null}
      {genreState === 'ready' && !genreTitles.length ? <EmptyState title="No matching titles right now" /> : null}
      {genreState === 'ready' && genreTitles.length > 0 ? <View style={styles.grid}>
        {genreTitles.map((title) => <MediaCard key={title.id} title={title} width={cardWidth} onPress={() => openTitle(title)} />)}
      </View> : null}
    </View>
  ) : null;

  return (
    <Screen>
      <ScrollView
        ref={scroll}
        contentContainerStyle={[styles.scroll, { paddingTop: insets.top + spacing(4) }]}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.primary}
            colors={[colors.primary]}
            progressBackgroundColor={colors.surfaceRaised}
          />
        }
      >
        <Text style={styles.wordmark} accessibilityRole="header">
          Lumora
        </Text>

        {state === 'loading' ? <Loading label="Loading Lumora…" /> : null}

        {state === 'error' ? (
          <>
            <EmptyState title="Couldn’t load Lumora" description="Check your connection and pull down to retry." />
            <Button label="Try again" onPress={() => void loadHome(false)} style={styles.retry} />
          </>
        ) : null}

        {state === 'ready' && !hasContent ? (
          <EmptyState title="Nothing to watch yet" description="The catalog is empty right now — new titles land soon." />
        ) : null}

        {state === 'ready' && hasContent ? (
          <>
            {/* Continue Watching first: it's the most likely thing a returning
                viewer wants, and it only renders when there's real history. */}
            {continueEntries.length > 0 ? (
              <Row
                heading="Continue watching"
                titles={continueEntries.map((e) => e.title)}
                onPressTitle={(t) => {
                  const entry = continueEntries.find((e) => e.title.id === t.id);
                  if (entry) void playEntry(entry);
                }}
                progressById={Object.fromEntries(continueEntries.map((e) => [e.title.id, e.progress]))}
              />
            ) : null}
            <Hero titles={hero} onPressTitle={openTitle} />
            {discoverySection}
            {rows.map((row) => (
              <View key={row.id}>
              {row.filters ? <Pressable onPress={() => void onPressGenre(row.heading, row.filters)} accessibilityRole="button" accessibilityLabel={`View all ${row.heading}`} style={styles.viewAll}><Text style={styles.viewAllText}>View all / {row.heading}</Text></Pressable> : null}
              <Row
                heading={row.heading}
                reason={row.reason}
                titles={row.titles}
                onPressTitle={openTitle}
              />
              </View>
            ))}
          </>
        ) : null}

        {state === 'ready' && !hasContent ? discoverySection : null}
      </ScrollView>
    </Screen>
  );
}

/** Genre filter chip — toggles the inline grid below the row of chips. */
function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={`Browse ${label} titles`}
      style={({ pressed }) => [styles.chip, active && styles.chipActive, { opacity: pressed ? 0.8 : 1 }]}
    >
      <Text style={[styles.chipLabel, active && styles.chipLabelActive]}>{label}</Text>
    </Pressable>
  );
}

/** Compact spinner sized for inline sections (the shared `Loading` fills space). */
function InlineLoading({ label }: { label: string }) {
  return (
    <View style={styles.inlineLoading} accessibilityRole="progressbar" accessibilityLabel={label}>
      <ActivityIndicator color={colors.primary} />
      <Text style={styles.inlineLoadingLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  scroll: { flexGrow: 1, paddingBottom: spacing(8) },
  wordmark: { ...type.h1, color: colors.content, paddingHorizontal: spacing(4), marginBottom: spacing(3) },
  retry: { marginHorizontal: spacing(4), alignSelf: 'center', minWidth: 160 },
  genreSection: { marginTop: spacing(2) },
  collectionChips: { gap: spacing(2), paddingHorizontal: spacing(4), paddingBottom: spacing(3) },
  resultsLabel: { ...type.small, color: colors.contentMuted, paddingHorizontal: spacing(4), paddingTop: spacing(3) },
  viewAll: { minHeight: 44, justifyContent: 'center', alignItems: 'flex-end', paddingHorizontal: spacing(4), marginTop: spacing(2) },
  viewAllText: { ...type.small, color: colors.primary, fontWeight: '600' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing(2), paddingHorizontal: spacing(4) },
  chip: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: spacing(3),
    paddingVertical: spacing(2),
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipLabel: { ...type.small, color: colors.contentMuted, fontWeight: '600' },
  chipLabelActive: { color: colors.primaryContrast },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: COLUMN_GAP,
    paddingHorizontal: spacing(4),
    marginTop: spacing(3),
  },
  inlineLoading: { flexDirection: 'row', alignItems: 'center', gap: spacing(2), padding: spacing(4) },
  inlineLoadingLabel: { ...type.small, color: colors.contentMuted },
});
