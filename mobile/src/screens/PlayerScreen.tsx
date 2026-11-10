import { useEffect, useRef, useState } from 'react';
import { AppState, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import * as ScreenOrientation from 'expo-screen-orientation';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Button } from '../components/ui';
import { fetchEpisodeNavigation, fetchIntroCatalog, getPlaybackContext, recordPlaybackSession, reportProgress, resolvePlaybackDetails,
  PLAYBACK_CONTEXT_TIMEOUT_MS, sameOriginPlaybackUrl, withPlaybackDeadline } from '../lib/api';
import { getGuestResume, recordGuestWatch, updateGuestPosition } from '../lib/guest';
import type { IntroMarker, PlaybackResponse } from '../lib/types';
import type { RootStackParamList } from '../navigation';
import NativePlayer, { type Snapshot } from '../player/NativePlayer';
import { markCheckpointSynced, mediaKey, readCheckpoint, selectResume, writeCheckpoint } from '../player/checkpoint';
import { acquireOrientation } from '../player/orientation';
import { parseEpisodeNavigationRequest, type EpisodeNavigation } from '../player/episode-navigation';
import { colors } from '../theme';
import { sameWatchPartyMediaIdentity } from '../watch-party/protocol';
import { buildWatchPartyMediaIdentity } from '../watch-party/identity';
import WatchPartySheet from '../watch-party/WatchPartySheet';
import { useWatchPartySession } from '../watch-party/useWatchPartySession';
import { WATCH_PARTY_SERVICE_AVAILABLE } from '../watch-party/config';

type PlayerRoute = RouteProp<RootStackParamList, 'Player'>;
type Nav = NativeStackNavigationProp<RootStackParamList>;
const BROWSER_USER_AGENT = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';
export const AUTO_NEXT_KEY = 'lumora:player:auto-next:v1';

export default function PlayerScreen() {
  const route = useRoute<PlayerRoute>();
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const params = route.params;
  const { titleId, type, slug, name, season, episode } = params;
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [bridge, setBridge] = useState<PlaybackResponse>({ sources: [] });
  const [loadedIdentity, setLoadedIdentity] = useState('');
  const [intro, setIntro] = useState<{ identity: string; url: string; marker: IntroMarker | null } | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [consented, setConsented] = useState<string[]>([]);
  const [failedId, setFailedId] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [initial, setInitial] = useState<Snapshot>({ positionSeconds: 0, playing: true });
  const [context, setContext] = useState<{ viewerKey: string; episodeId?: string }>({ viewerKey: 'unavailable' });
  const [episodeNavigation, setEpisodeNavigation] = useState<{ identity: string; url: string; value: EpisodeNavigation | null;
    status: 'loading' | 'ready' | 'error' } | null>(null);
  const [episodeAttempt, setEpisodeAttempt] = useState(0);
  const [autoNext, setAutoNext] = useState(false);
  const [autoNextNotice, setAutoNextNotice] = useState('');
  const autoNextVersion = useRef(0);
  const autoNextWrites = useRef<Promise<void>>(Promise.resolve());
  const episodeTransition = useRef<string | null>(null);
  const [partyOpen, setPartyOpen] = useState(Boolean(params.party));
  const sessionRecorded = useRef<string | null>(null);
  const lastSnapshot = useRef<Snapshot | null>(null);
  const reports = useRef<Promise<unknown>>(Promise.resolve());
  const checkpointKey = mediaKey({ titleId, type, season, episode, episodeId: params.episodeId });
  const introIdentity = JSON.stringify([titleId, type, slug, params.tmdbId, params.imdbId, season, episode, params.episodeId]);
  const introIdentityRef = useRef(introIdentity);
  introIdentityRef.current = introIdentity;
  if (episodeTransition.current && episodeTransition.current !== introIdentity) episodeTransition.current = null;
  const ready = phase === 'ready' && loadedIdentity === introIdentity;
  const active = bridge.sources.find((s) => s.id === activeId) ?? bridge.sources[0];
  const needsConsent = !!active && active.consentRequired && !consented.includes(active.id);
  const failed = !!active && active.id === failedId;
  const nativeEpisodeSurface = ready && !!active && !needsConsent && !failed && active.kind !== 'embed';
  const partyMedia = buildWatchPartyMediaIdentity({ type, titleId, episodeId: context.episodeId, season, episode });
  const partySurface = ready && active && !needsConsent && !failed
    ? active.kind === 'embed' ? 'embed' as const : 'native' as const : 'unavailable' as const;
  const party = useWatchPartySession({ media: partyMedia, surface: partySurface, type, slug,
    ...(season === undefined ? {} : { season }), ...(episode === undefined ? {} : { episode }) });
  const partyNativeSyncEnabled = WATCH_PARTY_SERVICE_AVAILABLE && party.state.phase === 'connected' && partySurface === 'native'
    && !!partyMedia && !!party.state.playback && sameWatchPartyMediaIdentity(party.state.playback.media, partyMedia);
  const partyBlocksEpisodes = WATCH_PARTY_SERVICE_AVAILABLE
    && (!!party.state.room || ['ticketing', 'connecting', 'connected', 'reconnecting'].includes(party.state.phase));
  const episodeContext = useRef({ identity: introIdentity, blocked: partyBlocksEpisodes });
  episodeContext.current = { identity: introIdentity, blocked: partyBlocksEpisodes };

  useEffect(() => {
    let mounted = true;
    const version = autoNextVersion.current;
    void withPlaybackDeadline(() => AsyncStorage.getItem(AUTO_NEXT_KEY), 500).then((value) => {
      if (mounted && version === autoNextVersion.current) setAutoNext(value === 'true');
    }).catch(() => {});
    return () => { mounted = false; };
  }, []);

  function chooseAutoNext(enabled: boolean) {
    if (episodeContext.current.blocked || episodeContext.current.identity !== introIdentity
      || neighbors?.status !== 'ready' || !neighbors.value?.next) return;
    autoNextVersion.current += 1;
    setAutoNext(enabled);
    setAutoNextNotice('');
    autoNextWrites.current = autoNextWrites.current.catch(() => {}).then(() => AsyncStorage.setItem(AUTO_NEXT_KEY, String(enabled)))
      .catch(() => { setAutoNextNotice('Auto Next changed for this session, but could not be saved.'); });
  }

  useEffect(() => {
    return acquireOrientation(ScreenOrientation.OrientationLock.DEFAULT);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const playbackRequest = new AbortController();
    setPhase('loading');
    setIntro(null);
    setFailedId(null);
    lastSnapshot.current = null;
    void (async () => {
      // Start the public bridge independently of optional account/history preparation.
      const resolution = resolvePlaybackDetails({ type, titleId,
        ...(params.episodeId ? { episodeId: params.episodeId } : {}),
        ...(params.tmdbId ? { tmdbId: params.tmdbId } : {}), ...(params.imdbId ? { imdbId: params.imdbId } : {}),
        ...(season !== undefined ? { season } : {}), ...(episode !== undefined ? { episode } : {}),
      }, playbackRequest.signal);
      const preparation = (async () => {
        const viewer = await withPlaybackDeadline((signal) => getPlaybackContext(titleId, type, params.episodeId, season, episode, signal),
          PLAYBACK_CONTEXT_TIMEOUT_MS, playbackRequest.signal).catch(() => ({ viewerKey: 'unavailable', episodeId: params.episodeId, resume: null }));
        const [checkpoint, guestResume] = await Promise.all([
          withPlaybackDeadline(() => readCheckpoint(viewer.viewerKey, checkpointKey), 500, playbackRequest.signal).catch(() => null),
          viewer.viewerKey === 'guest'
            ? withPlaybackDeadline(() => getGuestResume(slug, type, season, episode), 500, playbackRequest.signal).catch(() => null)
            : Promise.resolve(null),
        ]);
        // Exact local checkpoints retain intentional zero/backward seeks and account pending-sync precedence.
        const resume = selectResume(viewer.viewerKey, checkpoint, viewer.resume ?? guestResume);
        const snapshot: Snapshot = { positionSeconds: resume?.positionSeconds ?? 0,
          ...(checkpoint?.durationSeconds ? { durationSeconds: checkpoint.durationSeconds } : {}), playing: true };
        return { viewer, snapshot };
      })();
      const [resolved, { viewer, snapshot }] = await Promise.all([resolution, preparation]);
      if (cancelled) return;
      setContext(viewer);
      setInitial(snapshot);
      setBridge(resolved);
      setLoadedIdentity(introIdentity);
      setActiveId(resolved.sources[0]?.id ?? null);
      setPhase(resolved.sources.length ? 'ready' : 'error');
      const introUrl = resolved.introCatalogUrl;
      if (introUrl && resolved.sources.length) void fetchIntroCatalog(introUrl, playbackRequest.signal).then((marker) => {
        if (!cancelled && !playbackRequest.signal.aborted && introIdentityRef.current === introIdentity) {
          setIntro({ identity: introIdentity, url: introUrl, marker });
        }
      }).catch(() => {});
    })().catch(() => { if (!cancelled) setPhase('error'); });
    return () => { cancelled = true; playbackRequest.abort(); };
  }, [titleId, type, slug, params.tmdbId, params.imdbId, params.episodeId, season, episode, checkpointKey, introIdentity, attempt]);

  // Record only an actually opened, consented source. Unknown TV episodes never write title-only history.
  useEffect(() => {
    if (!ready || !active || needsConsent || failed) return;
    const key = `${context.viewerKey}:${checkpointKey}`;
    if (sessionRecorded.current === key) return;
    sessionRecorded.current = key;
    if (context.viewerKey === 'guest') {
      try {
        void Promise.resolve(recordGuestWatch({ slug, type, name,
          ...(params.posterUrl ? { posterUrl: params.posterUrl } : {}), ...(params.backdropUrl ? { backdropUrl: params.backdropUrl } : {}),
          ...(params.tmdbId ? { tmdbId: params.tmdbId } : {}), ...(params.imdbId ? { imdbId: params.imdbId } : {}), catalogId: titleId,
          ...(season !== undefined ? { seasonNumber: season } : {}), ...(episode !== undefined ? { episodeNumber: episode } : {}),
        })).catch(() => {});
      } catch { /* Device-local history is best effort. */ }
    } else if (context.viewerKey.startsWith('account:') && (type === 'movie' || context.episodeId)) {
      try { void Promise.resolve(recordPlaybackSession(titleId, context.episodeId, context.viewerKey)).catch(() => {}); }
      catch { /* Remote history is best effort. */ }
    }
  }, [ready, active, needsConsent, failed, context, checkpointKey, slug, type, name, titleId, season, episode, params.posterUrl, params.backdropUrl, params.tmdbId, params.imdbId]);

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
      }).catch(() => {});
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
    setEpisodeNavigation(null);
    if (!nativeEpisodeSurface || type !== 'tv' || !bridge.episodeNavigationUrl) return;
    const url = sameOriginPlaybackUrl(bridge.episodeNavigationUrl);
    if (!url) return;
    const request = parseEpisodeNavigationRequest(new URL(url).searchParams);
    if (!request || request.tmdbId !== params.tmdbId || request.season !== season || request.episode !== episode) return;
    const controller = new AbortController();
    setEpisodeNavigation({ identity: introIdentity, url, value: null, status: 'loading' });
    // Optional verified neighbors are fetched only after public playback is available, never inferred from route hints.
    void fetchEpisodeNavigation(url, controller.signal).then((value) => {
      if (controller.signal.aborted || introIdentityRef.current !== introIdentity) return;
      const before = value.previous && (value.previous.seasonNumber - request.season || value.previous.episodeNumber - request.episode);
      const after = value.next && (value.next.seasonNumber - request.season || value.next.episodeNumber - request.episode);
      if ((before !== null && before >= 0) || (after !== null && after <= 0)) throw new Error('Invalid episode neighbors.');
      setEpisodeNavigation({ identity: introIdentity, url, value, status: 'ready' });
    }).catch(() => {
      if (!controller.signal.aborted && introIdentityRef.current === introIdentity) {
        setEpisodeNavigation({ identity: introIdentity, url, value: null, status: 'error' });
      }
    });
    return () => controller.abort();
  }, [nativeEpisodeSurface, type, bridge.episodeNavigationUrl, params.tmdbId, season, episode, introIdentity, episodeAttempt]);
  const neighbors = nativeEpisodeSurface && episodeNavigation?.identity === introIdentity && episodeNavigation.url === sameOriginPlaybackUrl(bridge.episodeNavigationUrl)
    ? episodeNavigation : null;

  function close() {
    if (lastSnapshot.current) persist(lastSnapshot.current);
    if (navigation.canGoBack()) navigation.goBack();
    else navigation.navigate('Tabs');
  }

  function changeEpisode(direction: 'previous' | 'next') {
    const target = neighbors?.value?.[direction];
    if (!target || !ready || type !== 'tv' || episodeContext.current.identity !== introIdentity || episodeContext.current.blocked
      || episodeTransition.current === introIdentity || AppState.currentState !== 'active') return;
    episodeTransition.current = introIdentity;
    if (lastSnapshot.current) persist(lastSnapshot.current);
    navigation.replace('Player', { titleId, type, slug: target.href.split('?', 1)[0]!.slice('/watch/tv/'.length), name,
      tmdbId: params.tmdbId, imdbId: params.imdbId, posterUrl: params.posterUrl, backdropUrl: params.backdropUrl,
      season: target.seasonNumber, episode: target.episodeNumber, episodeName: target.name });
  }
  const episodes = type === 'tv' ? {
    previous: neighbors?.value?.previous ? { label: `S${neighbors.value.previous.seasonNumber} E${neighbors.value.previous.episodeNumber}`,
      onPress: () => changeEpisode('previous') } : null,
    next: neighbors?.value?.next ? { label: `S${neighbors.value.next.seasonNumber} E${neighbors.value.next.episodeNumber}`,
      onPress: () => changeEpisode('next') } : null,
    autoNext, onAutoNextChange: chooseAutoNext, blocked: partyBlocksEpisodes,
    loading: neighbors?.status === 'loading', onRetry: neighbors?.status === 'error' ? () => setEpisodeAttempt((n) => n + 1) : undefined,
    notice: partyBlocksEpisodes ? 'Leave Watch Party to change episodes. Party-wide episode changes are not supported.'
      : neighbors?.status === 'loading' ? 'Loading verified episodes...'
        : neighbors?.status === 'error' ? 'Episode information is unavailable. Retry without reloading the video.'
          : !neighbors ? 'Verified episode information is unavailable for this title.' : autoNextNotice,
  } : undefined;
  const partyConnectedCount = party.state.participants.filter((participant) => participant.connected).length;
  const partyLabel = !WATCH_PARTY_SERVICE_AVAILABLE ? 'Watch Party unavailable' : party.state.phase === 'connected' && party.state.room
    ? `Party ${party.state.room.roomCode} / ${partyConnectedCount}`
    : party.state.phase === 'reconnecting' ? 'Party reconnecting'
      : party.state.phase === 'ticketing' || party.state.phase === 'connecting' ? 'Party connecting' : 'Watch Party';
  const header = <View style={styles.headerRow}>
    <Button label="Close player" variant="ghost" onPress={close} />
    <Text style={styles.title} numberOfLines={2}>{name}{season !== undefined && episode !== undefined ? ` / S${season} E${episode}` : ''}</Text>
    <Pressable accessibilityRole="button" accessibilityLabel="Open Watch Party" onPress={() => setPartyOpen(true)}
      style={[styles.partyChip, WATCH_PARTY_SERVICE_AVAILABLE && party.state.phase === 'connected' && styles.partyChipConnected]}>
      <Text style={styles.partyChipText}>{partyLabel}</Text>
    </Pressable>
  </View>;
  const footer = <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.sourceRow} accessibilityLabel="Playback sources">
    {bridge.sources.map((source) => <Pressable key={source.id} accessibilityRole="button" accessibilityLabel={`Source: ${source.label}`}
      accessibilityState={{ selected: source.id === active?.id }} onPress={() => {
        if (source.id === active?.id) return;
        if (active?.kind === 'embed' || source.kind === 'embed') party.notifySourceChange();
        if (lastSnapshot.current) { persist(lastSnapshot.current); setInitial(lastSnapshot.current); }
        setFailedId(null);
        setActiveId(source.id);
      }} style={[styles.chip, source.id === active?.id && { backgroundColor: colors.primary }]}>
      <Text style={styles.chipText}>{source.label}{source.kind === 'embed' ? ' / external player' : ''}</Text>
    </Pressable>)}
  </ScrollView>;

  if (ready && active && !needsConsent && !failed && active.kind !== 'embed') {
    return <View style={styles.root}><NativePlayer key={`${context.viewerKey}:${checkpointKey}`} source={active} initial={initial}
      partyMedia={partyMedia} partyConnected={partyNativeSyncEnabled} partyRole={party.state.self?.role ?? null}
      partyPlayback={party.state.playback} registerPartyPlayerPort={party.registerPlayerPort}
      subtitleCatalogUrl={bridge.subtitleCatalogUrl}
      intro={intro?.identity === introIdentity && intro.url === bridge.introCatalogUrl ? intro.marker : null}
      adPolicy={context.viewerKey !== 'unavailable' && bridge.entitlements?.resolved === true && bridge.entitlements.adFree === false ? bridge.adPolicy : undefined}
      episodes={episodes}
      onCheckpoint={persist} header={header} footer={footer} />
      <WatchPartySheet open={partyOpen} onClose={() => setPartyOpen(false)} session={party} initialRoomCode={params.party} />
    </View>;
  }

  return <View style={styles.root}>
    {ready && active?.kind === 'embed' && !needsConsent && !failed ? <WebView key={active.id} source={{ uri: active.url }}
      style={StyleSheet.absoluteFill} javaScriptEnabled allowsFullscreenVideo allowsInlineMediaPlayback
      mediaPlaybackRequiresUserAction={false} userAgent={BROWSER_USER_AGENT} applicationNameForUserAgent=""
      originWhitelist={['http://*', 'https://*']} thirdPartyCookiesEnabled domStorageEnabled sharedCookiesEnabled
      setSupportMultipleWindows={false} onError={() => setFailedId(active.id)} /> : <View style={styles.panel}>
      {phase === 'loading' || (phase === 'ready' && loadedIdentity !== introIdentity) ? <Text style={styles.title}>Finding a source...</Text> : needsConsent ? <>
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
    {WATCH_PARTY_SERVICE_AVAILABLE && party.state.phase === 'connected' && active?.kind === 'embed'
      ? <Text style={[styles.chatOnly, { top: insets.top + 76 }]}>Watch Party chat only / WebView sync unsupported</Text> : null}
    {ready ? <View style={[styles.bottom, { paddingBottom: insets.bottom + 12 }]}>{footer}</View> : null}
    <WatchPartySheet open={partyOpen} onClose={() => setPartyOpen(false)} session={party} initialRoomCode={params.party} />
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
  partyChip: { minHeight: 44, minWidth: 44, justifyContent: 'center', paddingHorizontal: 12, borderRadius: 999,
    borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.surfaceRaised },
  partyChipConnected: { borderColor: colors.success, backgroundColor: colors.success + '22' },
  partyChipText: { color: colors.content, fontSize: 12, fontWeight: '700' },
  chatOnly: { position: 'absolute', left: 16, right: 16, color: colors.warning, fontSize: 12,
    textAlign: 'center', backgroundColor: 'rgba(0,0,0,0.72)', padding: 8 },
});
