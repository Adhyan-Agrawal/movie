import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Dimensions,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, radius, spacing, type } from '../theme';
import { EmptyState, Screen, SectionTitle } from '../components/ui';
import { MediaCard } from '../components/MediaCard';
import { listAllGenres, listTitles, searchPeople, searchTitles } from '../lib/api';
import type { Person, Title } from '../lib/types';
import type { RootStackParamList } from '../navigation';

/**
 * Search — title + people lookup with a debounced field.
 *
 * Every keystroke restarts a 250ms timer; the timer is cleared on change and on
 * unmount so no orphaned search fires. When it elapses we run `searchTitles`
 * and `searchPeople` together (Promise.all) and render a poster grid plus a
 * people list. Responses race on a slow connection, so each request carries a
 * monotonic id and only the newest one is allowed to write state — stale
 * results (including anything in flight at unmount) are dropped.
 *
 * With an empty query the screen offers genre chips instead; picking one
 * browses that genre via `listTitles({ genre })`. No query and no selection
 * means no results are shown — nothing is fabricated.
 */

const { width } = Dimensions.get('window');
const COLUMN_GAP = spacing(3);
/** Three even columns regardless of device width. */
const CARD_WIDTH = Math.floor((width - spacing(4) * 2 - COLUMN_GAP * 2) / 3);
const DEBOUNCE_MS = 250;
const MAX_GENRES = 12;

type SearchState = 'idle' | 'searching' | 'ready' | 'error';
type BrowseState = 'idle' | 'loading' | 'ready' | 'error';

export default function SearchScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const insets = useSafeAreaInsets();

  const [query, setQuery] = useState('');
  const [state, setState] = useState<SearchState>('idle');
  const [titles, setTitles] = useState<Title[]>([]);
  const [people, setPeople] = useState<Person[]>([]);

  const [genres, setGenres] = useState<string[]>([]);
  const [activeGenre, setActiveGenre] = useState<string | null>(null);
  const [browseTitles, setBrowseTitles] = useState<Title[]>([]);
  const [browseState, setBrowseState] = useState<BrowseState>('idle');

  /** Monotonic ids — only the newest request of each kind may write state. */
  const searchRequest = useRef(0);
  const browseRequest = useRef(0);

  const openTitle = useCallback(
    (title: Title) => navigation.navigate('Title', { type: title.type, slug: title.slug }),
    [navigation],
  );
  const openPerson = useCallback(
    (person: Person) => navigation.navigate('Person', { id: person.id }),
    [navigation],
  );

  /** Genre chips are secondary — a failure simply hides them. */
  useEffect(() => {
    let alive = true;
    listAllGenres()
      .then((list) => {
        if (alive) setGenres(list);
      })
      .catch(() => {
        if (alive) setGenres([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  /** Invalidate anything in flight when the screen goes away. */
  useEffect(
    () => () => {
      searchRequest.current += 1;
      browseRequest.current += 1;
    },
    [],
  );

  const runSearch = useCallback(async (q: string) => {
    const id = ++searchRequest.current;
    setState('searching');
    try {
      const [foundTitles, foundPeople] = await Promise.all([searchTitles(q), searchPeople(q)]);
      if (id !== searchRequest.current) return; // a newer query already won
      setTitles(foundTitles);
      setPeople(foundPeople);
      setState('ready');
    } catch {
      if (id !== searchRequest.current) return;
      setTitles([]);
      setPeople([]);
      setState('error');
    }
  }, []);

  // Debounced search. The cleanup clears the pending timer on every keystroke
  // and on unmount, so typing never leaves a stray request behind.
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      searchRequest.current += 1; // drop an in-flight search for the old query
      setState('idle');
      setTitles([]);
      setPeople([]);
      return;
    }
    const timer = setTimeout(() => void runSearch(q), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, runSearch]);

  /** Toggle a genre chip and load its titles for browsing. */
  const onPressGenre = useCallback(
    async (genre: string) => {
      if (genre === activeGenre) {
        browseRequest.current += 1;
        setActiveGenre(null);
        setBrowseTitles([]);
        setBrowseState('idle');
        return;
      }
      const id = ++browseRequest.current;
      setActiveGenre(genre);
      setBrowseTitles([]);
      setBrowseState('loading');
      try {
        const list = await listTitles({ genre, pageSize: 30 });
        if (id !== browseRequest.current) return;
        setBrowseTitles(list);
        setBrowseState('ready');
      } catch {
        if (id !== browseRequest.current) return;
        setBrowseState('error');
      }
    },
    [activeGenre],
  );

  const trimmed = query.trim();
  const isSearching = trimmed.length > 0;
  const hasResults = titles.length > 0 || people.length > 0;

  return (
    <Screen>
      <View style={[styles.header, { paddingTop: insets.top + spacing(4) }]}>
        <Text style={styles.heading} accessibilityRole="header">
          Search
        </Text>
        <View style={styles.field}>
          <Text style={styles.fieldGlyph}>⌕</Text>
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search titles, people…"
            placeholderTextColor={colors.contentSubtle}
            style={styles.input}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            clearButtonMode="while-editing"
            accessibilityRole="search"
            accessibilityLabel="Search titles and people"
          />
          {query.length > 0 ? (
            <Pressable
              onPress={() => setQuery('')}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel="Clear search"
              style={({ pressed }) => [styles.clear, { opacity: pressed ? 0.7 : 1 }]}
            >
              <Text style={styles.clearGlyph}>✕</Text>
            </Pressable>
          ) : null}
        </View>
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        showsVerticalScrollIndicator={false}
      >
        {isSearching && state === 'searching' ? <InlineLoading label={`Searching for “${trimmed}”…`} /> : null}

        {isSearching && state === 'error' ? (
          <EmptyState title="Search failed" description="Check your connection and try again." />
        ) : null}

        {isSearching && state === 'ready' && !hasResults ? (
          <EmptyState
            title={`No results for “${trimmed}”`}
            description="Try a different spelling, or clear the field to browse by genre."
          />
        ) : null}

        {isSearching && state === 'ready' && titles.length > 0 ? (
          <View style={styles.block}>
            <SectionTitle>Titles</SectionTitle>
            <View style={styles.grid}>
              {titles.map((title) => (
                <MediaCard key={title.id} title={title} width={CARD_WIDTH} onPress={() => openTitle(title)} />
              ))}
            </View>
          </View>
        ) : null}

        {isSearching && state === 'ready' && people.length > 0 ? (
          <View style={styles.block}>
            <SectionTitle>People</SectionTitle>
            <View style={styles.people}>
              {people.map((person) => (
                <PersonRow key={person.id} person={person} onPress={() => openPerson(person)} />
              ))}
            </View>
          </View>
        ) : null}

        {!isSearching && genres.length > 0 ? (
          <View style={styles.block}>
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
          </View>
        ) : null}

        {!isSearching && browseState === 'loading' ? <InlineLoading label={`Loading ${activeGenre}…`} /> : null}

        {!isSearching && browseState === 'error' ? (
          <EmptyState title="Couldn’t load that genre" description="Please try again." />
        ) : null}

        {!isSearching && browseState === 'ready' && browseTitles.length === 0 ? (
          <EmptyState title="No titles in that genre" />
        ) : null}

        {!isSearching && browseState === 'ready' && browseTitles.length > 0 ? (
          <View style={styles.block}>
            <SectionTitle>{activeGenre ?? 'Titles'}</SectionTitle>
            <View style={styles.grid}>
              {browseTitles.map((title) => (
                <MediaCard key={title.id} title={title} width={CARD_WIDTH} onPress={() => openTitle(title)} />
              ))}
            </View>
          </View>
        ) : null}

        {!isSearching && browseState === 'idle' && genres.length === 0 ? (
          <EmptyState title="Search Lumora" description="Find a film or series by name, or search for a person." />
        ) : null}
      </ScrollView>
    </Screen>
  );
}

/** Round-avatar people result — taps through to the person's credits. */
function PersonRow({ person, onPress }: { person: Person; onPress: () => void }) {
  const initial = person.name.slice(0, 1).toUpperCase() || '?';
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={person.knownFor ? `${person.name}, known for ${person.knownFor}` : person.name}
      style={({ pressed }) => [styles.personRow, { opacity: pressed ? 0.85 : 1 }]}
    >
      {person.profileUrl ? (
        <Image source={{ uri: person.profileUrl }} style={styles.avatar} resizeMode="cover" />
      ) : (
        <View style={[styles.avatar, styles.avatarFallback]}>
          <Text style={styles.avatarInitial}>{initial}</Text>
        </View>
      )}
      <View style={styles.personText}>
        <Text style={styles.personName} numberOfLines={1}>
          {person.name}
        </Text>
        {person.knownFor ? (
          <Text style={styles.personKnownFor} numberOfLines={1}>
            Known for {person.knownFor}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

/** Genre filter chip — toggles the browse grid below the chips. */
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
  header: { paddingHorizontal: spacing(4), paddingBottom: spacing(3), gap: spacing(3) },
  heading: { ...type.h1, color: colors.content },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing(2),
    height: 46,
    paddingHorizontal: spacing(3),
    borderRadius: radius.md,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
  },
  fieldGlyph: { ...type.h3, color: colors.contentSubtle },
  input: { ...type.body, flex: 1, color: colors.content, paddingVertical: 0, height: '100%' },
  clear: { paddingHorizontal: spacing(1) },
  clearGlyph: { ...type.body, color: colors.contentSubtle },
  scroll: { flexGrow: 1, paddingBottom: spacing(8) },
  block: { marginBottom: spacing(5) },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: COLUMN_GAP,
    paddingHorizontal: spacing(4),
    marginTop: spacing(2),
  },
  people: { paddingHorizontal: spacing(4), gap: spacing(2) },
  personRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing(3),
    padding: spacing(2),
    borderRadius: radius.md,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
  },
  avatar: { width: 46, height: 46, borderRadius: radius.pill, backgroundColor: colors.surfaceOverlay },
  avatarFallback: { alignItems: 'center', justifyContent: 'center' },
  avatarInitial: { ...type.h3, color: colors.contentMuted },
  personText: { flex: 1 },
  personName: { ...type.body, color: colors.content, fontWeight: '600' },
  personKnownFor: { ...type.tiny, color: colors.contentSubtle, marginTop: 2 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing(2), paddingHorizontal: spacing(4), marginTop: spacing(2) },
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
  inlineLoading: { flexDirection: 'row', alignItems: 'center', gap: spacing(2), padding: spacing(4) },
  inlineLoadingLabel: { ...type.small, color: colors.contentMuted },
});
