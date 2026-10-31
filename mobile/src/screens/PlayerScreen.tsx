import { useEffect, useRef, useState } from 'react';
import { AppState, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import * as ScreenOrientation from 'expo-screen-orientation';
import { Button } from '../components/ui';
import { fetchIntroCatalog, getPlaybackContext, listSeasons, recordPlaybackSession, reportProgress, resolvePlaybackDetails } from '../lib/api';
import { getGuestResume, recordGuestWatch, updateGuestPosition } from '../lib/guest';
import type { IntroMarker, PlaybackResponse } from '../lib/types';
import type { RootStackParamList } from '../navigation';
import NativePlayer, { type Snapshot } from '../player/NativePlayer';
import { markCheckpointSynced, mediaKey, readCheckpoint, selectResume, writeCheckpoint } from '../player/checkpoint';
import { acquireOrientation } from '../player/orientation';
import { colors } from '../theme';

type PlayerRoute = RouteProp<RootStackParamList, 'Player'>;
type Nav = NativeStackNavigationProp<RootStackParamList>;
const BROWSER_USER_AGENT = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

export default function PlayerScreen() {
  const route = useRoute<PlayerRoute>();
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const params = route.params;
  const { titleId, type, slug, name, season, episode } = params;
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [bridge, setBridge] = useState<PlaybackResponse>({ sources: [] });
  const [intro, setIntro] = useState<{ identity: string; url: string; marker: IntroMarker | null } | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [consented, setConsented] = useState<string[]>([]);
  const [failedId, setFailedId] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [initial, setInitial] = useState<Snapshot>({ positionSeconds: 0, playing: true });
  const [context, setContext] = useState<{ viewerKey: string; episodeId?: string }>({ viewerKey: 'unavailable' });
  const [catalogNext, setCatalogNext] = useState<{ season: number; episode: number; id?: string; name?: string } | null>(null);
  const sessionRecorded = useRef<string | null>(null);
  const lastSnapshot = useRef<Snapshot | null>(null);
  const reports = useRef<Promise<unknown>>(Promise.resolve());
  const checkpointKey = mediaKey({ titleId, type, season, episode, episodeId: params.episodeId });
  const introIdentity = JSON.stringify([titleId, type, slug, params.tmdbId, params.imdbId, season, episode, params.episodeId]);
  const introIdentityRef = useRef(introIdentity);
  introIdentityRef.current = introIdentity;
  const active = bridge.sources.find((s) => s.id === activeId) ?? bridge.sources[0];
  const needsConsent = !!active && active.consentRequired && !consented.includes(active.id);
  const failed = !!active && active.id === failedId;

  useEffect(() => {
    return acquireOrientation(ScreenOrientation.OrientationLock.DEFAULT);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const introRequest = new AbortController();
    setPhase('loading');
    setIntro(null);
    setFailedId(null);
    lastSnapshot.current = null;
    void (async () => {
      const viewer = await getPlaybackContext(titleId, type, params.episodeId, season, episode);
      const [checkpoint, guestResume] = await Promise.all([
        readCheckpoint(viewer.viewerKey, checkpointKey),
        viewer.viewerKey === 'guest' ? getGuestResume(slug, type, season, episode) : Promise.resolve(null),
      ]);
      // Exact local checkpoint includes intentional seeks to zero. Timestamp wins over remote history.
      const history = viewer.resume ?? guestResume;
      const resume = selectResume(viewer.viewerKey, checkpoint, history);
      const snapshot: Snapshot = { positionSeconds: resume?.positionSeconds ?? 0,
        ...(checkpoint?.durationSeconds ? { durationSeconds: checkpoint.durationSeconds } : {}), playing: true };
      const resolved = await resolvePlaybackDetails({ type, titleId,
        ...(viewer.episodeId ? { episodeId: viewer.episodeId } : {}),
        ...(params.tmdbId ? { tmdbId: params.tmdbId } : {}), ...(params.imdbId ? { imdbId: params.imdbId } : {}),
        ...(season !== undefined ? { season } : {}), ...(episode !== undefined ? { episode } : {}),
        ...(snapshot.positionSeconds > 0 ? { start: snapshot.positionSeconds } : {}),
      });
      if (cancelled) return;
      setContext(viewer);
      setInitial(snapshot);
      setBridge(resolved);
      setActiveId(resolved.sources[0]?.id ?? null);
      setPhase(resolved.sources.length ? 'ready' : 'error');
      const introUrl = resolved.introCatalogUrl;
      if (introUrl && resolved.sources.length) void fetchIntroCatalog(introUrl, introRequest.signal).then((marker) => {
        if (!cancelled && !introRequest.signal.aborted && introIdentityRef.current === introIdentity) {
          setIntro({ identity: introIdentity, url: introUrl, marker });
        }
      });
    })().catch(() => { if (!cancelled) setPhase('error'); });
    return () => { cancelled = true; introRequest.abort(); };
  }, [titleId, type, slug, params.tmdbId, params.imdbId, params.episodeId, season, episode, checkpointKey, introIdentity, attempt]);

  // Record only an actually opened, consented source. Unknown TV episodes never write title-only history.
  useEffect(() => {
    if (phase !== 'ready' || !active || needsConsent || failed) return;
    const key = `${context.viewerKey}:${checkpointKey}`;
    if (sessionRecorded.current === key) return;
    sessionRecorded.current = key;
    if (context.viewerKey === 'guest') {
      void recordGuestWatch({ slug, type, name,
        ...(params.posterUrl ? { posterUrl: params.posterUrl } : {}), ...(params.backdropUrl ? { backdropUrl: params.backdropUrl } : {}),
        ...(params.tmdbId ? { tmdbId: params.tmdbId } : {}), ...(params.imdbId ? { imdbId: params.imdbId } : {}), catalogId: titleId,
        ...(season !== undefined ? { seasonNumber: season } : {}), ...(episode !== undefined ? { episodeNumber: episode } : {}),
      });
    } else if (context.viewerKey.startsWith('account:') && (type === 'movie' || context.episodeId)) {
      void recordPlaybackSession(titleId, context.episodeId, context.viewerKey);
    }
  }, [phase, active, needsConsent, failed, context, checkpointKey, slug, type, name, titleId, season, episode, params.posterUrl, params.backdropUrl, params.tmdbId, params.imdbId]);

  function persist(snapshot: Snapshot) {
    if (!Number.isFinite(snapshot.positionSeconds) || snapshot.positionSeconds < 0) return;
    lastSnapshot.current = snapshot;
    setInitial(snapshot);
    const shouldReport = context.viewerKey.startsWith('account:') && (type === 'movie' || !!context.episodeId);
    const local = writeCheckpoint(context.viewerKey, checkpointKey, snapshot.positionSeconds, snapshot.durationSeconds, snapshot.playing, shouldReport);
    if (context.viewerKey === 'guest') {
      void updateGuestPosition(slug, snapshot.positionSeconds, snapshot.durationSeconds,
        type === 'tv' && season !== undefined && episode !== undefined ? { seasonNumber: season, episodeNumber: episode } : undefined, type);
    } else if (shouldReport) {
      const input = { titleId, episodeId: context.episodeId, viewerKey: context.viewerKey,
        positionSeconds: snapshot.positionSeconds, ...(snapshot.durationSeconds ? { durationSeconds: snapshot.durationSeconds } : {}) };
      reports.current = reports.current.catch(() => {}).then(async () => {
        const captured = await local;
        const result = await reportProgress(input);
        if (result.ok && captured) await markCheckpointSynced(input.viewerKey, checkpointKey, captured);
      });
    }
  }

  const persistRef = useRef(persist);
  persistRef.current = persist;
  useEffect(() => {
    const listener = AppState.addEventListener('change', (state) => {
      if (state !== 'active' && lastSnapshot.current) persistRef.current(lastSnapshot.current);
    });
    return () => { listener.remove(); if (lastSnapshot.current) persistRef.current(lastSnapshot.current); };
  }, []);

  useEffect(() => {
    setCatalogNext(null);
    if (type !== 'tv' || season === undefined || episode === undefined || !/^[0-9a-f-]{36}$/i.test(titleId)) return;
    let cancelled = false;
    void listSeasons(titleId).then((seasons) => {
      if (cancelled) return;
      const flat = seasons.flatMap((s) => s.episodes.map((e) => ({ season: s.seasonNumber, episode: e.episodeNumber, id: e.id, name: e.name })))
        .sort((a, b) => a.season - b.season || a.episode - b.episode);
      const index = flat.findIndex((e) => e.season === season && e.episode === episode);
      setCatalogNext(index >= 0 ? flat[index + 1] ?? null : null);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [titleId, type, season, episode]);
  const next = catalogNext ?? (params.nextSeason !== undefined && params.nextEpisode !== undefined
    ? { season: params.nextSeason, episode: params.nextEpisode, name: params.nextEpisodeName, id: undefined } : null);

  function close() {
    if (lastSnapshot.current) persist(lastSnapshot.current);
    if (navigation.canGoBack()) navigation.goBack();
    else navigation.navigate('Tabs');
  }

  const playNext = next ? () => {
      if (lastSnapshot.current) persist(lastSnapshot.current);
      navigation.replace('Player', { titleId, type, slug, name, tmdbId: params.tmdbId, imdbId: params.imdbId,
        posterUrl: params.posterUrl, backdropUrl: params.backdropUrl, season: next.season, episode: next.episode,
        episodeId: next.id, episodeName: next.name });
  } : undefined;
  const header = <View style={styles.headerRow}>
    <Button label="Close player" variant="ghost" onPress={close} />
    <Text style={styles.title} numberOfLines={2}>{name}{season !== undefined && episode !== undefined ? ` / S${season} E${episode}` : ''}</Text>
  </View>;
  const footer = <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.sourceRow} accessibilityLabel="Playback sources">
    {bridge.sources.map((source) => <Pressable key={source.id} accessibilityRole="button" accessibilityLabel={`Source: ${source.label}`}
      accessibilityState={{ selected: source.id === active?.id }} onPress={() => {
        if (lastSnapshot.current) { persist(lastSnapshot.current); setInitial(lastSnapshot.current); }
        setFailedId(null);
        setActiveId(source.id);
      }} style={[styles.chip, source.id === active?.id && { backgroundColor: colors.primary }]}>
      <Text style={styles.chipText}>{source.label}{source.kind === 'embed' ? ' / external player' : ''}</Text>
    </Pressable>)}
  </ScrollView>;

  if (phase === 'ready' && active && !needsConsent && !failed && active.kind !== 'embed') {
    return <NativePlayer key={`${context.viewerKey}:${checkpointKey}`} source={active} initial={initial} subtitleCatalogUrl={bridge.subtitleCatalogUrl}
      intro={intro?.identity === introIdentity && intro.url === bridge.introCatalogUrl ? intro.marker : null}
      adPolicy={bridge.entitlements?.resolved === true && bridge.entitlements.adFree === false ? bridge.adPolicy : undefined} upNext={next && playNext ? { label: `Up next S${next.season} E${next.episode}`, onPress: playNext } : undefined}
      onCheckpoint={persist} onError={() => setFailedId(active.id)} header={header} footer={footer} />;
  }

  return <View style={styles.root}>
    {phase === 'ready' && active?.kind === 'embed' && !needsConsent && !failed ? <WebView key={active.id} source={{ uri: active.url }}
      style={StyleSheet.absoluteFill} javaScriptEnabled allowsFullscreenVideo allowsInlineMediaPlayback
      mediaPlaybackRequiresUserAction={false} userAgent={BROWSER_USER_AGENT} applicationNameForUserAgent=""
      originWhitelist={['http://*', 'https://*']} thirdPartyCookiesEnabled domStorageEnabled sharedCookiesEnabled
      setSupportMultipleWindows={false} onError={() => setFailedId(active.id)} /> : <View style={styles.panel}>
      {phase === 'loading' ? <Text style={styles.title}>Finding a source...</Text> : needsConsent ? <>
        <Text style={styles.title}>Play with {active?.label}?</Text>
        <Text style={styles.body}>Loading this external playback service may set its cookies and is subject to its terms.</Text>
        <Button label="Load player" onPress={() => { if (active) setConsented((ids) => [...ids, active.id]); }} />
        <Button label="Not now" variant="ghost" onPress={close} />
      </> : <>
        <Text style={styles.title}>Playback unavailable</Text>
        <Text style={styles.body}>Retry or choose another authorized source.</Text>
        <Button label="Retry" onPress={() => setAttempt((n) => n + 1)} />
      </>}
    </View>}
    <View style={[styles.top, { paddingTop: insets.top + 12 }]}>{header}</View>
    {phase === 'ready' ? <View style={[styles.bottom, { paddingBottom: insets.bottom + 12 }]}>{footer}</View> : null}
  </View>;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  panel: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24 },
  headerRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  title: { color: colors.content, fontSize: 18, fontWeight: '600', flexShrink: 1 },
  body: { color: colors.contentMuted, textAlign: 'center' },
  top: { position: 'absolute', top: 0, left: 16, right: 16 },
  bottom: { position: 'absolute', bottom: 0, left: 0, right: 0 },
  sourceRow: { gap: 8, paddingHorizontal: 8 },
  chip: { padding: 12, minHeight: 44, backgroundColor: '#252630', borderRadius: 12 },
  chipText: { color: '#fff', fontSize: 13 },
});
