import { useCallback, useEffect, useMemo, useState } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { colors, radius, spacing, type } from '../theme';
import { Button, EmptyState, Loading, MetaLine, Screen, SectionTitle } from '../components/ui';
import {
  currentUser,
  fetchContinueWatching,
  getMyRating,
  getResumePosition,
  getTitleBySlug,
  isInWatchlist,
  listCast,
  listSeasons,
  setRating,
  toggleWatchlist,
} from '../lib/api';
import type { CastMember, Season, Title } from '../lib/types';
import type { RootStackParamList } from '../navigation';

/**
 * Title detail (native twin of the web TitleDetail, Spec Section 4): backdrop
 * hero with a legibility scrim, poster + metadata, synopsis, play/resume and
 * watchlist/rating controls, the season+c episode list for series, and a cast
 * shelf that links through to each person page.
 */

const STARS = [1, 2, 3, 4, 5];

/** Format runtime minutes as "2h 8m" / "2h" / "52m" — matches the web helper. */
function formatRuntime(minutes?: number | null): string | undefined {
  if (!minutes || minutes <= 0) return undefined;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

/** "Mar 4, 2019" from an ISO air date; undefined when unknown/unparseable. */
function formatAirDate(iso: string | null): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Where the Play button should drop the viewer (series carry the episode). */
type PlayerExtra = { season?: number; episode?: number; episodeId?: string; episodeName?: string };

interface ResumeInfo extends PlayerExtra {
  label: string;
}

export default function TitleScreen() {
  const route = useRoute<RouteProp<RootStackParamList, 'Title'>>();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { type: titleType, slug } = route.params;

  const [title, setTitle] = useState<Title | null>(null);
  const [seasons, setSeasons] = useState<Season[]>([]);
  const [cast, setCast] = useState<CastMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [inList, setInList] = useState(false);
  const [listBusy, setListBusy] = useState(false);
  const [myRating, setMyRating] = useState<number | null>(null);
  const [ratingBusy, setRatingBusy] = useState(false);
  const [resume, setResume] = useState<ResumeInfo | null>(null);
  const [selectedSeason, setSelectedSeason] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setNotFound(false);
    setTitle(null);
    setSeasons([]);
    setCast([]);
    setInList(false);
    setMyRating(null);
    setResume(null);
    setSelectedSeason(null);

    (async () => {
      try {
        const found = await getTitleBySlug(titleType, slug);
        if (!active) return;
        if (!found) {
          setNotFound(true);
          return;
        }
        setTitle(found);

        const [seasonList, castList, listed, rating, continueEntries] = await Promise.all([
          found.type === 'tv' ? listSeasons(found.id) : Promise.resolve<Season[]>([]),
          listCast(found.id),
          isInWatchlist(found.id),
          getMyRating(found.id),
          fetchContinueWatching(50),
        ]);
        if (!active) return;

        setSeasons(seasonList);
        setCast(castList);
        setInList(listed);
        setMyRating(rating);
        if (seasonList.length) setSelectedSeason(seasonList[0].seasonNumber);

        // Resume CTA: a series deep-links to the LAST episode the viewer was
        // watching (episode id from continue-watching, position confirmed via
        // getResumePosition); a movie resumes at its title-level position.
        const entry = continueEntries.find((e) => e.title.id === found.id);
        if (found.type === 'tv' && entry?.episodeId) {
          const episode = seasonList
            .flatMap((s) => s.episodes)
            .find((e) => e.id === entry.episodeId);
          if (episode) {
            const position = await getResumePosition(found.id, episode.id);
            if (active && position) {
              setResume({
                season: episode.seasonNumber,
                episode: episode.episodeNumber,
                episodeId: episode.id,
                episodeName: episode.name,
                label: `Resume S${episode.seasonNumber} E${episode.episodeNumber}`,
              });
            }
          }
        } else if (found.type === 'movie') {
          const position = await getResumePosition(found.id);
          if (active && position) setResume({ label: 'Resume' });
        }
      } catch {
        if (active) setNotFound(true);
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [titleType, slug]);

  const goToPlayer = useCallback(
    (extra: PlayerExtra = {}) => {
      if (!title) return;
      const params: RootStackParamList['Player'] = {
        titleId: title.id,
        type: title.type,
        slug: title.slug,
        name: title.name,
      };
      if (title.tmdbId) params.tmdbId = title.tmdbId;
      if (title.imdbId) params.imdbId = title.imdbId;
      if (extra.season !== undefined) params.season = extra.season;
      if (extra.episode !== undefined) params.episode = extra.episode;
      if (extra.episodeId) params.episodeId = extra.episodeId;
      if (extra.episodeName) params.episodeName = extra.episodeName;
      navigation.navigate('Player', params);
    },
    [navigation, title],
  );

  const activeSeason = useMemo(() => {
    if (!seasons.length) return null;
    return seasons.find((s) => s.seasonNumber === selectedSeason) ?? seasons[0];
  }, [seasons, selectedSeason]);

  async function onToggleWatchlist() {
    if (!title || listBusy) return;
    const user = await currentUser();
    if (!user) {
      navigation.navigate('Auth');
      return;
    }
    const next = !inList;
    setInList(next); // optimistic
    setListBusy(true);
    try {
      const result = await toggleWatchlist(title.id);
      if (!result.ok) setInList(!next); // rollback
      else if (typeof result.added === 'boolean') setInList(result.added);
    } catch {
      setInList(!next);
    } finally {
      setListBusy(false);
    }
  }

  async function onRate(value: number) {
    if (!title || ratingBusy) return;
    const user = await currentUser();
    if (!user) {
      navigation.navigate('Auth');
      return;
    }
    const previous = myRating;
    setMyRating(value); // optimistic
    setRatingBusy(true);
    try {
      const result = await setRating(title.id, value);
      if (!result.ok) setMyRating(previous);
    } catch {
      setMyRating(previous);
    } finally {
      setRatingBusy(false);
    }
  }

  if (loading) {
    return (
      <Screen>
        <Loading label="Loading title…" />
      </Screen>
    );
  }

  if (notFound || !title) {
    return (
      <Screen>
        <EmptyState
          title="Title not found"
          description="This title isn’t in the catalog (or may have been removed)."
        />
      </Screen>
    );
  }

  const isSeries = title.type === 'tv';
  const primaryLabel = resume ? resume.label : 'Play';
  const filledStars = myRating != null ? Math.round(myRating / 2) : 0;

  function onPrimaryPress() {
    if (!title) return;
    if (isSeries) {
      if (resume) {
        goToPlayer({
          season: resume.season,
          episode: resume.episode,
          episodeId: resume.episodeId,
          episodeName: resume.episodeName,
        });
      } else {
        goToPlayer({ season: 1, episode: 1 });
      }
      return;
    }
    goToPlayer();
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {/* Backdrop hero band with legibility scrims. */}
        <View style={styles.hero}>
          {title.backdropUrl ? (
            <Image source={{ uri: title.backdropUrl }} style={styles.heroArt} resizeMode="cover" />
          ) : null}
          <View style={styles.overlay} />
          <View style={styles.bandTall} />
          <View style={styles.bandShort} />
        </View>

        {/* Poster + primary metadata. */}
        <View style={styles.headerRow}>
          <View style={styles.posterWrap}>
            {title.posterUrl ? (
              <Image source={{ uri: title.posterUrl }} style={styles.poster} resizeMode="cover" />
            ) : (
              <View style={[styles.poster, styles.posterFallback]}>
                <Text style={styles.posterFallbackText} numberOfLines={3}>
                  {title.name}
                </Text>
              </View>
            )}
          </View>
          <View style={styles.headerInfo}>
            <Text style={styles.name}>{title.name}</Text>
            {title.originalName && title.originalName !== title.name ? (
              <Text style={styles.originalName}>{title.originalName}</Text>
            ) : null}
            <MetaLine
              parts={[
                title.releaseYear ? String(title.releaseYear) : undefined,
                formatRuntime(title.runtimeMinutes),
                title.maturity,
                typeof title.score === 'number' ? `${title.score}%` : undefined,
                title.genres.join(', ') || undefined,
              ]}
            />
          </View>
        </View>

        {/* Primary actions: Play/Resume + Watchlist. */}
        <View style={styles.actions}>
          <Button label={primaryLabel} size="lg" onPress={onPrimaryPress} style={styles.playButton} />
          <Button
            label={inList ? '✓ In My List' : '+ My List'}
            variant="secondary"
            size="lg"
            loading={listBusy}
            onPress={onToggleWatchlist}
            style={styles.listButton}
          />
        </View>

        {/* Viewer rating: 5 stars, each worth 2 points on the 1–10 scale. */}
        <View style={styles.ratingRow}>
          <Text style={styles.ratingValue}>
            {myRating != null ? `Your rating: ${myRating}/10` : 'Rate this title'}
          </Text>
          <View style={styles.stars}>
            {STARS.map((star) => {
              const value = star * 2;
              return (
                <Pressable
                  key={star}
                  onPress={() => onRate(value)}
                  disabled={ratingBusy}
                  hitSlop={6}
                  accessibilityRole="button"
                  accessibilityLabel={`Rate ${value} out of 10`}
                  accessibilityState={{ selected: myRating === value, disabled: ratingBusy }}
                  style={({ pressed }) => [styles.star, { opacity: pressed ? 0.7 : 1 }]}
                >
                  <Text
                    style={[styles.starGlyph, star <= filledStars ? styles.starOn : styles.starOff]}
                  >
                    ★
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        {title.synopsis ? <Text style={styles.synopsis}>{title.synopsis}</Text> : null}

        {/* Series: season chips + episode list. */}
        {isSeries ? (
          <View style={styles.section}>
            <SectionTitle>Episodes</SectionTitle>
            {seasons.length ? (
              <>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.chipList}
                >
                  {seasons.map((season) => {
                    const selected = activeSeason?.seasonNumber === season.seasonNumber;
                    return (
                      <Pressable
                        key={season.id}
                        onPress={() => setSelectedSeason(season.seasonNumber)}
                        accessibilityRole="button"
                        accessibilityLabel={`Season ${season.seasonNumber}`}
                        accessibilityState={{ selected }}
                        style={({ pressed }) => [
                          styles.chip,
                          selected && styles.chipSelected,
                          { opacity: pressed ? 0.85 : 1 },
                        ]}
                      >
                        <Text style={[styles.chipLabel, selected && styles.chipLabelSelected]}>
                          {season.name ?? `Season ${season.seasonNumber}`}
                        </Text>
                      </Pressable>
                    );
                  })}
                </ScrollView>

                <View style={styles.episodeList}>
                  {activeSeason?.episodes.length ? (
                    activeSeason.episodes.map((episode) => (
                      <View key={episode.id} style={styles.episodeRow}>
                        <View style={styles.still}>
                          {episode.stillUrl ? (
                            <Image
                              source={{ uri: episode.stillUrl }}
                              style={styles.stillArt}
                              resizeMode="cover"
                            />
                          ) : null}
                        </View>
                        <View style={styles.episodeBody}>
                          <Text style={styles.episodeName} numberOfLines={1}>
                            {`E${episode.episodeNumber} · ${episode.name}`}
                          </Text>
                          <MetaLine
                            parts={[
                              formatRuntime(episode.runtimeMinutes),
                              formatAirDate(episode.airDate),
                            ]}
                          />
                          {episode.overview ? (
                            <Text style={styles.episodeOverview} numberOfLines={3}>
                              {episode.overview}
                            </Text>
                          ) : null}
                        </View>
                        <Button
                          label="Play"
                          variant="secondary"
                          size="sm"
                          onPress={() =>
                            goToPlayer({
                              season: episode.seasonNumber,
                              episode: episode.episodeNumber,
                              episodeId: episode.id,
                              episodeName: episode.name,
                            })
                          }
                        />
                      </View>
                    ))
                  ) : (
                    <Text style={styles.muted}>Episode details aren’t available for this season yet.</Text>
                  )}
                </View>
              </>
            ) : (
              <Text style={styles.muted}>Episode details aren’t available for this title yet.</Text>
            )}
          </View>
        ) : null}

        {/* Cast shelf — each card links to the person page. */}
        <View style={styles.section}>
          <SectionTitle>Cast</SectionTitle>
          {cast.length ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.castList}
            >
              {cast.map((member) => (
                <Pressable
                  key={member.personId}
                  onPress={() => navigation.navigate('Person', { id: member.personId })}
                  accessibilityRole="button"
                  accessibilityLabel={`${member.name}${member.character ? `, ${member.character}` : ''}`}
                  style={({ pressed }) => [styles.castCard, { opacity: pressed ? 0.85 : 1 }]}
                >
                  {member.profileUrl ? (
                    <Image source={{ uri: member.profileUrl }} style={styles.castPhoto} resizeMode="cover" />
                  ) : (
                    <View style={[styles.castPhoto, styles.castPhotoFallback]}>
                      <Text style={styles.castInitial}>{member.name.charAt(0)}</Text>
                    </View>
                  )}
                  <Text style={styles.castName} numberOfLines={2}>
                    {member.name}
                  </Text>
                  {member.character ? (
                    <Text style={styles.castCharacter} numberOfLines={2}>
                      {member.character}
                    </Text>
                  ) : null}
                </Pressable>
              ))}
            </ScrollView>
          ) : (
            <Text style={styles.muted}>Cast information isn’t available for this title yet.</Text>
          )}
        </View>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: spacing(10) },
  hero: { height: 200, backgroundColor: colors.surfaceRaised },
  heroArt: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(8,9,12,0.45)',
  },
  bandTall: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 96,
    backgroundColor: 'rgba(8,9,12,0.6)',
  },
  bandShort: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 44,
    backgroundColor: 'rgba(8,9,12,0.85)',
  },
  headerRow: {
    flexDirection: 'row',
    gap: spacing(4),
    paddingHorizontal: spacing(4),
    marginTop: -spacing(14),
  },
  posterWrap: {
    width: 116,
    height: 174,
    borderRadius: radius.md,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surfaceRaised,
  },
  poster: { width: '100%', height: '100%' },
  posterFallback: { alignItems: 'center', justifyContent: 'center', padding: spacing(2) },
  posterFallbackText: { ...type.small, color: colors.contentSubtle, textAlign: 'center' },
  headerInfo: { flex: 1, gap: spacing(1.5), paddingTop: spacing(14) },
  name: { ...type.h1, color: colors.content },
  originalName: { ...type.small, color: colors.contentSubtle },
  actions: { flexDirection: 'row', gap: spacing(3), paddingHorizontal: spacing(4), marginTop: spacing(5) },
  playButton: { flex: 1 },
  listButton: { flexShrink: 0 },
  ratingRow: { paddingHorizontal: spacing(4), marginTop: spacing(5), gap: spacing(1) },
  ratingValue: { ...type.small, color: colors.contentMuted },
  stars: { flexDirection: 'row', gap: spacing(1) },
  star: { padding: spacing(0.5) },
  starGlyph: { fontSize: 26 },
  starOn: { color: colors.primary },
  starOff: { color: colors.contentSubtle },
  synopsis: {
    ...type.body,
    color: colors.contentMuted,
    lineHeight: 20,
    paddingHorizontal: spacing(4),
    marginTop: spacing(5),
  },
  section: { marginTop: spacing(8) },
  chipList: { paddingHorizontal: spacing(4), gap: spacing(2), paddingBottom: spacing(3) },
  chip: {
    paddingHorizontal: spacing(3),
    paddingVertical: spacing(2),
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipLabel: { ...type.small, color: colors.contentMuted, fontWeight: '600' },
  chipLabelSelected: { color: colors.primaryContrast },
  episodeList: { paddingHorizontal: spacing(4), gap: spacing(4) },
  episodeRow: { flexDirection: 'row', alignItems: 'center', gap: spacing(3) },
  still: {
    width: 104,
    height: 60,
    borderRadius: radius.sm,
    overflow: 'hidden',
    backgroundColor: colors.surfaceRaised,
  },
  stillArt: { width: '100%', height: '100%' },
  episodeBody: { flex: 1, gap: 2 },
  episodeName: { ...type.h3, color: colors.content },
  episodeOverview: { ...type.small, color: colors.contentSubtle, lineHeight: 16 },
  castList: { paddingHorizontal: spacing(4), gap: spacing(3) },
  castCard: { width: 92, alignItems: 'center', gap: spacing(1) },
  castPhoto: {
    width: 76,
    height: 76,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
  },
  castPhotoFallback: { alignItems: 'center', justifyContent: 'center' },
  castInitial: { ...type.h2, color: colors.contentSubtle },
  castName: { ...type.small, color: colors.content, fontWeight: '600', textAlign: 'center' },
  castCharacter: { ...type.tiny, color: colors.contentSubtle, textAlign: 'center' },
  muted: { ...type.body, color: colors.contentSubtle, paddingHorizontal: spacing(4) },
});
