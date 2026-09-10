import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Dimensions,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, radius, spacing, type } from '../theme';
import { Button, EmptyState, Loading, Screen, SectionTitle } from '../components/ui';
import { Hero } from '../components/Hero';
import { Row } from '../components/Row';
import { MediaCard } from '../components/MediaCard';
import { fetchHome, listAllGenres, listTitles } from '../lib/api';
import type { MediaRow, Title } from '../lib/types';
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

const { width } = Dimensions.get('window');
const COLUMN_GAP = spacing(3);
/** Three even columns regardless of device width. */
const CARD_WIDTH = Math.floor((width - spacing(4) * 2 - COLUMN_GAP * 2) / 3);
const MAX_GENRES = 18;

type LoadState = 'loading' | 'ready' | 'error';
type GenreState = 'idle' | 'loading' | 'ready' | 'error';

export default function HomeScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const insets = useSafeAreaInsets();

  const [state, setState] = useState<LoadState>('loading');
  const [hero, setHero] = useState<Title[]>([]);
  const [rows, setRows] = useState<MediaRow[]>([]);
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

  /** Fetch the full home payload. Errors become an explicit error state. */
  const loadHome = useCallback(async (isRefresh: boolean) => {
    if (isRefresh) setRefreshing(true);
    else setState('loading');
    try {
      const data = await fetchHome();
      setHero(data.hero);
      setRows(data.rows);
      setState('ready');
    } catch {
      setHero([]);
      setRows([]);
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

  const onRefresh = useCallback(() => {
    void loadHome(true);
    void loadGenres();
  }, [loadHome, loadGenres]);

  /** Toggle a genre chip and swap the inline grid for its titles. */
  const onPressGenre = useCallback(
    async (genre: string) => {
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
      try {
        const list = await listTitles({ genre, pageSize: 30 });
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

  return (
    <Screen>
      <ScrollView
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
            <Hero titles={hero} onPressTitle={openTitle} />
            {rows.map((row) => (
              <Row
                key={row.id}
                heading={row.heading}
                reason={row.reason}
                titles={row.titles}
                onPressTitle={openTitle}
              />
            ))}
          </>
        ) : null}

        {state === 'ready' && genres.length > 0 ? (
          <View style={styles.genreSection}>
            <SectionTitle>Browse by genre</SectionTitle>
            <View style={styles.chips}>
              {genres.slice(0, MAX_GENRES).map((genre) => (
                <Chip
                  key={genre}
                  label={genre}
                  active={genre === activeGenre}
                  onPress={() => void onPressGenre(genre)}
                />
              ))}
            </View>

            {genreState === 'loading' ? <InlineLoading label={`Loading ${activeGenre}…`} /> : null}

            {genreState === 'error' ? (
              <EmptyState title="Couldn’t load that genre" description="Please try again." />
            ) : null}

            {genreState === 'ready' && genreTitles.length === 0 ? (
              <EmptyState title="No titles in that genre" />
            ) : null}

            {genreState === 'ready' && genreTitles.length > 0 ? (
              <View style={styles.grid}>
                {genreTitles.map((title) => (
                  <MediaCard key={title.id} title={title} width={CARD_WIDTH} onPress={() => openTitle(title)} />
                ))}
              </View>
            ) : null}
          </View>
        ) : null}
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
    <View style={styles.inlineLoading}>
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
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing(2), paddingHorizontal: spacing(4) },
  chip: {
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
