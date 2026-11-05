import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { colors, radius, spacing, type } from '../theme';
import { Badge, Button, EmptyState, FilterChip, MetaLine, Notice, Screen, SectionTitle } from '../components/ui';
import { Artwork } from '../components/Artwork';
import { Icon } from '../components/Icon';
import { Skeletons } from '../components/Skeletons';
import { useBrowseLayout } from '../components/layout';
import {
  currentUser,
  fetchContinueWatching,
  getMyRating,
  getResumePosition,
  isInWatchlist,
  setRating,
  toggleWatchlist,
} from '../lib/api';
import { getTitleDetails, isAccountCatalogId } from '../lib/catalog-bridge';
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
  const layout = useBrowseLayout();
  const insets = useSafeAreaInsets();
  const mounted = useRef(true);
  const trailerTitle = useRef<string | undefined>(undefined);

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
  const [loadFailed, setLoadFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const [expandedSynopsis, setExpandedSynopsis] = useState(false);
  const [writeMessage, setWriteMessage] = useState<string | null>(null);
  trailerTitle.current = title?.id;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setNotFound(false);
    setLoadFailed(false);
    setExpandedSynopsis(false);
    setWriteMessage(null);
    setTitle(null);
    setSeasons([]);
    setCast([]);
    setInList(false);
    setMyRating(null);
    setResume(null);
    setSelectedSeason(null);

    (async () => {
      try {
        const details = await getTitleDetails(titleType, slug);
        const found = details.title;
        if (!active) return;
        if (!found) {
          setNotFound(true);
          return;
        }
        setTitle(found);
        const seasonList = details.seasons;
        setSeasons(seasonList);
        setCast(details.cast);
        if (seasonList.length) setSelectedSeason(seasonList[0].seasonNumber);
        setLoading(false);

        // Virtual TMDB ids have no account-library foreign key. Public details
        // render immediately, independent of private reads or their failures.
        if (!isAccountCatalogId(found.id)) return;
        const [listed, rating, continueEntries] = await Promise.all([
          isInWatchlist(found.id).catch(() => false),
          getMyRating(found.id).catch(() => null),
          fetchContinueWatching(50).catch(() => []),
        ]);
        if (!active) return;

        setInList(listed);
        setMyRating(rating);

        // Resume CTA: a series deep-links to the LAST episode the viewer was
        // watching (episode id from continue-watching, position confirmed via
        // getResumePosition); a movie resumes at its title-level position.
        const entry = continueEntries.find((e) => e.title.id === found.id);
        if (found.type === 'tv' && entry?.episodeId) {
          const episode = seasonList
            .flatMap((s) => s.episodes)
            .find((e) => e.id === entry.episodeId);
          if (episode && isAccountCatalogId(episode.id)) {
            const position = await getResumePosition(found.id, episode.id).catch(() => null);
            if (active && position) {
              setResume({
                season: episode.seasonNumber,
                episode: episode.episodeNumber,
                episodeId: episode.id,
                episodeName: episode.name,
                label: `Resume S${episode.seasonNumber} E${episode.episodeNumber}`,
              });
              setSelectedSeason(episode.seasonNumber);
            }
          }
        } else if (found.type === 'movie') {
          const position = await getResumePosition(found.id).catch(() => null);
          if (active && position) setResume({ label: 'Resume' });
        }
      } catch {
        if (active) setLoadFailed(true);
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [titleType, slug, reload]);

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
    if (!title || listBusy || !isAccountCatalogId(title.id)) return;
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
    if (!title || ratingBusy || !isAccountCatalogId(title.id)) return;
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
      <Screen safeSides>
        <ScrollView style={{ width: '100%', maxWidth: layout.width, alignSelf: 'center' }}><Skeletons kind="detail" label="Loading title" /></ScrollView>
      </Screen>
    );
  }

  if (loadFailed && !title) return <Screen safeSides><EmptyState title="This title didn't load" description="If you're offline, reconnect and try again." actionLabel="Try again" onAction={() => setReload((value) => value + 1)} /></Screen>;

  if (notFound || !title) {
    return (
      <Screen safeSides>
        <EmptyState
          title="Title not found"
          description="This title isn’t in the catalog (or may have been removed)."
        />
      </Screen>
    );
  }

  const isSeries = title.type === 'tv';
  const accountAvailable = isAccountCatalogId(title.id);
  const primaryLabel = resume ? resume.label : 'Play';
  const filledStars = myRating != null ? Math.round(myRating / 2) : 0;
  const trailer = title.trailerUrl && /^https:\/\/[^\s]+$/i.test(title.trailerUrl) ? title.trailerUrl : undefined;

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
    <Screen safeSides>
      <ScrollView style={{ width: '100%', maxWidth: layout.width, alignSelf: 'center' }} contentContainerStyle={[styles.content, { paddingBottom: spacing(12) + insets.bottom }]} showsVerticalScrollIndicator={false}>
        {title.backdropUrl ? <Artwork uri={title.backdropUrl} label={title.name} style={[styles.hero, { aspectRatio: layout.wide ? 2.5 : 1.7 }]} /> : null}

        <View style={[styles.headerRow, { paddingHorizontal: layout.gutter }]}>
          {!layout.largeText ? <Artwork uri={title.posterUrl} label={title.name} style={[styles.posterWrap, layout.wide && styles.widePoster, title.backdropUrl && styles.posterOverlap]} /> : null}
          <View style={styles.headerInfo}>
            <Text style={styles.eyebrow}>{isSeries ? 'SERIES' : 'FILM'}</Text>
            <Text accessibilityRole="header" style={styles.name}>{title.name}</Text>
            {title.originalName && title.originalName !== title.name ? (
              <Text style={styles.originalName}>{title.originalName}</Text>
            ) : null}
            <MetaLine
              parts={[
                title.releaseYear ? String(title.releaseYear) : undefined,
                formatRuntime(title.runtimeMinutes),
              ]}
            />
          </View>
        </View>

        {title.genres.length ? <View style={[styles.badges, { paddingHorizontal: layout.gutter }]}>{title.genres.map((genre) => <Badge key={genre} label={genre} />)}</View> : null}

        {/* Primary actions: Play/Resume + Watchlist. */}
        <View style={[styles.actions, { paddingHorizontal: layout.gutter }]}>
          <Button label={primaryLabel} variant="primary" icon="play" size="lg" onPress={onPrimaryPress} style={styles.playButton} />
          <Button
            label={inList ? 'Saved to My List' : 'My List'}
            accessibilityLabel={inList ? `Remove ${title.name} from My List` : `Add ${title.name} to My List`}
            icon={inList ? 'check' : 'plus'}
            variant="secondary"
            size="lg"
            loading={listBusy}
            disabled={!accountAvailable}
            onPress={onToggleWatchlist}
            style={styles.listButton}
          />
        </View>

        {trailer ? <View style={{ paddingHorizontal: layout.gutter }}><Button label="Watch trailer" variant="ghost" icon="play" style={styles.trailer} onPress={() => { void Linking.openURL(trailer).catch(() => { if (mounted.current && trailerTitle.current === title.id) setWriteMessage("We couldn't open the trailer. Please try again."); }); }} /></View> : null}
        {!accountAvailable ? <Text style={[styles.availability, { paddingHorizontal: layout.gutter }]}>You can watch this title. Saving and ratings aren't available right now.</Text> : null}
        {writeMessage || loadFailed ? <View style={{ marginHorizontal: layout.gutter, marginTop: spacing(4) }}><Notice title={writeMessage ?? "Some details didn't load. Check your connection and try again."} /></View> : null}

        <View style={[styles.about, { paddingHorizontal: layout.gutter }]}>
          <Text accessibilityRole="header" style={styles.aboutHeading}>{isSeries ? 'About the series' : 'About the film'}</Text>
          {title.synopsis ? <><Text style={styles.synopsis} numberOfLines={expandedSynopsis || layout.largeText ? undefined : 5}>{title.synopsis}</Text>{title.synopsis.length > 280 && !layout.largeText ? <Button label={expandedSynopsis ? 'Read less' : 'Read more'} variant="ghost" onPress={() => setExpandedSynopsis((value) => !value)} style={styles.readMore} /> : null}</> : <Text style={styles.muted}>A synopsis isn't available for this title.</Text>}
        </View>

        {/* Viewer rating: 5 stars, each worth 2 points on the 1–10 scale. */}
        {accountAvailable ? <View style={[styles.ratingRow, { marginHorizontal: layout.gutter }]}>
          <View style={styles.ratingHeading}><Text accessibilityRole="header" style={styles.aboutHeading}>Your rating</Text><Text style={styles.ratingValue}>{myRating != null ? `${myRating} / 10` : 'Not rated'}</Text></View>
          <View style={styles.stars}>
            {STARS.map((star) => {
              const value = star * 2;
              return (
                <Pressable
                  key={star}
                  onPress={() => onRate(value)}
                  disabled={ratingBusy || !accountAvailable}
                  accessibilityRole="button"
                  accessibilityLabel={`Rate ${value} out of 10`}
                  accessibilityState={{ selected: myRating === value, disabled: ratingBusy || !accountAvailable }}
                  style={({ pressed }) => [styles.star, { opacity: pressed ? 0.7 : 1 }]}
                >
                  <Text
                    style={[styles.starGlyph, star <= filledStars ? styles.starOn : styles.starOff]}
                  >
                    {star <= filledStars ? '\u2605' : '\u2606'}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View> : null}

        {/* Series: season chips + episode list. */}
        {isSeries ? (
          <View style={styles.section}>
            <SectionTitle description="Choose a season, then settle into an episode.">Episodes</SectionTitle>
            {seasons.length ? (
              <>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={[styles.chipList, { paddingHorizontal: layout.gutter }]}
                >
                  {seasons.map((season) => {
                    const selected = activeSeason?.seasonNumber === season.seasonNumber;
                    return (
                      <FilterChip
                        key={season.id}
                        onPress={() => setSelectedSeason(season.seasonNumber)}
                        accessibilityLabel={season.seasonNumber === 0 ? 'Specials' : `Season ${season.seasonNumber}`}
                        active={selected}
                        label={season.name || (season.seasonNumber === 0 ? 'Specials' : `Season ${season.seasonNumber}`)}
                      />
                    );
                  })}
                </ScrollView>

                <View style={[styles.episodeList, { paddingHorizontal: layout.gutter }]}>
                  {activeSeason?.episodes.length ? (
                    activeSeason.episodes.map((episode) => (
                      <Pressable key={episode.id} accessibilityRole="button" accessibilityLabel={`Play season ${episode.seasonNumber}, episode ${episode.episodeNumber}, ${episode.name}`} onPress={() => goToPlayer({ season: episode.seasonNumber, episode: episode.episodeNumber, episodeId: episode.id, episodeName: episode.name })} style={({ pressed }) => [styles.episodeRow, layout.wide && styles.wideEpisode, { opacity: pressed ? 0.75 : 1 }]}>
                        <View style={[styles.still, layout.wide && styles.wideStill]}><Artwork uri={episode.stillUrl} label={episode.name} style={styles.stillArt} /><View style={styles.episodePlay}><Icon name="play" size={16} /></View></View>
                        <View style={styles.episodeBody}>
                          <Text style={styles.episodeNumber}>EPISODE {episode.episodeNumber}</Text>
                          <Text style={styles.episodeName}>
                            {episode.name}
                          </Text>
                          <MetaLine
                            parts={[
                              formatRuntime(episode.runtimeMinutes),
                              formatAirDate(episode.airDate),
                            ]}
                          />
                          {episode.overview ? (
                            <Text style={styles.episodeOverview} numberOfLines={layout.largeText ? undefined : 3}>
                              {episode.overview}
                            </Text>
                          ) : null}
                        </View>
                      </Pressable>
                    ))
                  ) : (
                    <EmptyState compact title="Episodes aren't available yet" description="Try another season or return a little later." />
                  )}
                </View>
              </>
            ) : (
              <EmptyState compact title="Episodes aren't available yet" description="Return a little later for more details." />
            )}
          </View>
        ) : null}

        {/* Cast shelf — each card links to the person page. */}
        <View style={styles.section}>
          <SectionTitle>Cast &amp; characters</SectionTitle>
          {cast.length ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={[styles.castList, { paddingHorizontal: layout.gutter }]}
            >
              {cast.map((member) => (
                <Pressable
                  key={member.personId}
                  onPress={() => navigation.navigate('Person', { id: member.personId })}
                  accessibilityRole="button"
                  accessibilityLabel={`${member.name}${member.character ? `, ${member.character}` : ''}`}
                  style={({ pressed }) => [styles.castCard, { width: layout.wide ? 124 : 100, opacity: pressed ? 0.75 : 1 }]}
                >
                  <Artwork uri={member.profileUrl} label={member.name} portrait style={styles.castPhoto} />
                  <Text style={styles.castName} numberOfLines={layout.largeText ? undefined : 2}>
                    {member.name}
                  </Text>
                  {member.character ? (
                    <Text style={styles.castCharacter} numberOfLines={layout.largeText ? undefined : 2}>
                      {member.character}
                    </Text>
                  ) : null}
                </Pressable>
              ))}
            </ScrollView>
          ) : (
            <Text style={[styles.muted, { paddingHorizontal: layout.gutter }]}>Cast information isn't available for this title yet.</Text>
          )}
        </View>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: spacing(10) },
  hero: { width: '100%', backgroundColor: colors.surfaceRaised },
  headerRow: {
    flexDirection: 'row',
    gap: spacing(4),
    paddingTop: spacing(6),
    alignItems: 'flex-start',
  },
  posterWrap: {
    width: 90,
    height: 135,
    borderRadius: radius.md,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surfaceRaised,
  },
  widePoster: { width: 132, height: 198 },
  posterOverlap: { marginTop: -spacing(14) },
  headerInfo: { flex: 1, minWidth: 0, gap: spacing(2) },
  eyebrow: { ...type.tiny, fontWeight: '700', letterSpacing: 1.6, color: colors.contentMuted },
  name: { ...type.h1, color: colors.content },
  originalName: { ...type.small, color: colors.contentMuted },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing(2), marginTop: spacing(5) },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing(3), marginTop: spacing(6) },
  playButton: { flex: 1, minWidth: 128 },
  listButton: { flexGrow: 1, minWidth: 144 },
  trailer: { alignSelf: 'flex-start', paddingHorizontal: 0, marginTop: spacing(2) },
  availability: { ...type.small, color: colors.contentMuted, marginTop: spacing(4) },
  about: { marginTop: spacing(8), gap: spacing(4) },
  aboutHeading: { ...type.h2, color: colors.content },
  ratingRow: { borderTopWidth: 1, borderColor: colors.border, paddingTop: spacing(6), marginTop: spacing(8), gap: spacing(4) },
  ratingHeading: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: spacing(2) },
  ratingValue: { ...type.small, color: colors.contentMuted },
  stars: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing(2) },
  star: { minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  starGlyph: { fontSize: 28, lineHeight: 40 },
  starOn: { color: colors.primary },
  starOff: { color: colors.contentSubtle },
  synopsis: {
    ...type.body,
    color: colors.contentMuted,
    maxWidth: 600,
  },
  readMore: { alignSelf: 'flex-start', paddingHorizontal: 0 },
  section: { marginTop: spacing(10) },
  chipList: { gap: spacing(2), paddingBottom: spacing(5) },
  episodeList: { gap: spacing(5) },
  episodeRow: { backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' },
  wideEpisode: { flexDirection: 'row', alignItems: 'stretch' },
  still: { width: '100%', aspectRatio: 16 / 9 },
  wideStill: { width: 260, aspectRatio: undefined, alignSelf: 'stretch' },
  stillArt: { width: '100%', height: '100%' },
  episodePlay: { position: 'absolute', bottom: spacing(3), left: spacing(3), width: 36, height: 36, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center', backgroundColor: '#00000099' },
  episodeBody: { flex: 1, minWidth: 0, padding: spacing(5), gap: spacing(2) },
  episodeNumber: { ...type.tiny, fontWeight: '600', letterSpacing: 0.7, color: colors.contentMuted },
  episodeName: { ...type.h3, color: colors.content },
  episodeOverview: { ...type.small, color: colors.contentMuted, maxWidth: 528 },
  castList: { gap: spacing(4) },
  castCard: { gap: spacing(2) },
  castPhoto: { width: '100%', aspectRatio: 3 / 4, borderRadius: radius.md },
  castName: { ...type.small, color: colors.content, fontWeight: '600' },
  castCharacter: { ...type.tiny, color: colors.contentMuted },
  muted: { ...type.body, color: colors.contentMuted },
});
