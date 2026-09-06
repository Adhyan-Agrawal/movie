'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import { reportProgressAction } from '@/features/playback/progress-actions';
import { updateGuestPosition } from '@/features/playback/guest-watch';

/**
 * Native HTML5 player (Spec Section 9) for Lumora-hosted mp4/hls/dash sources.
 *
 * Unlike the external embed this player owns real telemetry: timeupdate (throttled),
 * pause, and ended all report the TRUE position to watch_progress, which drives
 * resume and the continue-watching row. Guests (signed out) get the same feature
 * locally: when the server report has no session to attach to, the position is
 * written to this browser's guest store instead. Everything is fire-and-forget —
 * a failed report must never interrupt playback.
 *
 * HLS strategy: native HLS where the browser supports it (Safari), hls.js via
 * MSE elsewhere, and an honest "unsupported" state when neither works. DASH is
 * set as a direct src — native DASH playback is browser-limited and that is an
 * accepted v1 limitation (no dash.js integration yet).
 */

export interface NativePlayerProps {
  source: { url: string; kind: 'mp4' | 'hls' | 'dash' };
  titleId: string;
  /** Title slug — the guest (localStorage) fallback key. */
  titleSlug: string;
  episodeId?: string;
  /** Saved resume position (seconds), applied once after metadata loads. */
  initialPosition?: number;
  /** Fires when the media is ready to play (drives the shell's loading state). */
  onReady?: () => void;
  /** Fires on a fatal media error (drives the shell's unavailable state). */
  onError?: () => void;
}

/** Minimum seconds of playback between progress reports. */
const REPORT_INTERVAL_SECONDS = 5;

export function NativePlayer({
  source,
  titleId,
  titleSlug,
  episodeId,
  initialPosition,
  onReady,
  onError,
}: NativePlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  // Guards that must apply exactly once per source mount.
  const resumedRef = useRef(false);
  const lastReportedRef = useRef(0);

  // Report the current position; fire-and-forget, never throws into playback.
  // Signed-out viewers have no watch_progress row — their position goes to the
  // local guest store instead so their continue-watching row still works.
  const report = useCallback(
    (video: HTMLVideoElement) => {
      const positionSeconds = video.currentTime;
      const durationSeconds = Number.isFinite(video.duration) ? video.duration : undefined;
      void reportProgressAction({
        titleId,
        ...(episodeId ? { episodeId } : {}),
        positionSeconds,
        durationSeconds,
      })
        .then((result) => {
          if (!result.ok) updateGuestPosition(titleSlug, positionSeconds, durationSeconds);
        })
        .catch(() => {
          updateGuestPosition(titleSlug, positionSeconds, durationSeconds);
        });
    },
    [titleId, titleSlug, episodeId],
  );

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    resumedRef.current = false;
    lastReportedRef.current = 0;
    setUnsupported(false);

    const handleLoadedMetadata = () => {
      // Resume once: seek before playback begins, never on later metadata loads.
      if (!resumedRef.current && initialPosition !== undefined && initialPosition > 0) {
        resumedRef.current = true;
        video.currentTime = initialPosition;
      }
    };
    const handleTimeUpdate = () => {
      if (video.currentTime - lastReportedRef.current >= REPORT_INTERVAL_SECONDS) {
        lastReportedRef.current = video.currentTime;
        report(video);
      }
    };
    const handlePause = () => report(video);
    const handleEnded = () => {
      lastReportedRef.current = video.currentTime;
      report(video);
    };
    const handleCanPlay = () => onReady?.();
    const handleError = () => onError?.();

    video.addEventListener('loadedmetadata', handleLoadedMetadata);
    video.addEventListener('timeupdate', handleTimeUpdate);
    video.addEventListener('pause', handlePause);
    video.addEventListener('ended', handleEnded);
    video.addEventListener('canplay', handleCanPlay);
    video.addEventListener('error', handleError);

    let hls: Hls | null = null;
    if (source.kind === 'hls') {
      if (video.canPlayType('application/vnd.apple.mpegurl')) {
        // Native HLS (Safari).
        video.src = source.url;
      } else if (Hls.isSupported()) {
        // MSE-based playback everywhere else.
        hls = new Hls();
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (data.fatal) handleError();
        });
        hls.loadSource(source.url);
        hls.attachMedia(video);
      } else {
        // Neither native HLS nor MSE — say so honestly.
        setUnsupported(true);
      }
    } else {
      video.src = source.url;
    }

    return () => {
      video.removeEventListener('loadedmetadata', handleLoadedMetadata);
      video.removeEventListener('timeupdate', handleTimeUpdate);
      video.removeEventListener('pause', handlePause);
      video.removeEventListener('ended', handleEnded);
      video.removeEventListener('canplay', handleCanPlay);
      video.removeEventListener('error', handleError);
      if (hls) hls.destroy();
      // Detach the media so a re-mount (server switch / retry) starts clean.
      video.pause();
      video.removeAttribute('src');
      video.load();
    };
  }, [source.url, source.kind, initialPosition, report, onReady, onError]);

  if (unsupported) {
    return (
      <div
        role="alert"
        className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center"
      >
        <div aria-hidden="true" className="text-3xl text-danger">
          ⚠
        </div>
        <h2 className="text-lg font-semibold">Stream format not supported</h2>
        <p className="max-w-md text-sm text-content-muted">
          This browser cannot play this stream. Choose an alternate source below.
        </p>
      </div>
    );
  }

  return (
    <video
      ref={videoRef}
      controls
      playsInline
      preload="metadata"
      className="absolute inset-0 h-full w-full bg-black"
      aria-label="Video player"
    />
  );
}
