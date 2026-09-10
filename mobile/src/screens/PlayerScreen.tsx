import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import { useVideoPlayer, VideoView } from 'expo-video';
import type { VideoSource } from 'expo-video';

import { Button, Loading } from '../components/ui';
import { currentUser, getResumePosition, listSeasons, reportProgress, resolvePlayback } from '../lib/api';
import { recordGuestWatch, updateGuestPosition } from '../lib/guest';
import type { PlaybackSource } from '../lib/types';
import type { RootStackParamList } from '../navigation';
import { colors, radius, spacing, type } from '../theme';

/**
 * The player — the one screen that actually has to work.
 *
 * Design notes, in the order the screen reasons about them:
 *
 * Sources. Providers are resolved server-side by the web app's /api/playback
 * bridge and arrive already anonymized ("Server 1", "Server 2", …). The native
 * app NEVER sees a real provider identity, so the label from the bridge is the
 * only thing we are allowed to render. Resolution happens once per mount (and
 * per Retry) AFTER reading the saved resume position, because providers that
 * support it take a `start` parameter at resolve time — we cannot seek an embed
 * after the fact.
 *
 * Consent. Some providers must be loaded in a frame that sets their own cookies,
 * so a source flagged `consentRequired` is gated: we render a prompt and load
 * nothing until the viewer taps "Load player". Consent is remembered per source
 * id for the life of the screen, so flipping between servers does not re-nag for
 * one already accepted — but a *different* gated server still prompts. Embeds are
 * deliberately not sandboxed; the providers reject restricted frames (the gate is
 * the privacy control, not an attribute).
 *
 * Rendering. `embed` sources are a full-bleed WebView (the provider renders its
 * own player). `hls`/`mp4`/`dash` sources play through expo-video. A native
 * surface sits under overlaid chrome, which is why it uses `textureView` on
 * Android — a SurfaceView punches through overlapping views.
 *
 * Telemetry. Embeds expose no position, so the most we can honestly do is record
 * that this device watched the title (guest store) and let the provider keep its
 * own progress. Native playback reports the *observed* `timeUpdate` position
 * every ~5s, and once more on unmount/source change, to `reportProgress` when
 * signed in and to the device-local guest store when signed out. A position we
 * never observed is never reported — no zeroes, no guesses.
 *
 * Up next. When the catalog knows the following episode we surface it as a pill;
 * replacing (not pushing) keeps the back stack from filling with episodes.
 */

type PlayerRoute = RouteProp<RootStackParamList, 'Player'>;
type Nav = NativeStackNavigationProp<RootStackParamList>;

/** Cadence for native progress reports (the player's timeUpdate interval matches). */
const PROGRESS_INTERVAL_MS = 5000;

/** Sources that play through expo-video (everything except the embed frame). */
function isNativeSource(kind: PlaybackSource['kind']): boolean {
  return kind === 'hls' || kind === 'mp4' || kind === 'dash';
}

/**
 * The expo-video surface for a native source.
 *
 * Split into its own component so `useVideoPlayer` is called unconditionally
 * (hooks rule) while the parent stays free to render nothing at all — no player
 * is ever constructed for a gated source the viewer has not accepted. The parent
 * keys this by source id, so switching servers tears the old player down and
 * builds a fresh one for the new URL.
 */
function NativeSourcePlayer({
  source,
  onTime,
  onError,
  style,
}: {
  source: PlaybackSource;
  /** Real observed position (seconds) plus duration, or null when unknown. */
  onTime: (positionSeconds: number, durationSeconds: number | null) => void;
  onError: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  // DASH streams usually have no file extension in the URL, so the type has to
  // be declared (hls/mp4 URLs are self-describing and pass through as strings).
  const videoSource: VideoSource = useMemo(
    () =>
      source.kind === 'dash'
        ? { uri: source.url, contentType: 'dash' as const }
        : source.url,
    [source.kind, source.url],
  );

  const player = useVideoPlayer(videoSource, (p) => {
    p.timeUpdateEventInterval = PROGRESS_INTERVAL_MS / 1000;
    p.play();
  });

  // Latest-value refs: the listeners below are attached once per player, so they
  // must not close over stale callbacks.
  const onTimeRef = useRef(onTime);
  const onErrorRef = useRef(onError);
  onTimeRef.current = onTime;
  onErrorRef.current = onError;

  useEffect(() => {
    const timeSub = player.addListener('timeUpdate', ({ currentTime }) => {
      const duration = player.duration;
      onTimeRef.current(currentTime, Number.isFinite(duration) && duration > 0 ? duration : null);
    });
    const statusSub = player.addListener('statusChange', ({ status }) => {
      if (status === 'error') onErrorRef.current();
    });
    return () => {
      timeSub.remove();
      statusSub.remove();
    };
  }, [player]);

  return (
    <VideoView
      player={player}
      style={style}
      contentFit="contain"
      nativeControls
      fullscreenOptions={{ enable: true }}
      // Overlaid chrome requires a texture-backed surface on Android; a
      // SurfaceView would render above (and hide) every control we draw.
      surfaceType="textureView"
    />
  );
}

export default function PlayerScreen() {
  const route = useRoute<PlayerRoute>();
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();

  const {
    titleId,
    type: titleType,
    slug,
    name,
    tmdbId,
    imdbId,
    season,
    episode,
    episodeId,
    episodeName,
    nextSeason,
    nextEpisode,
    nextEpisodeName,
  } = route.params;

  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [sources, setSources] = useState<PlaybackSource[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [consentedIds, setConsentedIds] = useState<string[]>([]);
  const [failedSourceId, setFailedSourceId] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const activeSource = useMemo(
    () => sources.find((s) => s.id === activeId) ?? sources[0] ?? null,
    [sources, activeId],
  );
  const isNative = !!activeSource && isNativeSource(activeSource.kind);
  const needsConsent =
    !!activeSource && activeSource.consentRequired && !consentedIds.includes(activeSource.id);
  const failed = !!activeSource && failedSourceId === activeSource.id;

  // -------------------------------------------------------------------------
  // Resolve sources (once per mount / retry)
  // -------------------------------------------------------------------------

  useEffect(() => {
    let cancelled = false;
    setPhase('loading');
    setFailedSourceId(null);

    (async () => {
      const user = await currentUser();
      // Resume first: providers that support `start` need it at resolve time.
      const resume = await getResumePosition(titleId, episodeId);
      const resolved = await resolvePlayback({
        type: titleType,
        ...(tmdbId ? { tmdbId } : {}),
        ...(imdbId ? { imdbId } : {}),
        ...(season !== undefined ? { season } : {}),
        ...(episode !== undefined ? { episode } : {}),
        ...(resume && resume.positionSeconds > 0 ? { start: resume.positionSeconds } : {}),
      });
      if (cancelled) return;

      setSignedIn(!!user);
      setSources(resolved);
      setActiveId(resolved[0]?.id ?? null);
      setPhase(resolved.length ? 'ready' : 'error');

      // Signed-out viewers get a device-local entry (the native twin of the web
      // guest store); signed-in viewers are tracked server-side instead. This is
      // all an embed can ever give us — it exposes no position.
      if (!user) {
        void recordGuestWatch({
          slug,
          type: titleType,
          name,
          ...(season !== undefined ? { seasonNumber: season } : {}),
          ...(episode !== undefined ? { episodeNumber: episode } : {}),
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [titleId, titleType, slug, name, tmdbId, imdbId, season, episode, episodeId, attempt]);

  // -------------------------------------------------------------------------
  // Telemetry — native sources only, and only while one is actually playing
  // -------------------------------------------------------------------------

  const lastPositionRef = useRef<number | null>(null);
  const lastDurationRef = useRef<number | null>(null);

  const guestEpisode = useMemo(
    () => (season !== undefined && episode !== undefined ? { seasonNumber: season, episodeNumber: episode } : undefined),
    [season, episode],
  );

  const handleTime = useCallback((positionSeconds: number, durationSeconds: number | null) => {
    lastPositionRef.current = positionSeconds;
    lastDurationRef.current = durationSeconds;
  }, []);

  const flushProgress = useCallback(() => {
    const position = lastPositionRef.current;
    // Embeds report nothing, and a position we never observed is never invented.
    if (position === null || position <= 0) return;
    const duration = lastDurationRef.current;
    if (signedIn) {
      void reportProgress({
        titleId,
        ...(episodeId ? { episodeId } : {}),
        positionSeconds: position,
        ...(duration && duration > 0 ? { durationSeconds: duration } : {}),
      });
    } else {
      void updateGuestPosition(slug, position, duration && duration > 0 ? duration : undefined, guestEpisode);
    }
  }, [signedIn, titleId, episodeId, slug, guestEpisode]);

  useEffect(() => {
    if (phase !== 'ready' || !activeSource) return;
    if (!isNative || needsConsent || failed) return;

    // A new source starts its own timeline — drop the previous one's readings so
    // the first tick can't report a position from the server we just left.
    lastPositionRef.current = null;
    lastDurationRef.current = null;

    const timer = setInterval(flushProgress, PROGRESS_INTERVAL_MS);
    return () => {
      clearInterval(timer);
      flushProgress(); // last known real position, on unmount or source switch
    };
  }, [phase, activeSource, isNative, needsConsent, failed, flushProgress]);

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeSource?.id ?? null;

  const handleSurfaceError = useCallback(() => {
    if (activeIdRef.current) setFailedSourceId(activeIdRef.current);
  }, []);

  const close = useCallback(() => {
    if (navigation.canGoBack()) navigation.goBack();
    else navigation.navigate('Tabs');
  }, [navigation]);

  const retry = useCallback(() => {
    setFailedSourceId(null);
    setAttempt((n) => n + 1);
  }, []);

  function selectSource(next: PlaybackSource) {
    if (next.id === activeSource?.id) return;
    setFailedSourceId(null);
    setActiveId(next.id);
  }

  function acceptConsent() {
    if (!activeSource) return;
    setFailedSourceId(null);
    setConsentedIds((prev) => (prev.includes(activeSource.id) ? prev : [...prev, activeSource.id]));
  }

  // -------------------------------------------------------------------------
  // "Up next" — derived from the catalog, not from route params
  // -------------------------------------------------------------------------
  // The caller can't reliably know the following episode (and after advancing,
  // nobody is left to tell us), so the next episode is computed here from the
  // season/episode index. Falls back to caller-supplied params when present.
  const [catalogNext, setCatalogNext] = useState<{ season: number; episode: number; name?: string } | null>(null);

  useEffect(() => {
    if (titleType !== 'tv' || season === undefined || episode === undefined) return;
    // Guests carry a slug rather than a catalog id — nothing to look up.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(titleId)) return;

    let cancelled = false;
    void listSeasons(titleId)
      .then((seasons) => {
        if (cancelled) return;
        const flat = seasons.flatMap((s) =>
          s.episodes.map((e) => ({ season: s.seasonNumber, episode: e.episodeNumber, name: e.name })),
        );
        const idx = flat.findIndex((e) => e.season === season && e.episode === episode);
        setCatalogNext(idx >= 0 && idx < flat.length - 1 ? flat[idx + 1]! : null);
      })
      .catch(() => {
        if (!cancelled) setCatalogNext(null);
      });
    return () => {
      cancelled = true;
    };
  }, [titleType, titleId, season, episode]);

  const nextEp =
    catalogNext ??
    (nextSeason !== undefined && nextEpisode !== undefined
      ? { season: nextSeason, episode: nextEpisode, ...(nextEpisodeName ? { name: nextEpisodeName } : {}) }
      : null);

  const goToNext = useCallback(() => {
    if (!nextEp) return;
    const next: RootStackParamList['Player'] = { titleId, type: titleType, slug, name };
    if (tmdbId) next.tmdbId = tmdbId;
    if (imdbId) next.imdbId = imdbId;
    next.season = nextEp.season;
    next.episode = nextEp.episode;
    // episodeId / episodeName are intentionally omitted: the catalog id of the
    // next episode isn't known here, and passing the current one would be a lie.
    // The next screen re-derives everything from the catalog itself.
    navigation.replace('Player', next);
  }, [navigation, titleId, titleType, slug, name, tmdbId, imdbId, nextEp]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const episodeLabel = season !== undefined && episode !== undefined ? `S${season} E${episode}` : null;
  const heading = episodeLabel ? `${name} · ${episodeLabel}` : name;
  const hasNext = nextEp !== null;

  function renderSurface() {
    if (phase !== 'ready' || !activeSource || failed || needsConsent) return null;

    if (activeSource.kind === 'embed') {
      return (
        <WebView
          key={activeSource.id}
          source={{ uri: activeSource.url }}
          style={styles.surface}
          javaScriptEnabled
          allowsFullscreenVideo
          allowsInlineMediaPlayback
          mediaPlaybackRequiresUserAction={false}
          onError={handleSurfaceError}
        />
      );
    }

    return (
      <NativeSourcePlayer
        key={activeSource.id}
        source={activeSource}
        onTime={handleTime}
        onError={handleSurfaceError}
        style={styles.surface}
      />
    );
  }

  const showError = phase === 'error' || failed;

  return (
    <View style={styles.root}>
      {renderSurface()}

      {/* Full-screen states — drawn under the chrome so Back stays reachable. */}
      {phase === 'loading' ? (
        <View style={styles.overlay}>
          <Loading label="Finding a source…" />
        </View>
      ) : null}

      {showError ? (
        <View style={styles.overlay}>
          <View style={styles.panel}>
            <Text style={styles.panelTitle}>Playback unavailable</Text>
            <Text style={styles.panelBody}>
              No authorized source is available for this title right now.
            </Text>
            <View style={styles.panelActions}>
              <Button label="Retry" onPress={retry} />
              <Button label="Close" variant="ghost" onPress={close} />
            </View>
          </View>
        </View>
      ) : null}

      {phase === 'ready' && !showError && needsConsent && activeSource ? (
        <View style={styles.overlay}>
          <View style={styles.panel}>
            <Text style={styles.panelTitle}>Play with {activeSource.label}?</Text>
            <Text style={styles.panelBody}>
              Playback is provided by an external service — loading it may set its cookies and is
              subject to their terms.
            </Text>
            <View style={styles.panelActions}>
              <Button label="Load player" onPress={acceptConsent} />
              <Button label="Not now" variant="ghost" onPress={close} />
            </View>
          </View>
        </View>
      ) : null}

      {/* Top chrome: close affordance, title, and the up-next affordance. */}
      <View style={[styles.topChrome, { paddingTop: insets.top + spacing(3) }]}>
        <View style={styles.topRow}>
          <Pressable
            onPress={close}
            accessibilityRole="button"
            accessibilityLabel="Close player"
            hitSlop={spacing(3)}
            style={({ pressed }) => [styles.closeButton, pressed && { opacity: 0.7 }]}
          >
            <Text style={styles.closeGlyph}>✕</Text>
          </Pressable>
          <View style={styles.titleBlock}>
            <Text style={styles.title} numberOfLines={1}>
              {heading}
            </Text>
            {episodeName ? (
              <Text style={styles.subtitle} numberOfLines={1}>
                {episodeName}
              </Text>
            ) : null}
          </View>
        </View>

        {hasNext && nextEp && !showError ? (
          <Pressable
            onPress={goToNext}
            accessibilityRole="button"
            accessibilityLabel={`Up next: season ${nextEp.season} episode ${nextEp.episode}`}
            style={({ pressed }) => [styles.upNext, pressed && { opacity: 0.85 }]}
          >
            <Text style={styles.upNextLabel} numberOfLines={1}>
              {`Up next: S${nextEp.season} E${nextEp.episode}${nextEp.name ? ` · ${nextEp.name}` : ''}`}
            </Text>
          </Pressable>
        ) : null}
      </View>

      {/* Bottom chrome: server selector. */}
      {phase === 'ready' && sources.length ? (
        <View style={[styles.bottomChrome, { paddingBottom: insets.bottom + spacing(3) }]}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.serverRow}
          >
            {sources.map((source, index) => {
              const active = source.id === activeSource?.id;
              return (
                <Pressable
                  key={source.id}
                  onPress={() => selectSource(source)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  accessibilityLabel={source.label || `Server ${index + 1}`}
                  style={({ pressed }) => [
                    styles.chip,
                    active && styles.chipActive,
                    pressed && { opacity: 0.85 },
                  ]}
                >
                  <Text style={[styles.chipLabel, active && styles.chipLabelActive]} numberOfLines={1}>
                    {source.label || `Server ${index + 1}`}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.base },
  surface: { flex: 1, backgroundColor: '#000' },
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.base,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing(6),
  },
  panel: { alignItems: 'center', gap: spacing(3) },
  panelTitle: { ...type.h2, color: colors.content, textAlign: 'center' },
  panelBody: { ...type.body, color: colors.contentMuted, textAlign: 'center' },
  panelActions: { alignItems: 'center', gap: spacing(2), marginTop: spacing(2) },

  topChrome: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    paddingHorizontal: spacing(4),
    paddingBottom: spacing(2),
    gap: spacing(2),
    pointerEvents: 'box-none',
  },
  topRow: { flexDirection: 'row', alignItems: 'center', gap: spacing(3), pointerEvents: 'box-none' },
  closeButton: {
    width: 34,
    height: 34,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceOverlay,
    borderWidth: 1,
    borderColor: colors.border,
  },
  closeGlyph: { ...type.h3, color: colors.content, lineHeight: 20 },
  titleBlock: { flex: 1, pointerEvents: 'none' },
  title: { ...type.h3, color: colors.content, textShadowColor: 'rgba(0,0,0,0.6)', textShadowRadius: 6 },
  subtitle: {
    ...type.small,
    color: colors.contentMuted,
    marginTop: 2,
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowRadius: 6,
  },
  upNext: {
    alignSelf: 'flex-start',
    backgroundColor: colors.primary,
    borderRadius: radius.pill,
    paddingHorizontal: spacing(3),
    paddingVertical: spacing(1.5),
  },
  upNextLabel: { ...type.tiny, color: colors.primaryContrast, fontWeight: '600' },

  bottomChrome: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingTop: spacing(2),
    pointerEvents: 'box-none',
  },
  serverRow: { gap: spacing(2), paddingHorizontal: spacing(4) },
  chip: {
    backgroundColor: colors.surfaceOverlay,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.pill,
    paddingHorizontal: spacing(4),
    paddingVertical: spacing(2),
  },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipLabel: { ...type.small, fontWeight: '600', color: colors.contentMuted },
  chipLabelActive: { color: colors.primaryContrast },
});
