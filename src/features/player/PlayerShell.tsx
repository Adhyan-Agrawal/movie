'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { cn } from '@/lib/cn';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import type { PlaybackError, PlaybackSource } from '@/lib/providers/types';
import { type PlayerState, playerStateForError } from './player-states';
import { PlayerControlsBar } from './PlayerControlsBar';
import { PreRollAd } from '@/features/ads/PreRollAd';

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
 */

export interface PlayerShellProps {
  title: { name: string; slug: string; type: 'movie' | 'tv' };
  source: PlaybackSource | null;
  error?: PlaybackError | null;
  sources?: PlaybackSource[];
  providerLabel?: string;
  consentRequired?: boolean;
  /**
   * Pre-roll ad zone (Spec Section 11). Resolved server-side from env and
   * passed here — env vars are stripped from client bundles. Null = no pre-roll.
   */
  preroll?: { adsterraKey: string; width: number; height: number } | null;
}

/** SessionStorage marker so the pre-roll shows once per tab session. */
const PREROLL_SESSION_KEY = 'lumora:preroll-shown';

/**
 * TODO(playback-telemetry): iframe/embed providers do not emit reliable
 * heartbeat or completion events, so Lumora must persist its OWN watch-progress
 * (Spec Section 9 & the `watch_progress` table in Section 7). This is an
 * intentional no-op placeholder — wire it to the playback session/heartbeat API
 * (Section 14) once available. It must never scrape the iframe; position will
 * come from Lumora's own controls when native playback lands.
 */
function recordHeartbeat(_input: { positionSeconds?: number }): void {
  // no-op
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
  preroll = null,
}: PlayerShellProps) {
  const router = useRouter();

  const hasSource = Boolean(source?.url);
  const gate = consentRequired ?? source?.consentRequired ?? false;
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

  useEffect(() => {
    if (!preroll) return;
    try {
      if (sessionStorage.getItem(PREROLL_SESSION_KEY)) setAdDone(true);
    } catch {
      // Private mode — best effort only.
    }
  }, [preroll]);

  const showConsent = hasSource && gate && !consented;
  const showAd = hasSource && !showConsent && preroll !== null && !adDone;
  const showIframe = hasSource && (!gate || consented) && adDone;
  const iframeFailed = showIframe && state === 'provider-error';

  // Lumora-owned progress cadence — provider telemetry is unavailable.
  useEffect(() => {
    if (!showIframe || state !== 'ready') return;
    const interval = window.setInterval(() => recordHeartbeat({}), 30_000);
    return () => window.clearInterval(interval);
  }, [showIframe, state]);

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
    // Selecting a source (re)loads it. With one authorized source this reloads
    // the current one; it becomes a true switch when more providers exist.
    if (!id) return;
    setState('loading');
    setReloadKey((key) => key + 1);
  }

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
        ) : iframeFailed ? (
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

            {/*
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
            */}
            <iframe
              key={reloadKey}
              src={source!.url}
              title={`${title.name} — external video player (${providerName})`}
              className="absolute inset-0 h-full w-full border-0"
              referrerPolicy="strict-origin-when-cross-origin"
              allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
              allowFullScreen
              loading="eager"
              onLoad={() => setState('ready')}
              onError={() => setState('provider-error')}
            />
          </>
        )}
      </div>

      <PlayerControlsBar
        backHref={`/title/${title.type}/${title.slug}`}
        backLabel={`Back to ${title.name} details`}
        sources={sources}
        selectedSourceId={source?.id ?? null}
        onSelectSource={handleSelectSource}
        onReportIssue={handleReport}
        reported={reported}
      />

      {/* Explicit external-provider labeling (Spec Section 9). */}
      <p className="text-xs text-content-subtle">
        Played via {providerName}. Lumora does not host this video and cannot guarantee its availability.
      </p>
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
