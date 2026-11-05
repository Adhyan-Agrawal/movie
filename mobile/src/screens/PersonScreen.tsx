import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { colors, radius, spacing, type } from '../theme';
import { EmptyState, Notice, Screen, SectionTitle } from '../components/ui';
import { MediaCard } from '../components/MediaCard';
import { Artwork } from '../components/Artwork';
import { Skeletons } from '../components/Skeletons';
import { BROWSE_GAP, useBrowseLayout } from '../components/layout';
import { getPerson, getPersonCredits } from '../lib/api';
import type { Person, Title } from '../lib/types';
import type { RootStackParamList } from '../navigation';

/**
 * Person page: portrait, "Known for", and the filmography pulled from
 * `title_people` credits — split into Cast and Crew shelves so a job like
 * "Director" reads differently from a role. Each credit opens its title.
 */

/** A single credit row as returned by getPersonCredits. */
type Credit = { title: Title; creditType: string; character: string | null; job?: string | null };

/** Collapse repeat credits for the same title (e.g. director + writer). */
function dedupeByTitle(credits: Credit[]): Credit[] {
  const seen = new Set<string>();
  const out: Credit[] = [];
  for (const credit of credits) {
    if (seen.has(credit.title.id)) continue;
    seen.add(credit.title.id);
    out.push(credit);
  }
  return out;
}

/** The line under a poster: the role, else the crew job. */
function creditCaption(credit: Credit): string | undefined {
  if (credit.character) return credit.character;
  if (credit.job) return credit.job;
  if (credit.creditType && credit.creditType !== 'cast') return credit.creditType;
  return undefined;
}

export default function PersonScreen() {
  const route = useRoute<RouteProp<RootStackParamList, 'Person'>>();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { id } = route.params;
  const layout = useBrowseLayout();
  const insets = useSafeAreaInsets();

  const [person, setPerson] = useState<Person | null>(null);
  const [credits, setCredits] = useState<Credit[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setNotFound(false);
    setLoadFailed(false);
    setPerson(null);
    setCredits([]);

    (async () => {
      try {
        const found = await getPerson(id);
        if (!active) return;
        if (!found) {
          setNotFound(true);
          return;
        }
        setPerson(found);
        const filmography = await getPersonCredits(id);
        if (active) setCredits(filmography);
      } catch {
        if (active) setLoadFailed(true);
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [id, reload]);

  function openTitle(title: Title) {
    navigation.navigate('Title', { type: title.type, slug: title.slug });
  }

  function renderGrid(items: Credit[]) {
    return (
      <View style={[styles.grid, { paddingHorizontal: layout.gutter }]}>
        {items.map((credit) => {
          const caption = creditCaption(credit);
          return (
            <View key={`${credit.title.id}:${credit.creditType}`} style={{ width: layout.cardWidth }}>
              <MediaCard title={credit.title} width={layout.cardWidth} onPress={() => openTitle(credit.title)} />
              {caption ? (
                <Text style={styles.caption} numberOfLines={layout.largeText ? undefined : 2}>
                  {caption}
                </Text>
              ) : null}
            </View>
          );
        })}
      </View>
    );
  }

  if (loading) {
    return (
      <Screen safeSides>
        <ScrollView style={{ width: '100%', maxWidth: layout.width, alignSelf: 'center' }}><Skeletons kind="person" label="Loading person" /></ScrollView>
      </Screen>
    );
  }

  if (loadFailed && !person) return <Screen safeSides><EmptyState title="This person didn't load" description="If you're offline, reconnect and try again." actionLabel="Try again" onAction={() => setReload((value) => value + 1)} /></Screen>;

  if (notFound || !person) {
    return (
      <Screen safeSides>
        <EmptyState title="Person not found" description="We couldn’t find this person in the catalog." />
      </Screen>
    );
  }

  const castCredits = dedupeByTitle(credits.filter((c) => c.creditType === 'cast'));
  const crewCredits = dedupeByTitle(credits.filter((c) => c.creditType !== 'cast'));

  return (
    <Screen safeSides>
      <ScrollView style={{ width: '100%', maxWidth: layout.width, alignSelf: 'center' }} contentContainerStyle={[styles.content, { paddingBottom: spacing(10) + insets.bottom }]} showsVerticalScrollIndicator={false}>
        <View style={[styles.profile, { marginHorizontal: layout.gutter }, layout.largeText && styles.largeTextProfile]}>
          <Artwork uri={person.profileUrl} label={person.name} portrait style={[styles.photo, layout.wide && styles.widePhoto]} />
          <View style={[styles.profileCopy, layout.largeText && styles.largeTextCopy]}><Text style={styles.eyebrow}>PEOPLE</Text><Text accessibilityRole="header" style={styles.name}>{person.name}</Text>
            {person.knownFor ? <Text style={styles.knownFor}>{`Known for ${person.knownFor}`}</Text> : null}
            {credits.length ? <Text style={styles.creditCount}>{new Set(credits.map((credit) => credit.title.id)).size} titles in the collection</Text> : null}
          </View>
        </View>

        {loadFailed ? <View style={{ marginHorizontal: layout.gutter, marginBottom: spacing(8) }}><Notice title="Their credits didn't load" description="Check your connection, then try again." actionLabel="Retry" onAction={() => setReload((value) => value + 1)} /></View> : null}

        {castCredits.length ? (
          <View style={styles.section}>
            <SectionTitle description={`${castCredits.length} ${castCredits.length === 1 ? 'title' : 'titles'}`}>On screen</SectionTitle>
            {renderGrid(castCredits)}
          </View>
        ) : null}

        {crewCredits.length ? (
          <View style={styles.section}>
            <SectionTitle description={`${crewCredits.length} ${crewCredits.length === 1 ? 'title' : 'titles'}`}>Behind the camera</SectionTitle>
            {renderGrid(crewCredits)}
          </View>
        ) : null}

        {!loadFailed && !castCredits.length && !crewCredits.length ? (
          <EmptyState title="More stories to discover" description="Credits aren't available for this person yet." />
        ) : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingTop: spacing(6), paddingBottom: spacing(10) },
  profile: { flexDirection: 'row', alignItems: 'center', gap: spacing(5), padding: spacing(5), backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, marginBottom: spacing(10) },
  largeTextProfile: { flexDirection: 'column', alignItems: 'flex-start' },
  profileCopy: { flex: 1, minWidth: 0, gap: spacing(3) },
  largeTextCopy: { flex: 0, width: '100%' },
  photo: {
    width: 104,
    height: 144,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
  },
  widePhoto: { width: 168, height: 224 },
  eyebrow: { ...type.tiny, fontWeight: '700', letterSpacing: 1.6, color: colors.contentMuted },
  name: { ...type.h1, color: colors.content },
  knownFor: { ...type.small, color: colors.contentMuted },
  creditCount: { ...type.tiny, color: colors.contentMuted },
  section: { marginBottom: spacing(10) },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: BROWSE_GAP,
    rowGap: spacing(7),
  },
  caption: { ...type.tiny, color: colors.contentMuted, marginTop: spacing(1) },
});
