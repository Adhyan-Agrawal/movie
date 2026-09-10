import { useEffect, useState } from 'react';
import { Image, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { colors, radius, spacing, type } from '../theme';
import { EmptyState, Loading, Screen, SectionTitle } from '../components/ui';
import { MediaCard } from '../components/MediaCard';
import { getPerson, getPersonCredits } from '../lib/api';
import type { Person, Title } from '../lib/types';
import type { RootStackParamList } from '../navigation';

/**
 * Person page: portrait, "Known for", and the filmography pulled from
 * `title_people` credits — split into Cast and Crew shelves so a job like
 * "Director" reads differently from a role. Each credit opens its title.
 */

/** A single credit row as returned by getPersonCredits. */
type Credit = { title: Title; creditType: string; character: string | null };

/** Poster grid width — three columns on a typical phone. */
const CARD_WIDTH = 104;

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
  if (credit.creditType && credit.creditType !== 'cast') return credit.creditType;
  return undefined;
}

export default function PersonScreen() {
  const route = useRoute<RouteProp<RootStackParamList, 'Person'>>();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { id } = route.params;

  const [person, setPerson] = useState<Person | null>(null);
  const [credits, setCredits] = useState<Credit[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setNotFound(false);
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
        if (active) setNotFound(true);
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [id]);

  function openTitle(title: Title) {
    navigation.navigate('Title', { type: title.type, slug: title.slug });
  }

  function renderGrid(items: Credit[]) {
    return (
      <View style={styles.grid}>
        {items.map((credit) => {
          const caption = creditCaption(credit);
          return (
            <View key={`${credit.title.id}:${credit.creditType}`} style={styles.cell}>
              <MediaCard title={credit.title} width={CARD_WIDTH} onPress={() => openTitle(credit.title)} />
              {caption ? (
                <Text style={styles.caption} numberOfLines={2}>
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
      <Screen>
        <Loading label="Loading person…" />
      </Screen>
    );
  }

  if (notFound || !person) {
    return (
      <Screen>
        <EmptyState title="Person not found" description="We couldn’t find this person in the catalog." />
      </Screen>
    );
  }

  const castCredits = dedupeByTitle(credits.filter((c) => c.creditType === 'cast'));
  const crewCredits = dedupeByTitle(credits.filter((c) => c.creditType !== 'cast'));

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.profile}>
          {person.profileUrl ? (
            <Image source={{ uri: person.profileUrl }} style={styles.photo} resizeMode="cover" />
          ) : (
            <View style={[styles.photo, styles.photoFallback]}>
              <Text style={styles.initial}>{person.name.charAt(0)}</Text>
            </View>
          )}
          <Text style={styles.name}>{person.name}</Text>
          {person.knownFor ? (
            <Text style={styles.knownFor}>{`Known for ${person.knownFor}`}</Text>
          ) : null}
        </View>

        {castCredits.length ? (
          <View style={styles.section}>
            <SectionTitle>Cast</SectionTitle>
            {renderGrid(castCredits)}
          </View>
        ) : null}

        {crewCredits.length ? (
          <View style={styles.section}>
            <SectionTitle>Crew</SectionTitle>
            {renderGrid(crewCredits)}
          </View>
        ) : null}

        {!castCredits.length && !crewCredits.length ? (
          <Text style={styles.muted}>No credits are available for this person yet.</Text>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: spacing(10) },
  profile: { alignItems: 'center', gap: spacing(2), paddingHorizontal: spacing(4), paddingVertical: spacing(6) },
  photo: {
    width: 120,
    height: 120,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
  },
  photoFallback: { alignItems: 'center', justifyContent: 'center' },
  initial: { ...type.h1, color: colors.contentSubtle },
  name: { ...type.h1, color: colors.content, textAlign: 'center' },
  knownFor: { ...type.small, color: colors.contentMuted, textAlign: 'center' },
  section: { marginTop: spacing(6) },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing(4),
    paddingHorizontal: spacing(4),
  },
  cell: { width: CARD_WIDTH },
  caption: { ...type.tiny, color: colors.contentSubtle, marginTop: 2 },
  muted: { ...type.body, color: colors.contentSubtle, paddingHorizontal: spacing(4) },
});
