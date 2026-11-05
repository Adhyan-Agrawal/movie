'use client';

import { useCallback, useEffect, useRef, useState, type ComponentType } from 'react';
import { useRouter } from 'next/navigation';
import { cn } from '@/lib/cn';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import type { PlaybackError, PlaybackSource } from '@/lib/providers/types';
import { type PlayerState, playerStateForError } from './player-states';
import { PlayerControlsBar } from './PlayerControlsBar';
import { parseEpisodeNavigation, type EpisodeNavigation } from './episode-navigation';
import { NativePlayer } from './NativePlayer';
import type { EpisodeNavTarget } from './EpisodeNavLinks';
import { PreRollAd } from '@/features/ads/PreRollAd';
import { readConsent } from '@/components/consent/ConsentBanner';
import {
  reportPlaybackEndAction,
  reportPlaybackHeartbeatAction,
  reportPlaybackStartAction,
} from '@/features/playback/session-actions';
import { reportPlaybackIssueAction } from '@/features/playback/report-actions';
import { recordGuestWatch } from '@/features/playback/guest-watch';
import type { PlaybackAdPolicy } from '@/features/commerce/types';
import type { WatchPartyMediaIdentity } from '@/features/watch-party/protocol';
import {
  WatchPartyPanel,
  useWatchPartySession,
  type PartyPlayerPortRegistrationProps,
} from '@/features/watch-party/web';
import { playbackMediaKey } from '@/features/playback/playback-checkpoint';

const PartyPortNativePlayer = NativePlayer as ComponentType<
  React.ComponentProps<typeof NativePlayer> & PartyPlayerPortRegistrationProps
>;

/**
 * Player surface (Spec Section 9). Responsive 16:9 external-provider iframe with
 * a sandbox appropriate to an embed provider, a referrer policy, fullscreen,
 * and an explicit consent gate. Renders honest loading / consent-required /
 * blocked-unavailable / error states and NEVER presents a broken iframe as the
 * primary experience.
 *
 * Commercial (Spec Section 11): when a pre-roll zone is configured, a skippable
 * ad gate plays ABOVE the player after consent and before the provider iframe
 * mounts — once per tab session.
 *
 * This component does not scrape, read, or inject scripts into the iframe — it
 * cannot, and must not try. Because embed providers expose no reliable
 * telemetry (capabilities.telemetry === false), Lumora keeps its own progress
 * via {@link recordHeartbeat} (a no-op stub for this slice).
 *
 * Native sources (mp4/hls/dash) bypass the iframe entirely and render
 * {@link NativePlayer} in the same surface — consent/pre-roll gates still apply,
 * and native telemetry (real positions) flows to watch_progress separately.
 */

export interface PlayerShellProps {
  /** `id` is the catalog title id used for session/watch-history recording. */
  title: {
    id: string;
    name: string;
    slug: string;
    type: 'movie' | 'tv';
    tmdbId?: string;
    /** Poster art for the guest (localStorage) continue-watching entry. */
    posterUrl?: string;
  };
  source: PlaybackSource | null;
  error?: PlaybackError | null;
  sources?: PlaybackSource[];
  providerLabel?: string;
  consentRequired?: boolean;
  /** TV episode id, so native-player progress targets the exact episode. */
  episodeId?: string;
  /** TV only: season/episode numbers (guest store resume + native player). */
  seasonNumber?: number;
  episodeNumber?: number;
  /**
   * TV only: the following episode when one exists, resolved server-side from
   * the real episode index. Native playback can reveal it near the end; external
   * embeds expose no progress telemetry, so they rely on page-level navigation.
   */
  nextEpisode?: EpisodeNavTarget;
  /** Same-origin verified previous/next lookup, independent of stream readiness. */
  episodeNavigationUrl?: string;
  /** Saved resume position (seconds) forwarded to the native player. */
  initialPosition?: number;
  resumeUpdatedAt?: number;
  viewerKey?: string;
  adPolicy?: PlaybackAdPolicy;
  /** Same-origin, episode-bound intro marker catalog. Native playback fetches it lazily. */
  introCatalogUrl?: string;
  /** Server-validated availability only; service URLs and credentials never reach this component. */
  reportingAvailable?: boolean;
  watchPartyConfigured?: boolean;
  watchPartyMedia?: WatchPartyMediaIdentity | null;
  initialPartyRoomCode?: string;
  /**
   * Pre-roll ad zone (Spec Section 11). Resolved server-side from env and
   * passed here — env vars are stripped from client bundles. Null = no pre-roll.
   */
  preroll?: { adsterraKey: string; width: number; height: number } | null;
}

/** SessionStorage marker so the pre-roll shows once per tab session. */
const PREROLL_SESSION_KEY = 'lumora:preroll-shown';
const AUTO_NEXT_STORAGE_KEY = 'lumora:player:auto-next:v1';
function verifiedEpisodeNavigation(value: unknown, slug: string, season: number, episode: number, origin = 'https://player.invalid'): EpisodeNavigation | null {
  if (!Number.isSafeInteger(season) || season < 0 || !Number.isSafeInteger(episode) || episode < 1) return null;
  const navigation = parseEpisodeNavigation(value, origin);
  if (!navigation) return null;
  for (const direction of ['previous', 'next'] as const) {
    const target = navigation[direction];
    if (!target) continue;
    const relative = target.seasonNumber === season ? target.episodeNumber - episode : target.seasonNumber - season;
    if (target.href.split('?', 1)[0] !== `/watch/tv/${slug}` || (direction === 'previous' ? relative >= 0 : relative <= 0)) return null;
  }
  return navigation;
}

/**
 * Playback session recording (Spec Sections 9, 14, 18). The external embed
 * exposes no position telemetry, so Lumora records its OWN session events —
 * start / heartbeat / end — via server actions into `playback_sessions` (which
 * drives the account History page). Never a fabricated position: the honest
 * limitation is "watched on {date}", not a fake progress bar.
 */
function recordHeartbeat(sessionId: string | null): void {
  if (sessionId) void reportPlaybackHeartbeatAction(sessionId);
}

function unavailableMessage(error?: PlaybackError | null): string {
  switch (error?.code) {
    case 'consent-required':
      return 'This title needs your consent before the external player can load.';
    case 'region-blocked':
      return 'This title is not available to play in your region.';
    case 'invalid-request':
    case 'unsupported':
      return 'We could not resolve a valid player for this title yet.';
    case 'timeout':
    case 'network':
      return 'We could not reach the playback provider. Check your connection and try again.';
    case 'provider-disabled':
    case 'host-not-allowed':
    case 'not-found':
    case 'provider-error':
      return 'No authorized source is available for this title right now.';
    default:
      return 'Playback is temporarily unavailable. Please try again.';
  }
}

export function PlayerShell({
  title,
  source,
  error = null,
  sources = [],
  providerLabel,
  consentRequired,
  episodeId,
  seasonNumber,
  episodeNumber,
  initialPosition,
  resumeUpdatedAt,
  viewerKey = 'guest',
  adPolicy,
  introCatalogUrl,
  reportingAvailable = false,
  watchPartyConfigured = false,
  watchPartyMedia = null,
  initialPartyRoomCode,
  preroll = null,
  nextEpisode,
  episodeNavigationUrl,
}: PlayerShellProps) {
  const router = useRouter();

  const hasCoordinates = seasonNumber !== undefined && episodeNumber !== undefined;
  const mediaScope = `${viewerKey}:${playbackMediaKey(title.id, hasCoordinates ? undefined : episodeId, seasonNumber, episodeNumber)}`;
  const [episodeLookup, setEpisodeLookup] = useState<{ scope: string; url: string; navigation: EpisodeNavigation | null } | null>(null);
  const [autoNext, setAutoNext] = useState(false);
  const [episodeTransition, setEpisodeTransition] = useState<string | null>(null);
  const episodeTransitionRef = useRef<string | null>(null);
  const prepareEpisodeTransitionRef = useRef<{ scope: string; prepare: () => Promise<boolean> } | null>(null);
  const episodeMountedRef = useRef(true);
  const [selection, setSelection] = useState<{ mediaScope: string; id: string } | null>(null);
  const activeSourceId = selection?.mediaScope === mediaScope ? selection.id : null;
  const activeSourceRef = useRef<PlaybackSource | null>(null);
  // List churn must not replace an explicit choice with the default server.
  const activeSource = activeSourceId
    ? sources.find((candidate) => candidate.id === activeSourceId)
      ?? (source?.id === activeSourceId ? source : null)
      ?? (activeSourceRef.current?.id === activeSourceId ? activeSourceRef.current : null)
    : source;
  activeSourceRef.current = activeSource;
  const activeHasUrl = Boolean(activeSource?.url);
  const hasSource = activeHasUrl;
  const displayedSources = activeSource && !sources.some((candidate) => candidate.id === activeSource.id) ? [...sources, activeSource] : sources;
  // Gate on the ACTIVE source (switching servers re-evaluates consent), with
  // the route-level prop as fallback.
  const gate = activeSource?.consentRequired ?? consentRequired ?? false;
  // Public label only — the upstream provider's real name never renders in the
  // public player (see the watch route's PUBLIC SOURCE LABELING note).
  const providerName = activeSource?.label ?? providerLabel ?? source?.label ?? 'Server 1';
  const activeConsentKey = (() => {
    if (!activeSource) return null;
    let origin = 'invalid';
    try { origin = new URL(activeSource.url ?? '', 'https://player.invalid').origin; } catch { /* Invalid URLs remain gated. */ }
    return `${activeSource.id}:${activeSource.providerId ?? ''}:${activeSource.kind}:${origin}`;
  })();

  const [consentedProviderKey, setConsentedProviderKey] = useState<string | null>(null);
  const [partyPanelOpen, setPartyPanelOpen] = useState(Boolean(initialPartyRoomCode));
  const [state, setState] = useState<PlayerState>('loading');
  const [reloadKey, setReloadKey] = useState(0);
  const [reportState, setReportState] = useState<{ attempt: string; status: 'pending' | 'reported' | 'error' } | null>(null);
  const reportRequestRef = useRef<{ attempt: string } | null>(null);
  const reportingAvailableRef = useRef(reportingAvailable);
  reportingAvailableRef.current = reportingAvailable;
  const failedAttemptRef = useRef(false);
  const attemptKey = `${mediaScope}:${activeSource?.id ?? ''}:${reloadKey}`;
  const attemptRef = useRef(attemptKey);
  attemptRef.current = attemptKey;
  const reported = reportState?.attempt === attemptKey && reportState.status === 'reported';
  const reportPending = reportState?.attempt === attemptKey && reportState.status === 'pending';
  const reportError = reportState?.attempt === attemptKey && reportState.status === 'error'
    ? 'Your report could not be sent. Please try again.' : undefined;
  const reportDisabled = !reportingAvailable || reportPending || reported;
  useEffect(() => {
    if (!reportingAvailable) {
      reportRequestRef.current = null;
      setReportState(null);
    }
  }, [reportingAvailable]);
  // Pre-roll gate: no ad configured = already done. The session-once check
  // runs after mount (sessionStorage is not available during SSR) so the
  // initial render matches the server and hydration never mismatches.
  const [adDone, setAdDone] = useState(!preroll);
  // Advertising consent (Spec Section 15): the pre-roll only plays for viewers
  // who accepted ads in the consent banner; otherwise the video starts direct.
  const [adsConsent, setAdsConsent] = useState(false);

  useEffect(() => {
    let hasAdsConsent = false;
    try {
      hasAdsConsent = Boolean(readConsent()?.ads);
    } catch {
      // Private mode — best effort only.
    }
    setAdsConsent(hasAdsConsent);
    // Resolve this only after mount so the server and hydration renders match.
    // Without advertising consent there is no ad gate to wait for.
    if (preroll && !hasAdsConsent) setAdDone(true);
  }, [preroll]);

  useEffect(() => {
    if (!preroll) return;
    try {
      if (sessionStorage.getItem(PREROLL_SESSION_KEY)) setAdDone(true);
    } catch {
      // Private mode — best effort only.
    }
  }, [preroll]);

  // Gate on the ACTIVE source: if the viewer switched to a server that has no
  // URL (shouldn't happen — the registry only lists resolvable sources), the
  // player renders the unavailable panel for that server.
  const showConsent = activeHasUrl && gate && consentedProviderKey !== activeConsentKey;
  const showAd = activeHasUrl && !showConsent && preroll !== null && !adDone && adsConsent;
  // The player surface (native or iframe) mounts only after the gates clear.
  const showPlayer = activeHasUrl && (!gate || consentedProviderKey === activeConsentKey) && adDone;
  // Native sources (Lumora-hosted mp4/hls/dash) render <video> instead of an
  // embed iframe — same surface, same gates, real telemetry.
  const nativeKind =
    activeSource && activeSource.url
      ? activeSource.kind === 'mp4' || activeSource.kind === 'hls' || activeSource.kind === 'dash'
        ? activeSource.kind
        : null
      : null;
  const party = useWatchPartySession({
    configured: watchPartyConfigured,
    media: watchPartyMedia,
    surface: !activeHasUrl ? 'unavailable' : nativeKind ? 'native' : 'embed',
  });
  const episodeNavigationDisabled = Boolean(party.state.room) || ['ticketing', 'connecting', 'reconnecting'].includes(party.state.phase);
  const episodeNavigation = title.type !== 'tv' || !hasCoordinates ? null
    : episodeNavigationUrl ? episodeLookup?.scope === mediaScope && episodeLookup.url === episodeNavigationUrl ? episodeLookup.navigation : null
      : nextEpisode ? verifiedEpisodeNavigation({ previous: null, next: {
        seasonNumber: nextEpisode.season, episodeNumber: nextEpisode.episode, name: nextEpisode.name || nextEpisode.label,
        href: `/watch/tv/${title.slug}?season=${nextEpisode.season}&episode=${nextEpisode.episode}`,
      } }, title.slug, seasonNumber!, episodeNumber!) : null;
  const episodeContextRef = useRef({ mediaScope, navigation: episodeNavigation, disabled: episodeNavigationDisabled, autoNext });
  episodeContextRef.current = { mediaScope, navigation: episodeNavigation, disabled: episodeNavigationDisabled, autoNext };

  useEffect(() => {
    episodeMountedRef.current = true;
    return () => { episodeMountedRef.current = false; };
  }, []);

  useEffect(() => {
    try { setAutoNext(window.localStorage.getItem(AUTO_NEXT_STORAGE_KEY) === 'true'); }
    catch { /* Auto Next defaults off when storage is unavailable. */ }
  }, []);

  useEffect(() => {
    if (title.type !== 'tv' || !hasCoordinates || !episodeNavigationUrl) return;
    const controller = new AbortController();
    let active = true;
    const timer = setTimeout(() => controller.abort(), 10_000);
    void (async () => {
      try {
        const url = new URL(episodeNavigationUrl, window.location.href);
        if (url.origin !== window.location.origin || url.username || url.password) return;
        const response = await fetch(episodeNavigationUrl, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal });
        const body: unknown = response.ok ? await response.json() : null;
        if (active && !controller.signal.aborted) setEpisodeLookup({ scope: mediaScope, url: episodeNavigationUrl,
          navigation: verifiedEpisodeNavigation(body, title.slug, seasonNumber!, episodeNumber!, window.location.origin) });
      } catch { /* Unverified episodes never become navigation targets. */ }
      finally { clearTimeout(timer); }
    })();
    return () => { active = false; clearTimeout(timer); controller.abort(); };
  }, [mediaScope, title.type, title.slug, hasCoordinates, seasonNumber, episodeNumber, episodeNavigationUrl]);

  const navigateEpisode = useCallback((direction: 'previous' | 'next') => {
    const context = episodeContextRef.current;
    const target = context.navigation?.[direction];
    if (!episodeMountedRef.current || context.mediaScope !== mediaScope || !target || context.disabled
      || episodeTransitionRef.current === context.mediaScope) return false;
    episodeTransitionRef.current = context.mediaScope;
    setEpisodeTransition(context.mediaScope);
    void (async () => {
      let navigated = false;
      try {
        const transition = prepareEpisodeTransitionRef.current;
        if (transition?.scope === context.mediaScope && !await transition.prepare()) return;
        const latest = episodeContextRef.current;
        if (!episodeMountedRef.current || latest.mediaScope !== context.mediaScope || latest.disabled
          || latest.navigation?.[direction]?.href !== target.href) return;
        router.push(target.href);
        navigated = true;
      } catch { /* A failed transition leaves the current episode available. */ }
      finally {
        if (!navigated && episodeTransitionRef.current === context.mediaScope) {
          episodeTransitionRef.current = null;
          if (episodeMountedRef.current) setEpisodeTransition(null);
        }
      }
    })();
    return true;
  }, [mediaScope, router]);
  const registerEpisodeTransition = useCallback((prepare: (() => Promise<boolean>) | null) => {
    if (prepare) prepareEpisodeTransitionRef.current = { scope: mediaScope, prepare };
    else if (prepareEpisodeTransitionRef.current?.scope === mediaScope) prepareEpisodeTransitionRef.current = null;
  }, [mediaScope]);
  const handleContentEnded = useCallback(() => {
    if (episodeContextRef.current.mediaScope === mediaScope && episodeContextRef.current.autoNext) navigateEpisode('next');
  }, [mediaScope, navigateEpisode]);
  const handleAutoNext = useCallback((enabled: boolean) => {
    const context = episodeContextRef.current;
    if (!episodeMountedRef.current || context.mediaScope !== mediaScope || context.disabled) return;
    episodeContextRef.current = { ...context, autoNext: enabled };
    setAutoNext(enabled);
    try { window.localStorage.setItem(AUTO_NEXT_STORAGE_KEY, String(enabled)); }
    catch { /* The explicit choice still works for this session. */ }
  }, [mediaScope]);
  const playerFailed = showPlayer && state === 'provider-error';
  const normalizedTmdbId = title.tmdbId?.trim();
  const subtitleCatalogUrl = (() => {
    if (
      !normalizedTmdbId ||
      !/^\d+$/.test(normalizedTmdbId) ||
      !Number.isSafeInteger(Number(normalizedTmdbId)) ||
      Number(normalizedTmdbId) <= 0
    ) {
      return undefined;
    }
    const params = new URLSearchParams({ tmdbId: normalizedTmdbId, type: title.type });
    if (title.type === 'tv' && seasonNumber !== undefined && episodeNumber !== undefined) {
      params.set('season', String(seasonNumber));
      params.set('episode', String(episodeNumber));
    }
    return `/api/subtitles?${params.toString()}`;
  })();

  const handleAdDone = useCallback(() => {
    try {
      sessionStorage.setItem(PREROLL_SESSION_KEY, '1');
    } catch {
      // Private mode — best effort only.
    }
    setAdDone(true);
    setState('loading');
  }, []);

  useEffect(() => {
    if (initialPartyRoomCode) setPartyPanelOpen(true);
  }, [initialPartyRoomCode]);

  // Pre-roll safety net: if the creative never calls onDone (blocked zone, ad
  // network failure), auto-continue to the video after 8s. Otherwise a broken
  // ad would strand the player behind the gate forever — and with it the guest
  // continue-watching recording that only happens once the player mounts.
  useEffect(() => {
    if (!showAd) return;
    const timer = window.setTimeout(handleAdDone, 8000);
    return () => window.clearTimeout(timer);
  }, [showAd, handleAdDone]);

  // Lumora-owned session recording — provider telemetry is unavailable.
  const sessionIdRef = useRef<string | null>(null);
  const [sessionReady, setSessionReady] = useState(false);

  // Only cross-origin embeds lack observable readiness. Native media must
  // actually supply playable data, not become "ready" because a timer elapsed.
  useEffect(() => {
    if (!showPlayer || nativeKind !== null) return;
    const timer = window.setTimeout(() => {
      if (attemptRef.current === attemptKey && !failedAttemptRef.current) setState((s) => (s === 'loading' ? 'ready' : s));
    }, 12_000);
    return () => window.clearTimeout(timer);
  }, [showPlayer, nativeKind, attemptKey]);

  useEffect(() => {
    failedAttemptRef.current = false;
    setConsentedProviderKey(null);
    setState('loading');
  }, [mediaScope]);

  useEffect(() => {
    if (!showPlayer) return;
    if (viewerKey === 'guest') {
      recordGuestWatch({
        slug: title.slug,
        type: title.type,
        name: title.name,
        ...(title.posterUrl ? { posterUrl: title.posterUrl } : {}),
        ...(episodeId ? { episodeId } : {}),
        ...(seasonNumber !== undefined ? { seasonNumber } : {}),
        ...(episodeNumber !== undefined ? { episodeNumber } : {}),
      });
      return;
    }
    if (viewerKey === 'unavailable') return;
    // One session row per player mount (reloadKey re-mounts count as replays).
    let cancelled = false;
    sessionIdRef.current = null;
    void reportPlaybackStartAction(title.id, episodeId).then((r) => {
      if (cancelled) return;
      if (r.ok && r.sessionId) {
        sessionIdRef.current = r.sessionId;
        setSessionReady(true);
      }
    });
    return () => {
      cancelled = true;
      const id = sessionIdRef.current;
      if (id) void reportPlaybackEndAction(id);
      sessionIdRef.current = null;
      setSessionReady(false);
    };
  }, [showPlayer, reloadKey, viewerKey, title.id, title.slug, title.type, title.name, title.posterUrl, episodeId, seasonNumber, episodeNumber]);

  useEffect(() => {
    if (!showPlayer || !sessionReady) return;
    const id = sessionIdRef.current;
    if (!id) return;
    recordHeartbeat(id); // first beat at mount
    const interval = window.setInterval(() => recordHeartbeat(id), 300_000);
    return () => window.clearInterval(interval);
  }, [showPlayer, sessionReady]);

  function handleConsent() {
    setConsentedProviderKey(activeConsentKey);
    setState('loading');
  }

  function handleRetry() {
    reportRequestRef.current = null;
    setReportState(null);
    if (hasSource) {
      failedAttemptRef.current = false;
      // Native retries in place; only an iframe needs a fresh mount.
      setState('loading');
      setReloadKey((key) => key + 1);
    } else {
      // Nothing resolved server-side — re-run resolution.
      router.refresh();
    }
  }

  function handleReport() {
    if (!episodeMountedRef.current || !reportingAvailableRef.current || attemptRef.current !== attemptKey || reportDisabled
      || reportRequestRef.current?.attempt === attemptKey) return;
    const request = { attempt: attemptKey };
    reportRequestRef.current = request;
    setReportState({ attempt: attemptKey, status: 'pending' });
    void (async () => {
      let ok = false;
      try {
        // Safe diagnostics only, never a source URL, token, or upstream provider identity.
        const result = await reportPlaybackIssueAction({
          titleId: title.id,
          ...(episodeId ? { episodeId } : {}),
          serverLabel: activeSource?.label ?? source?.label,
          playerState: hasSource ? state : error ? playerStateForError(error.code) : 'blocked',
        });
        ok = result?.ok === true;
      } catch { /* A failed action must never become a recorded report. */ }
      if (reportRequestRef.current !== request) return;
      reportRequestRef.current = null;
      if (episodeMountedRef.current && attemptRef.current === request.attempt) {
        setReportState({ attempt: request.attempt, status: ok ? 'reported' : 'error' });
      }
    })();
  }

  function handleSelectSource(id: string) {
    if (!id || id === activeSource?.id || !displayedSources.some((candidate) => candidate.id === id && candidate.url)) return;
    failedAttemptRef.current = false;
    setConsentedProviderKey(null);
    setSelection({ mediaScope, id });
    setState('loading');
    setReloadKey((key) => key + 1);
  }

  const handleNativeReady = useCallback(() => {
    if (!failedAttemptRef.current) setState('ready');
  }, []);
  const handlePlaybackError = useCallback(() => {
    if (failedAttemptRef.current) return;
    failedAttemptRef.current = true;
    setState('provider-error');
  }, []);

  return (
    <section aria-label={`Player for ${title.name}`} className="flex flex-col gap-3">
      <div className={cn('grid gap-3', partyPanelOpen && 'lg:grid-cols-[minmax(0,1fr)_22rem]')}>
        <div className="flex min-w-0 flex-col gap-3">
          <div className="relative aspect-video w-full overflow-hidden rounded-lg border border-border bg-black shadow-raised">
        {!hasSource ? (
          <UnavailablePanel
            message={unavailableMessage(error)}
            onRetry={handleRetry}
            onReport={handleReport}
            reportingAvailable={reportingAvailable}
            reportDisabled={reportDisabled}
          />
        ) : showConsent ? (
          <ConsentPanel providerName={providerName} onLoad={handleConsent} />
        ) : showAd ? (
          <PreRollAd
            adsterraKey={preroll!.adsterraKey}
            width={preroll!.width}
            height={preroll!.height}
            titleName={title.name}
            onDone={handleAdDone}
          />
        ) : !showPlayer ? (
          <PlayerLoadingOverlay />
        ) : playerFailed && nativeKind === null ? (
          <UnavailablePanel
            message="The selected source could not play. Retry or choose another source."
            onRetry={handleRetry}
            onReport={handleReport}
            reportingAvailable={reportingAvailable}
            reportDisabled={reportDisabled}
          />
        ) : (
          <>
            {state !== 'ready' && !playerFailed ? <PlayerLoadingOverlay /> : null}

            {nativeKind !== null ? (
              /* Lumora-hosted media: a real <video> element with native
                 controls, resume support, and honest position telemetry. */
              <PartyPortNativePlayer
                key={mediaScope}
                retryKey={reloadKey}
                source={{ url: activeSource!.url!, kind: nativeKind!, ...(activeSource?.streamCatalogUrl ? { streamCatalogUrl: activeSource.streamCatalogUrl } : {}) }}
                sources={displayedSources}
                selectedSourceId={activeSource?.id ?? null}
                onSelectSource={handleSelectSource}
                titleId={title.id}
                titleSlug={title.slug}
                titleName={title.name}
                viewerKey={viewerKey}
                adPolicy={adPolicy}
                introCatalogUrl={introCatalogUrl}
                subtitleCatalogUrl={subtitleCatalogUrl}
                episodeNavigation={episodeNavigation ?? undefined}
                episodeNavigationDisabled={episodeNavigationDisabled}
                episodeNavigationPending={episodeTransition === mediaScope}
                onNavigateEpisode={navigateEpisode}
                registerEpisodeTransition={registerEpisodeTransition}
                onContentEnded={handleContentEnded}
                {...(title.type === 'tv' ? { autoNext: autoNext && !episodeNavigationDisabled, onAutoNextChange: handleAutoNext } : {})}
                upNext={episodeNavigation?.next && !episodeNavigationDisabled ? {
                  name: [`S${episodeNavigation.next.seasonNumber} E${episodeNavigation.next.episodeNumber}`, episodeNavigation.next.name].filter(Boolean).join(' - '),
                  href: episodeNavigation.next.href,
                  ...(title.posterUrl ? { posterUrl: title.posterUrl } : {}),
                } : undefined}
                {...(resumeUpdatedAt !== undefined ? { resumeUpdatedAt } : {})}
                {...(title.posterUrl ? { posterUrl: title.posterUrl } : {})}
                {...(episodeId ? { episodeId } : {})}
                {...(seasonNumber !== undefined ? { seasonNumber } : {})}
                {...(episodeNumber !== undefined ? { episodeNumber } : {})}
                {...(initialPosition !== undefined ? { initialPosition } : {})}
                onReady={handleNativeReady}
                onError={handlePlaybackError}
                registerPartyPlayerPort={party.registerPlayerPort}
              />
            ) : (
              /*
                SECURITY / CSP — this external embed requires a CSP `frame-src`
                directive that allowlists the provider origin (from
                ProviderConfig.allowedDomains, e.g. `frame-src https://vsembed.su`).
                The global response headers (next.config.mjs) are owned elsewhere
                and are NOT edited here; they must add that directive for this
                iframe to load under a strict CSP.

                sandbox: intentionally ABSENT. The provider's player refuses to
                  run inside a sandboxed frame (it detects the attribute and
                  blocks playback with "This content can't be embedded in a
                  sandboxed frame"), and for a cross-origin embed the
                  `allow-scripts allow-same-origin` combination grants the embed
                  its own origin's full privileges anyway — it isolates nothing.
                  What actually constrains this iframe: the CSP `frame-src`
                  allowlist (only the provider's domain may be framed),
                  `frame-ancestors 'none'` on our pages, the server-side
                  `assertSafeUrl` host allowlist, and cross-origin isolation (its
                  scripts cannot touch our DOM or cookies regardless of sandbox).
                referrerPolicy: send only our origin cross-origin (supports the
                  provider's origin allowlisting without leaking the watch path).
                loading="eager": arriving at /watch IS the intentional play action,
                  so we do not lazy-load and delay playback.
              */
              <iframe
                key={`${activeSource!.id}-${reloadKey}`}
                src={activeSource!.url}
                title={`${title.name} — external video player (${providerName})`}
                className="absolute inset-0 h-full w-full border-0"
                referrerPolicy="strict-origin-when-cross-origin"
                allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
                allowFullScreen
                loading="eager"
                onLoad={() => { if (attemptRef.current === attemptKey) handleNativeReady(); }}
                onError={() => { if (attemptRef.current === attemptKey) handlePlaybackError(); }}
              />
            )}
            {playerFailed ? <div className="absolute inset-0 z-20 bg-black"><UnavailablePanel
              message="The selected source could not play. Your selections are unchanged. Retry or choose another source."
              onRetry={handleRetry}
              onReport={handleReport}
              reportingAvailable={reportingAvailable}
              reportDisabled={reportDisabled}
            /></div> : null}
          </>
        )}
          </div>

          <PlayerControlsBar
            backHref={`/title/${title.type}/${title.slug}`}
            backLabel={`Back to ${title.name} details`}
            sources={displayedSources}
            showSourceSelector={nativeKind === null || !showPlayer || playerFailed}
            selectedSourceId={activeSource?.id ?? null}
            onSelectSource={handleSelectSource}
            onReportIssue={handleReport}
            reported={reported}
            reportingAvailable={reportingAvailable}
            reportPending={reportPending}
            reportError={reportError}
            episodeNavigation={episodeNavigation ? { ...episodeNavigation, disabled: episodeNavigationDisabled,
              pending: episodeTransition === mediaScope, onNavigate: navigateEpisode } : undefined}
            watchParty={{
              available: party.available,
              active: Boolean(party.state.room),
              participantCount: party.state.participants.filter((participant) => participant.connected).length,
              onOpen: () => setPartyPanelOpen(true),
            }}
          />
        </div>

        <WatchPartyPanel
          open={partyPanelOpen}
          onClose={() => setPartyPanelOpen(false)}
          session={party}
          {...(initialPartyRoomCode ? { initialRoomCode: initialPartyRoomCode } : {})}
        />
      </div>

      {nativeKind ? (
        /* Native playback (Spec Section 9): Lumora-hosted media streamed from
           signed URLs — real telemetry, no third-party cookies or terms. */
        <p className="text-xs text-content-subtle">
          Playing on Lumora’s native player. Your progress is saved automatically while you watch.
        </p>
      ) : (
        /* Explicit external-provider labeling (Spec Section 9). */
        <p className="text-xs text-content-subtle">
          Played via {providerName}. Lumora does not host this video and cannot guarantee its availability.
        </p>
      )}
    </section>
  );
}

function PlayerLoadingOverlay() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-surface/70 backdrop-blur-sm"
    >
      <span
        aria-hidden="true"
        className="h-8 w-8 rounded-full border-2 border-border-strong border-t-primary animate-spin"
      />
      <span className="text-sm text-content-muted">Loading player…</span>
    </div>
  );
}

function ConsentPanel({ providerName, onLoad }: { providerName: string; onLoad: () => void }) {
  return (
    <div
      role="group"
      aria-label="External player consent"
      className="absolute inset-0 flex flex-col items-center justify-center gap-4 p-6 text-center"
    >
      <Badge tone="info">External player</Badge>
      <h2 className="text-lg font-semibold">Play with {providerName}?</h2>
      <p className="max-w-md text-sm text-content-muted">
        Playback is provided by {providerName}, an external service. Loading it may set the provider’s own
        cookies and is subject to their terms. Nothing loads until you choose to play.
      </p>
      <Button variant="primary" size="lg" onClick={onLoad}>
        <span aria-hidden="true">▶</span> Load external player
      </Button>
    </div>
  );
}

function UnavailablePanel({
  message,
  onRetry,
  onReport,
  reportingAvailable,
  reportDisabled,
}: {
  message: string;
  onRetry: () => void;
  onReport: () => void;
  reportingAvailable: boolean;
  reportDisabled: boolean;
}) {
  return (
    <div
      role="alert"
      className="absolute inset-0 flex flex-col items-center justify-center gap-4 p-6 text-center"
    >
      <div aria-hidden="true" className={cn('text-3xl', 'text-danger')}>
        ⚠
      </div>
      <h2 className="text-lg font-semibold">Playback currently unavailable</h2>
      <p className="max-w-md text-sm text-content-muted">{message}</p>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <Button variant="primary" onClick={onRetry}>
          Retry
        </Button>
        <Button variant="secondary" disabled={reportDisabled} onClick={() => { if (!reportDisabled) onReport(); }}>
          Report playback issue
        </Button>
      </div>
      {!reportingAvailable ? <p className="text-xs text-content-muted">Reporting unavailable</p> : null}
      <p className="text-xs text-content-subtle">
        You can also choose an alternate authorized source below when one is available.
      </p>
    </div>
  );
}
