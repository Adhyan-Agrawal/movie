import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Button, Loading } from '../components/ui';
import { getTitleDetails } from '../lib/catalog-bridge';
import type { TitleType } from '../lib/types';
import type { RootStackParamList } from '../navigation';
import { colors } from '../theme';
import { normalizeWatchPartyRoomCode } from './protocol';

type LinkRoute = RouteProp<RootStackParamList, 'WatchPartyLink'>;
type Nav = NativeStackNavigationProp<RootStackParamList>;

export default function WatchPartyDeepLinkScreen() {
  const route = useRoute<LinkRoute>();
  const navigation = useNavigation<Nav>();
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setError('');
    void (async () => {
      const type: TitleType | null = route.params.type === 'movie' || route.params.type === 'tv'
        ? route.params.type : null;
      const party = route.params.party ? normalizeWatchPartyRoomCode(route.params.party) : null;
      if (!type || !route.params.slug || (route.params.party && !party)) throw new Error('invalid-link');
      const details = await getTitleDetails(type, route.params.slug);
      const title = details.title;
      if (!title) throw new Error('missing-title');
      const season = Number.isInteger(route.params.season) && (route.params.season as number) >= 0
        ? route.params.season : undefined;
      const episode = Number.isInteger(route.params.episode) && (route.params.episode as number) >= 1
        ? route.params.episode : undefined;
      let episodeId: string | undefined;
      let episodeName: string | undefined;
      if (type === 'tv' && season !== undefined && episode !== undefined) {
        const current = details.seasons.flatMap((item) => item.episodes)
          .find((item) => item.seasonNumber === season && item.episodeNumber === episode);
        episodeId = current?.id;
        episodeName = current?.name;
      }
      if (cancelled) return;
      navigation.replace('Player', { titleId: title.id, type, slug: title.slug, name: title.name,
        ...(title.posterUrl ? { posterUrl: title.posterUrl } : {}),
        ...(title.backdropUrl ? { backdropUrl: title.backdropUrl } : {}),
        ...(title.tmdbId ? { tmdbId: title.tmdbId } : {}), ...(title.imdbId ? { imdbId: title.imdbId } : {}),
        ...(season === undefined ? {} : { season }), ...(episode === undefined ? {} : { episode }),
        ...(episodeId ? { episodeId } : {}), ...(episodeName ? { episodeName } : {}),
        ...(party ? { party } : {}) });
    })().catch(() => { if (!cancelled) setError('This link could not be opened.'); });
    return () => { cancelled = true; };
  }, [navigation, route.params.episode, route.params.party, route.params.season, route.params.slug, route.params.type]);

  if (!error) return <Loading label="Opening title..." />;
  return <View style={styles.root}><Text style={styles.title}>Link unavailable</Text>
    <Text style={styles.body}>{error}</Text>
    <Button label="Go home" onPress={() => navigation.replace('Tabs')} /></View>;
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24, backgroundColor: colors.base },
  title: { color: colors.content, fontSize: 20, fontWeight: '700' },
  body: { color: colors.contentMuted, textAlign: 'center' },
});
