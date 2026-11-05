import { useCallback, useEffect, useRef, useState } from 'react';
import {
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
import { EmptyState, FilterChip, IconButton, Screen, SectionTitle } from '../components/ui';
import { MediaCard } from '../components/MediaCard';
import { Artwork } from '../components/Artwork';
import { Icon } from '../components/Icon';
import { Skeletons } from '../components/Skeletons';
import { BROWSE_GAP, useBrowseLayout } from '../components/layout';
import { Pressable } from 'react-native';
import { listAllGenres, searchPeople } from '../lib/api';
import { listTitles, searchTitles } from '../lib/catalog-bridge';
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

const DEBOUNCE_MS = 250;
const MAX_GENRES = 12;

type SearchState = 'idle' | 'searching' | 'ready' | 'error';
type BrowseState = 'idle' | 'loading' | 'ready' | 'error';

export default function SearchScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const insets = useSafeAreaInsets();
  const layout = useBrowseLayout();

  const [query, setQuery] = useState('');
  const [state, setState] = useState<SearchState>('idle');
  const [titles, setTitles] = useState<Title[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [resultFilter, setResultFilter] = useState<'all' | 'movie' | 'tv' | 'people'>('all');
  const [fieldFocused, setFieldFocused] = useState(false);

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
      const [foundTitles, foundPeople] = await Promise.all([searchTitles(q), searchPeople(q).catch(() => [])]);
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
    searchRequest.current += 1;
    if (!q) {
      searchRequest.current += 1; // drop an in-flight search for the old query
      setState('idle');
      setTitles([]);
      setPeople([]);
      return;
    }
    setState('searching');
    setTitles([]);
    setPeople([]);
    const timer = setTimeout(() => void runSearch(q), DEBOUNCE_MS);
    return () => { clearTimeout(timer); searchRequest.current += 1; };
  }, [query, runSearch]);

  /** Toggle a genre chip and load its titles for browsing. */
  const onPressGenre = useCallback(
    async (genre: string, retry = false) => {
      if (genre === activeGenre && !retry) {
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
  const visibleTitles = resultFilter === 'people' ? [] : titles.filter((title) => resultFilter === 'all' || title.type === resultFilter);
  const visiblePeople = resultFilter === 'all' || resultFilter === 'people' ? people : [];
  const filterLabel = resultFilter === 'movie' ? 'Films' : resultFilter === 'tv' ? 'Series' : resultFilter === 'people' ? 'People' : 'Titles';

  return (
    <Screen safeSides>
      <View style={[styles.header, { paddingTop: insets.top + spacing(5), paddingHorizontal: layout.gutter, maxWidth: layout.width }]}>
        <Text style={styles.heading} accessibilityRole="header">
          Search
        </Text>
        <Text style={styles.headerCaption}>Find a film, a series, or the people behind it.</Text>
        <View style={[styles.field, fieldFocused && { borderColor: colors.primary }]}>
          <Icon name="search" color={colors.contentMuted} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Titles, actors, filmmakers"
            placeholderTextColor={colors.contentSubtle}
            style={styles.input}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            clearButtonMode="never"
            onFocus={() => setFieldFocused(true)}
            onBlur={() => setFieldFocused(false)}
            accessibilityRole="search"
            accessibilityLabel="Search titles and people"
          />
          {query.length > 0 ? (
            <IconButton icon="close" label="Clear search" onPress={() => setQuery('')} />
          ) : null}
        </View>
      </View>

      {isSearching ? <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.filters} contentContainerStyle={[styles.filterContent, { paddingHorizontal: layout.gutter }]}>
        {([{ id: 'all', label: 'All' }, { id: 'movie', label: 'Films' }, { id: 'tv', label: 'Series' }, { id: 'people', label: 'People' }] as const).map((filter) => <FilterChip key={filter.id} label={filter.label} active={resultFilter === filter.id} onPress={() => setResultFilter(filter.id)} accessibilityLabel={`Show ${filter.label.toLowerCase()} results`} />)}
      </ScrollView> : null}

      <ScrollView
        style={{ width: '100%', maxWidth: layout.width, alignSelf: 'center' }}
        contentContainerStyle={[styles.scroll, { paddingBottom: spacing(10) + insets.bottom }]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        showsVerticalScrollIndicator={false}
      >
        {isSearching && state === 'searching' ? <Skeletons label={`Searching for ${trimmed}`} /> : null}

        {isSearching && state === 'error' ? (
          <EmptyState icon="search" title="Search couldn't connect" description="If you're offline, reconnect and try again." actionLabel="Try again" onAction={() => void runSearch(trimmed)} />
        ) : null}

        {isSearching && state === 'ready' && !hasResults ? (
          <EmptyState
            icon="search"
            title={`No results for "${trimmed}"`}
            description="Try a different spelling, or clear the field to browse by genre."
          />
        ) : null}

        {isSearching && state === 'ready' && hasResults && !visibleTitles.length && !visiblePeople.length ? <EmptyState icon="search" title={`No ${filterLabel.toLowerCase()} found`} description="Try All results, or search for another name." actionLabel="Show all results" onAction={() => setResultFilter('all')} /> : null}

        {isSearching && state === 'ready' && (visibleTitles.length > 0 || visiblePeople.length > 0) ? <Text style={[styles.resultsCount, { paddingHorizontal: layout.gutter }]} accessibilityLiveRegion="polite">{visibleTitles.length > 0 ? `${visibleTitles.length} ${visibleTitles.length === 1 ? 'title' : 'titles'}` : ''}{visibleTitles.length > 0 && visiblePeople.length > 0 ? ' and ' : ''}{visiblePeople.length > 0 ? `${visiblePeople.length} ${visiblePeople.length === 1 ? 'person' : 'people'}` : ''}</Text> : null}

        {isSearching && state === 'ready' && visibleTitles.length > 0 ? (
          <View style={styles.block}>
            <SectionTitle>{filterLabel}</SectionTitle>
            <View style={[styles.grid, { paddingHorizontal: layout.gutter }]}>
              {visibleTitles.map((title) => (
                <MediaCard key={title.id} title={title} width={layout.cardWidth} onPress={() => openTitle(title)} />
              ))}
            </View>
          </View>
        ) : null}

        {isSearching && state === 'ready' && visiblePeople.length > 0 ? (
          <View style={styles.block}>
            <SectionTitle>People</SectionTitle>
            <View style={[styles.people, { paddingHorizontal: layout.gutter }]}>
              {visiblePeople.map((person) => (
                <PersonRow key={person.id} person={person} onPress={() => openPerson(person)} />
              ))}
            </View>
          </View>
        ) : null}

        {!isSearching && genres.length > 0 ? (
          <View style={styles.block}>
            <SectionTitle description="Or search for something you already have in mind.">Browse by genre</SectionTitle>
            <View style={[styles.chips, { paddingHorizontal: layout.gutter }]}>
              {genres.slice(0, MAX_GENRES).map((genre) => (
                <FilterChip
                  key={genre}
                  label={genre}
                  active={genre === activeGenre}
                  onPress={() => void onPressGenre(genre)}
                />
              ))}
            </View>
          </View>
        ) : null}

        {!isSearching && browseState === 'loading' ? <Skeletons label={`Loading ${activeGenre}`} /> : null}

        {!isSearching && browseState === 'error' ? (
          <EmptyState title="This genre didn't load" description="Check your connection and try again." actionLabel="Try again" onAction={() => activeGenre && void onPressGenre(activeGenre, true)} />
        ) : null}

        {!isSearching && browseState === 'ready' && browseTitles.length === 0 ? (
          <EmptyState title="No titles here right now" description="Try another genre, or search for a title." />
        ) : null}

        {!isSearching && browseState === 'ready' && browseTitles.length > 0 ? (
          <View style={styles.block}>
            <SectionTitle description={`${browseTitles.length} titles`} actionLabel="Clear filter" onAction={() => activeGenre && void onPressGenre(activeGenre)}>{activeGenre ?? 'Titles'}</SectionTitle>
            <View style={[styles.grid, { paddingHorizontal: layout.gutter }]}>
              {browseTitles.map((title) => (
                <MediaCard key={title.id} title={title} width={layout.cardWidth} onPress={() => openTitle(title)} />
              ))}
            </View>
          </View>
        ) : null}

        {!isSearching && browseState === 'idle' && genres.length === 0 ? (
          <EmptyState icon="search" title="Every story starts somewhere" description="Search for a film, a series, an actor, or a filmmaker." />
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
      <Artwork uri={person.profileUrl} label={person.name || initial} portrait style={styles.avatar} />
      <View style={styles.personText}>
        <Text style={styles.personName}>
          {person.name}
        </Text>
        {person.knownFor ? (
          <Text style={styles.personKnownFor}>
            Known for {person.knownFor}
          </Text>
        ) : null}
      </View>
      <Icon name="chevron-right" size={16} color={colors.contentMuted} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  header: { width: '100%', alignSelf: 'center', paddingBottom: spacing(4), gap: spacing(3) },
  heading: { ...type.h1, color: colors.content },
  headerCaption: { ...type.small, color: colors.contentMuted },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing(2),
    minHeight: 56,
    paddingHorizontal: spacing(3),
    paddingVertical: spacing(1),
    borderRadius: radius.md,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
  },
  input: { ...type.body, flex: 1, minWidth: 0, minHeight: 48, color: colors.content, paddingVertical: spacing(3) },
  filters: { flexGrow: 0, marginBottom: spacing(5), maxWidth: '100%' },
  filterContent: { gap: spacing(2) },
  resultsCount: { ...type.small, color: colors.contentMuted, marginBottom: spacing(5) },
  scroll: { flexGrow: 1, paddingTop: spacing(2) },
  block: { marginBottom: spacing(8) },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: BROWSE_GAP,
    rowGap: spacing(6),
  },
  people: { gap: spacing(3) },
  personRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing(3),
    minHeight: 88,
    padding: spacing(3),
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  avatar: { width: 52, height: 64, borderRadius: radius.sm },
  personText: { flex: 1, minWidth: 0 },
  personName: { ...type.body, color: colors.content, fontWeight: '600' },
  personKnownFor: { ...type.small, color: colors.contentMuted, marginTop: spacing(1) },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing(2) },
});
