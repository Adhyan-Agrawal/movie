import { useCallback, useEffect, useRef, useState } from 'react';
import {
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useFocusEffect, useNavigation, type CompositeNavigationProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, spacing, type } from '../theme';
import { EmptyState, FilterChip, IconButton, Notice, Screen, SectionTitle } from '../components/ui';
import { Skeletons } from '../components/Skeletons';
import { BROWSE_GAP, useBrowseLayout } from '../components/layout';
import { Hero } from '../components/Hero';
import { Row } from '../components/Row';
import { MediaCard } from '../components/MediaCard';
import { HomeAdMobBanner } from '../ads/AdMobProvider';
import { currentUser, fetchContinueWatching, listAllGenres } from '../lib/api';
import { fetchHome, getCachedHome, getTitleBySlug, listTitles } from '../lib/catalog-bridge';
import { readGuestEntries } from '../lib/guest';
import type { ContinueEntry, HomeData, MediaRow, Title, TitleFilters } from '../lib/types';
import type { RootStackParamList, TabParamList } from '../navigation';

/**
 * Home: real catalog shelves and account or device-local continue watching.
 *
 * Uses recently verified public home data on focus and renders the manually paged
 * hero followed by one shelf per returned row. Pull-to-refresh bypasses that
 * cache; account/device history is always read separately. A failed fetch or an
 * empty catalog shows an EmptyState (with a retry) instead of placeholder
 * titles, so nothing on screen is invented data.
 *
 * "Browse by genre" chips come from `listAllGenres()`; tapping one filters the
 * catalog with `listTitles({ genre })` and renders the results inline in a
 * responsive grid below the chips. Tapping again clears the selection.
 */

const MAX_GENRES = 18;

type Collection = NonNullable<HomeData['collections']>[number];

type LoadState = 'loading' | 'ready' | 'error';
type GenreState = 'idle' | 'loading' | 'ready' | 'error';

export default function HomeScreen() {
  const navigation = useNavigation<CompositeNavigationProp<BottomTabNavigationProp<TabParamList>, NativeStackNavigationProp<RootStackParamList>>>();
  const insets = useSafeAreaInsets();
  const layout = useBrowseLayout();
  const scroll = useRef<ScrollView>(null);
  const filterTop = useRef(0);
  const filterScrollRequested = useRef(false);
  const homeRequest = useRef(0);
  const genreListRequest = useRef(0);
  const hasLoaded = useRef(false);
  const mounted = useRef(true);
  const selectedFilters = useRef<TitleFilters>({});

  const [state, setState] = useState<LoadState>('loading');
  const [hero, setHero] = useState<Title[]>([]);
  const [rows, setRows] = useState<MediaRow[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [continueEntries, setContinueEntries] = useState<ContinueEntry[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [resumeFailed, setResumeFailed] = useState(false);

  const [genres, setGenres] = useState<string[]>([]);
  const [activeGenre, setActiveGenre] = useState<string | null>(null);
  const [activeFilterId, setActiveFilterId] = useState<string | null>(null);
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
      setResumeFailed(false);
      let t = entry.title;
      if (!t.tmdbId && !t.imdbId) {
        const fresh = await getTitleBySlug(t.type, t.slug).catch(() => null);
        if (fresh) t = fresh;
      }
      if (!mounted.current) return;
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

  /** Public catalog and private/device history have separate lifetimes. */
  const loadHome = useCallback(async (isRefresh: boolean) => {
    const request = homeRequest.current + 1;
    homeRequest.current = request;
    setRefreshing(isRefresh);
    setContinueEntries([]);
    if (!isRefresh && !hasLoaded.current) setState('loading');
    // A cached public home must not wait for account or guest history. Never
    // reuse that history across focus loads or a viewer-identity transition.
    void (async () => {
      let entries: ContinueEntry[] = [];
      try {
        const user = await currentUser();
        entries = user ? await fetchContinueWatching(12) : await readGuestEntries();
      } catch { /* History failure cannot hide the public catalog. */ }
      if (request === homeRequest.current && mounted.current) setContinueEntries(entries);
    })();
    try {
      const cached = isRefresh ? null : getCachedHome();
      const data = cached ?? await fetchHome({ refresh: isRefresh });
      if (request !== homeRequest.current) return;
      setHero(data.hero);
      setRows(data.rows.filter((row) => row.titles.length > 0));
      setCollections(data.collections ?? []);
      hasLoaded.current = true;
      setRefreshFailed(false);
      setState('ready');
    } catch {
      if (request !== homeRequest.current) return;
      setContinueEntries([]);
      setRefreshFailed(hasLoaded.current);
      setState(hasLoaded.current ? 'ready' : 'error');
    } finally {
      if (request === homeRequest.current) setRefreshing(false);
    }
  }, []);

  /** Genres are a secondary section — a failure just hides the chips. */
  const loadGenres = useCallback(async () => {
    const request = genreListRequest.current + 1;
    genreListRequest.current = request;
    try {
      const list = await listAllGenres();
      if (request === genreListRequest.current) setGenres(list);
    } catch {
      if (request === genreListRequest.current) setGenres([]);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void loadGenres();
    return () => {
      mounted.current = false;
      homeRequest.current++;
      genreRequest.current++;
      genreListRequest.current++;
    };
  }, [loadGenres]);

  useFocusEffect(useCallback(() => {
    void loadHome(false);
    return () => { homeRequest.current++; };
  }, [loadHome]));

  const onRefresh = useCallback(() => {
    void loadHome(true);
    void loadGenres();
  }, [loadHome, loadGenres]);

  /** Toggle a genre chip and swap the inline grid for its titles. */
  const onPressGenre = useCallback(
    async (genre: string, filters: TitleFilters = { genre }, collectionId = `genre:${genre}`, retry = false) => {
      if (collectionId === activeFilterId && !retry) {
        genreRequest.current += 1; // drop any in-flight load for the old chip
        setActiveGenre(null);
        setActiveFilterId(null);
        setGenreTitles([]);
        setGenreState('idle');
        return;
      }
      const id = ++genreRequest.current;
      filterScrollRequested.current = true;
      selectedFilters.current = filters;
      setActiveGenre(genre);
      setActiveFilterId(collectionId);
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
    [activeFilterId],
  );

  const hasContent = hero.length > 0 || rows.length > 0 || continueEntries.length > 0;

  const discoverySection = genres.length > 0 || collections.length > 0 || activeFilterId ? (
    <View style={styles.genreSection} onLayout={(event) => {
      filterTop.current = event.nativeEvent.layout.y;
      if (filterScrollRequested.current) {
        filterScrollRequested.current = false;
        scroll.current?.scrollTo({ y: filterTop.current, animated: false });
      }
    }}>
      <SectionTitle description="Follow a genre. Find a new story.">Explore</SectionTitle>
      {collections.length ? <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={[styles.collectionChips, { paddingHorizontal: layout.gutter }]}>
        {collections.map((item) => <FilterChip key={item.id} label={item.label} active={item.id === activeFilterId} accessibilityLabel={`Browse ${item.label}`} onPress={() => void onPressGenre(item.label, item.filters, item.id)} />)}
      </ScrollView> : null}
      {genres.length ? <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={[styles.collectionChips, { paddingHorizontal: layout.gutter }]}>
        {genres.slice(0, MAX_GENRES).filter((genre) => !collections.some((item) => item.filters.genre === genre)).map((genre) => <FilterChip key={genre} label={genre} active={`genre:${genre}` === activeFilterId} accessibilityLabel={`Browse ${genre}`} onPress={() => void onPressGenre(genre)} />)}
      </ScrollView> : null}
      {activeGenre && genreState !== 'idle' ? <SectionTitle description={genreState === 'ready' ? `${genreTitles.length} ${genreTitles.length === 1 ? 'title' : 'titles'}` : undefined} actionLabel="Clear filter" onAction={() => void onPressGenre(activeGenre, selectedFilters.current, activeFilterId ?? undefined)}>{activeGenre}</SectionTitle> : null}
      {genreState === 'loading' ? <Skeletons label={`Loading ${activeGenre}`} /> : null}
      {genreState === 'error' ? <EmptyState compact title="This collection didn't load" description="Check your connection, then try again." actionLabel="Try again" onAction={() => activeGenre && void onPressGenre(activeGenre, selectedFilters.current, activeFilterId ?? undefined, true)} /> : null}
      {genreState === 'ready' && !genreTitles.length ? <EmptyState compact title="No titles here right now" description="Explore another collection or genre." /> : null}
      {genreState === 'ready' && genreTitles.length > 0 ? <View style={[styles.grid, { paddingHorizontal: layout.gutter }]}>
        {genreTitles.map((title) => <MediaCard key={title.id} title={title} width={layout.cardWidth} onPress={() => openTitle(title)} />)}
      </View> : null}
    </View>
  ) : null;

  return (
    <Screen safeSides>
      <ScrollView
        ref={scroll}
        style={{ width: '100%', maxWidth: layout.width, alignSelf: 'center' }}
        contentContainerStyle={[styles.scroll, { paddingTop: insets.top + spacing(4), paddingBottom: spacing(10) + insets.bottom }]}
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
        <View style={[styles.header, { paddingHorizontal: layout.gutter }]}>
          <View style={styles.headerCopy}><Text style={styles.wordmark} accessibilityRole="header">Lumora</Text><Text style={styles.headerCaption}>A world of stories.</Text></View>
          <IconButton icon="search" label="Search films, series, and people" onPress={() => navigation.navigate('Search')} />
        </View>

        {state === 'loading' ? <Skeletons kind="home" label="Loading Lumora" /> : null}
        {state === 'ready' && refreshFailed ? <View style={[styles.notice, { marginHorizontal: layout.gutter }]}><Notice title="You're viewing the last loaded titles" description="We couldn't refresh. Check your connection and try again." actionLabel="Retry" onAction={() => void loadHome(true)} /></View> : null}

        {state === 'error' ? (
          <EmptyState title="Your next watch is a moment away" description="We couldn't connect. If you're offline, reconnect and try again." actionLabel="Try again" onAction={() => void loadHome(true)} />
        ) : null}

        {state === 'ready' && !hasContent ? (
          <EmptyState title="New stories are on their way" description="There are no titles to show right now. Try again in a little while." actionLabel="Refresh" onAction={() => void loadHome(true)} />
        ) : null}

        {state === 'ready' && hasContent ? (
          <>
            <Hero titles={hero} onPressTitle={openTitle} />
            {/* Only show this shelf when there's real account or guest history. */}
            {continueEntries.length > 0 ? (
              <Row
                heading="Continue watching"
                variant="landscape"
                titles={continueEntries.map((e) => e.title)}
                onPressTitle={(t) => {
                  const entry = continueEntries.find((e) => e.title.id === t.id);
                  if (entry) void playEntry(entry).catch(() => { if (mounted.current) setResumeFailed(true); });
                }}
                progressById={Object.fromEntries(continueEntries.map((e) => [e.title.id, e.progress]))}
                captionById={Object.fromEntries(continueEntries.map((entry) => [entry.title.id, entry.seasonNumber !== undefined && entry.episodeNumber !== undefined ? `Resume S${entry.seasonNumber} E${entry.episodeNumber}` : 'Continue watching']))}
              />
            ) : null}
            {resumeFailed ? <View style={[styles.notice, { marginHorizontal: layout.gutter }]}><Notice title="We couldn't open that title" description="Check your connection and try the title again." /></View> : null}
            <View style={styles.banner}><HomeAdMobBanner /></View>
            {discoverySection}
            {rows.map((row) => (
              <View key={row.id}>
                <Row
                  heading={row.heading}
                  reason={row.reason}
                  titles={row.titles}
                  onPressTitle={openTitle}
                  onPressAll={row.filters ? () => void onPressGenre(row.heading, row.filters, row.collectionId ?? row.id) : undefined}
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

const styles = StyleSheet.create({
  scroll: { flexGrow: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing(3), marginBottom: spacing(6) },
  headerCopy: { flex: 1, gap: spacing(1) },
  wordmark: { ...type.h1, fontSize: 28, lineHeight: 34, color: colors.primary },
  headerCaption: { ...type.small, color: colors.contentMuted },
  genreSection: { marginBottom: spacing(8) },
  collectionChips: { gap: spacing(2), paddingBottom: spacing(3) },
  notice: { marginBottom: spacing(6) },
  banner: { marginBottom: spacing(6) },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: BROWSE_GAP,
    rowGap: spacing(6),
  },
});
