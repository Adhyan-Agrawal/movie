'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { cn } from '@/lib/cn';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import type { PlaybackError, PlaybackSource } from '@/lib/providers/types';
import { type PlayerState, playerStateForError } from './player-states';
import { PlayerControlsBar } from './PlayerControlsBar';
import { NativePlayer } from './NativePlayer';
import { PreRollAd } from '@/features/ads/PreRollAd';
import { readConsent } from '@/components/consent/ConsentBanner';
import {
  reportPlaybackEndAction,
  reportPlaybackHeartbeatAction,
  reportPlaybackStartAction,
} from '@/features/playback/session-actions';
import { recordGuestWatch } from '@/features/playback/guest-watch';

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
  /** Saved resume position (seconds) forwarded to the native player. */
  initialPosition?: number;
  /**
   * Pre-roll ad zone (Spec Section 11). Resolved server-side from env and
   * passed here — env vars are stripped from client bundles. Null = no pre-roll.
   */
  preroll?: { adsterraKey: string; width: number; height: number } | null;
}

/** SessionStorage marker so the pre-roll shows once per tab session. */
const PREROLL_SESSION_KEY = 'lumora:preroll-shown';

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

/** Client stub for the "report playback issue" action (Spec Section 9 & 14).
 *  Records only safe diagnostics — never the iframe URL or any query/token. */
function reportPlaybackIssue(diagnostics: {
  providerId?: string;
  titleSlug: string;
  titleType: string;
  state: PlayerState;
}): void {
  // TODO(playback-report): POST to the playback report endpoint. Safe fields only.
  console.warn('playback.report', diagnostics);
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
  preroll = null,
}: PlayerShellProps) {
  const router = useRouter();

  const hasSource = Boolean(source?.url);
  // Active server: defaults to the highest-priority source; the selector
  // switches it. Falls back to the default when the selection disappears
  // (e.g. after a server-side re-resolution).
  const [activeSourceId, setActiveSourceId] = useState<string | null>(null);
  const activeSource = sources.find((s) => s.id === activeSourceId) ?? source;
  const activeHasUrl = Boolean(activeSource?.url);
  // Gate on the ACTIVE source (switching servers re-evaluates consent), with
  // the route-level prop as fallback.
  const gate = activeSource?.consentRequired ?? consentRequired ?? false;
  // Public label only — the upstream provider's real name never renders in the
  // public player (see the watch route's PUBLIC SOURCE LABELING note).
  const providerName = providerLabel ?? source?.label ?? 'Server 1';

  const [consented, setConsented] = useState(false);
  const [state, setState] = useState<PlayerState>('loading');
  const [reloadKey, setReloadKey] = useState(0);
  const [reported, setReported] = useState(false);
  // Pre-roll gate: no ad configured = already done. The session-once check
  // runs after mount (sessionStorage is not available during SSR) so the
  // initial render matches the server and hydration never mismatches.
  const [adDone, setAdDone] = useState(!preroll);
  // Advertising consent (Spec Section 15): the pre-roll only plays for viewers
  // who accepted ads in the consent banner; otherwise the video starts direct.
  const [adsConsent, setAdsConsent] = useState(false);

  useEffect(() => {
    try {
      setAdsConsent(Boolean(readConsent()?.ads));
    } catch {
      // Private mode — best effort only.
    }
  }, []);

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
  const showConsent = activeHasUrl && gate && !consented;
  const showAd = activeHasUrl && !showConsent && preroll !== null && !adDone && adsConsent;
  // The player surface (native or iframe) mounts only after the gates clear.
  const showPlayer = activeHasUrl && (!gate || consented) && adDone;
  // Native sources (Lumora-hosted mp4/hls/dash) render <video> instead of an
  // embed iframe — same surface, same gates, real telemetry.
  const nativeKind =
    activeSource && activeSource.url
      ? activeSource.kind === 'mp4' || activeSource.kind === 'hls' || activeSource.kind === 'dash'
        ? activeSource.kind
        : null
      : null;
  const showNative = showPlayer && nativeKind !== null;
  const playerFailed = showPlayer && state === 'provider-error';

  // Pre-roll safety net: if the creative never calls onDone (blocked zone, ad
  // network failure), auto-continue to the video after 8s. Otherwise a broken
  // ad would strand the player behind the gate forever — and with it the guest
  // continue-watching recording that only happens once the player mounts.
  useEffect(() => {
    if (!showAd) return;
    const timer = window.setTimeout(() => {
      try {
        sessionStorage.setItem(PREROLL_SESSION_KEY, '1');
      } catch {
        // Private mode — best effort only.
      }
      setAdDone(true);
      setState('loading');
    }, 8000);
    return () => window.clearTimeout(timer);
  }, [showAd]);

  // Lumora-owned session recording — provider telemetry is unavailable.
  const sessionIdRef = useRef<string | null>(null);
  const [sessionReady, setSessionReady] = useState(false);

  // Overlay safety net: the "Loading player…" overlay only clears on the
  // iframe's onLoad. Providers that render a blank/slow document never fire
  // it, leaving a stuck spinner over a working (or blank) player. Clear the
  // overlay after 12s no matter what — the iframe is present either way and
  // the server switcher recovers a bad provider.
  useEffect(() => {
    if (!showPlayer) return;
    const timer = window.setTimeout(() => {
      setState((s) => (s === 'loading' ? 'ready' : s));
    }, 12_000);
    return () => window.clearTimeout(timer);
  }, [showPlayer, reloadKey, activeSourceId]);

  useEffect(() => {
    if (!showPlayer) return;
    // One session row per player mount (reloadKey re-mounts count as replays).
    let cancelled = false;
    sessionIdRef.current = null;
    void reportPlaybackStartAction(title.id, episodeId).then((r) => {
      if (cancelled) return;
      if (r.ok && r.sessionId) {
        sessionIdRef.current = r.sessionId;
        setSessionReady(true);
      } else {
        // Guest (no session): record the watch in THIS browser's local guest
        // store so their continue-watching row works too — never another
        // user's data (signed-in rows live server-side under RLS).
        recordGuestWatch({
          slug: title.slug,
          type: title.type,
          name: title.name,
          ...(title.posterUrl ? { posterUrl: title.posterUrl } : {}),
          ...(episodeId ? { episodeId } : {}),
          ...(seasonNumber !== undefined ? { seasonNumber } : {}),
          ...(episodeNumber !== undefined ? { episodeNumber } : {}),
        });
      }
    });
    return () => {
      cancelled = true;
      const id = sessionIdRef.current;
      if (id) void reportPlaybackEndAction(id);
      sessionIdRef.current = null;
      setSessionReady(false);
    };
  }, [showPlayer, reloadKey, title.id, title.slug, title.type, title.name, title.posterUrl, episodeId]);

  useEffect(() => {
    if (!showPlayer || !sessionReady) return;
    const id = sessionIdRef.current;
    if (!id) return;
    recordHeartbeat(id); // first beat at mount
    const interval = window.setInterval(() => recordHeartbeat(id), 30_000);
    return () => window.clearInterval(interval);
  }, [showPlayer, sessionReady]);

  function handleConsent() {
    setConsented(true);
    setState('loading');
  }

  function handleRetry() {
    setReported(false);
    if (hasSource) {
      // Re-mount the iframe (fresh load) without a full navigation.
      setState('loading');
      setReloadKey((key) => key + 1);
    } else {
      // Nothing resolved server-side — re-run resolution.
      router.refresh();
    }
  }

  function handleReport() {
    setReported(true);
    reportPlaybackIssue({
      providerId: source?.providerId,
      titleSlug: title.slug,
      titleType: title.type,
      state: hasSource ? state : error ? playerStateForError(error.code) : 'blocked',
    });
  }

  function handleSelectSource(id: string) {
    // Switching servers: the active source changes and the player re-mounts
    // (fresh load) with the newly selected source's URL.
    if (!id) return;
    setActiveSourceId(id);
    setState('loading');
    setReloadKey((key) => key + 1);
  }

  // Stable callbacks: NativePlayer's media effect depends on these, so they
  // must not change identity across renders (a new function would reload the
  // video from scratch on every parent render).
  const handleNativeReady = useCallback(() => setState('ready'), []);
  const handleNativeError = useCallback(() => setState('provider-error'), []);

  return (
    <section aria-label={`Player for ${title.name}`} className="flex flex-col gap-3">
      <div className="relative aspect-video w-full overflow-hidden rounded-lg border border-border bg-black shadow-raised">
        {!hasSource ? (
          <UnavailablePanel
            message={unavailableMessage(error)}
            onRetry={handleRetry}
            onReport={handleReport}
          />
        ) : showConsent ? (
          <ConsentPanel providerName={providerName} onLoad={handleConsent} />
        ) : showAd ? (
          <PreRollAd
            adsterraKey={preroll!.adsterraKey}
            width={preroll!.width}
            height={preroll!.height}
            titleName={title.name}
            onDone={() => {
              try {
                sessionStorage.setItem(PREROLL_SESSION_KEY, '1');
              } catch {
                // Private mode — best effort only.
              }
              setAdDone(true);
              setState('loading');
            }}
          />
        ) : playerFailed ? (
          <UnavailablePanel
            message={unavailableMessage({ code: 'provider-error', message: '', recoverable: true })}
            onRetry={handleRetry}
            onReport={handleReport}
          />
        ) : (
          <>
            {state !== 'ready' ? (
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
            ) : null}

            {showNative ? (
              /* Lumora-hosted media: a real <video> element with native
                 controls, resume support, and honest position telemetry. */
              <NativePlayer
                key={`${activeSource!.id}-${reloadKey}`}
                source={{ url: activeSource!.url!, kind: nativeKind! }}
                titleId={title.id}
                titleSlug={title.slug}
                {...(episodeId ? { episodeId } : {})}
                {...(seasonNumber !== undefined ? { seasonNumber } : {})}
                {...(episodeNumber !== undefined ? { episodeNumber } : {})}
                {...(initialPosition !== undefined ? { initialPosition } : {})}
                onReady={handleNativeReady}
                onError={handleNativeError}
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
                onLoad={() => setState('ready')}
                onError={() => setState('provider-error')}
              />
            )}
          </>
        )}
      </div>

      <PlayerControlsBar        backHref={`/title/${title.type}/${title.slug}`}
        backLabel={`Back to ${title.name} details`}
        sources={sources}
        selectedSourceId={activeSource?.id ?? null}
        onSelectSource={handleSelectSource}
        onReportIssue={handleReport}
        reported={reported}
      />

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
}: {
  message: string;
  onRetry: () => void;
  onReport: () => void;
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
        <Button variant="secondary" onClick={onReport}>
          Report playback issue
        </Button>
      </div>
      <p className="text-xs text-content-subtle">
        You can also choose an alternate authorized source below when one is available.
      </p>
    </div>
  );
}
