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
 * TRACK SELECTORS (multi-quality / multi-audio / subtitles): hls.js parses the
 * master manifest's levels, audio tracks, and subtitle tracks once MANIFEST_PARSED
 * fires. For HLS sources we render a compact Quality / Audio / Subtitles selector
 * under the video and surface the chosen quality persistently per title. Native
 * HLS (Safari) and mp4/dash don't go through hls.js, so no selector is shown
 * there — the browser offers its own controls.
 *
 * HLS strategy: native HLS where the browser supports it (Safari), hls.js via
 * MSE elsewhere, and an honest "unsupported" state when neither works. DASH is
 * set as a direct src — native DASH playback is browser-limited and that is an
 * accepted v1 limitation (no dash.js integration yet).
 */

export interface NativePlayerProps {
  source: { url: string; kind: 'mp4' | 'hls' | 'dash' };
  titleId: string;
  /** Title slug — the guest (localStorage) fallback key + quality pref key. */
  titleSlug: string;
  episodeId?: string;
  /** TV only: season/episode numbers so the guest store can resume the spot. */
  seasonNumber?: number;
  episodeNumber?: number;
  /** Saved resume position (seconds), applied once after metadata loads. */
  initialPosition?: number;
  /** Fires when the media is ready to play (drives the shell's loading state). */
  onReady?: () => void;
  /** Fires on a fatal media error (drives the shell's unavailable state). */
  onError?: () => void;
}

/** Minimum seconds of playback between progress reports. */
const REPORT_INTERVAL_SECONDS = 5;
/** localStorage key prefix for the per-title quality preference. */
const QUALITY_PREF_PREFIX = 'lumora:pref:quality:';

function readQualityPref(titleSlug: string): number | null {
  try {
    const raw = localStorage.getItem(`${QUALITY_PREF_PREFIX}${titleSlug}`);
    const n = raw ? Number.parseInt(raw, 10) : NaN;
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function writeQualityPref(titleSlug: string, height: number): void {
  try {
    localStorage.setItem(`${QUALITY_PREF_PREFIX}${titleSlug}`, String(height));
  } catch {
    // Private mode — best effort.
  }
}

function clearQualityPref(titleSlug: string): void {
  try {
    localStorage.removeItem(`${QUALITY_PREF_PREFIX}${titleSlug}`);
  } catch {
    // Best effort.
  }
}

/** Compact option list for a native <select>. */
interface TrackOption {
  id: number;
  label: string;
}

export function NativePlayer({
  source,
  titleId,
  titleSlug,
  episodeId,
  seasonNumber,
  episodeNumber,
  initialPosition,
  onReady,
  onError,
}: NativePlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  // Guards that must apply exactly once per source mount.
  const resumedRef = useRef(false);
  const lastReportedRef = useRef(0);

  // hls.js instance + parsed track lists (only for MSE-based HLS playback).
  const hlsRef = useRef<Hls | null>(null);
  const [qualityLevels, setQualityLevels] = useState<TrackOption[]>([]);
  const [audioTracks, setAudioTracks] = useState<TrackOption[]>([]);
  const [subtitleTracks, setSubtitleTracks] = useState<TrackOption[]>([]);
  const [activeQuality, setActiveQuality] = useState(-1); // -1 = auto
  const [activeAudio, setActiveAudio] = useState(-1);
  const [activeSubtitle, setActiveSubtitle] = useState(-1); // -1 = off

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
          if (!result.ok)
            updateGuestPosition(titleSlug, positionSeconds, durationSeconds, {
              ...(episodeId ? { episodeId } : {}),
              ...(seasonNumber !== undefined ? { seasonNumber } : {}),
              ...(episodeNumber !== undefined ? { episodeNumber } : {}),
            });
        })
        .catch(() => {
          updateGuestPosition(titleSlug, positionSeconds, durationSeconds, {
            ...(episodeId ? { episodeId } : {}),
            ...(seasonNumber !== undefined ? { seasonNumber } : {}),
            ...(episodeNumber !== undefined ? { episodeNumber } : {}),
          });
        });
    },
    [titleId, titleSlug, episodeId, seasonNumber, episodeNumber],
  );

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    resumedRef.current = false;
    lastReportedRef.current = 0;
    setUnsupported(false);
    setQualityLevels([]);
    setAudioTracks([]);
    setSubtitleTracks([]);

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
        // Native HLS (Safari) — the browser owns quality controls.
        video.src = source.url;
      } else if (Hls.isSupported()) {
        // MSE-based playback everywhere else.
        hls = new Hls();
        hlsRef.current = hls;

        hls.on(Hls.Events.MANIFEST_PARSED, (_event, _data) => {
          setQualityLevels(
            hls!.levels.map((level, i) => ({
              id: i,
              label: level.height ? `${level.height}p` : `Level ${i + 1}`,
            })),
          );
          setAudioTracks(
            hls!.audioTracks.map((t) => ({ id: t.id, label: t.name || `Audio ${t.id}` })),
          );
          setSubtitleTracks(
            hls!.subtitleTracks.map((t) => ({ id: t.id, label: t.name || `Subtitle ${t.id}` })),
          );
          // Apply the persisted quality preference once levels are known.
          const pref = readQualityPref(titleSlug);
          if (pref != null) {
            const idx = hls!.levels.findIndex((l) => l.height === pref);
            if (idx >= 0) hls!.currentLevel = idx;
          }
          onReady?.();
        });
        hls.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => setActiveQuality(data.level));
        hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, (_event, data) => setActiveAudio(data.id));
        hls.on(Hls.Events.SUBTITLE_TRACK_SWITCH, (_event, data) => setActiveSubtitle(data.id));
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
      if (hls) {
        hls.destroy();
        hlsRef.current = null;
      }
      // Detach the media so a re-mount (server switch / retry) starts clean.
      video.pause();
      video.removeAttribute('src');
      video.load();
    };
  }, [source.url, source.kind, initialPosition, report, onReady, onError, titleSlug]);

  // Track selection handlers — operate on the live hls.js instance.
  const handleQualityChange = (i: number) => {
    const hls = hlsRef.current;
    if (!hls) return;
    hls.currentLevel = i;
    setActiveQuality(i);
    if (i < 0) {
      clearQualityPref(titleSlug);
    } else {
      const height = hls.levels[i]?.height;
      if (height) writeQualityPref(titleSlug, height);
    }
  };
  const handleAudioChange = (id: number) => {
    const hls = hlsRef.current;
    if (!hls) return;
    hls.audioTrack = id;
    setActiveAudio(id);
  };
  const handleSubtitleChange = (id: number) => {
    const hls = hlsRef.current;
    if (!hls) return;
    hls.subtitleTrack = id;
    setActiveSubtitle(id);
  };

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

  const showSelectors = source.kind === 'hls' && qualityLevels.length > 0;

  return (
    <div className="flex h-full w-full flex-col">
      <video
        ref={videoRef}
        controls
        playsInline
        preload="metadata"
        className="min-h-0 w-full flex-1 bg-black"
        aria-label="Video player"
      />
      {showSelectors ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border bg-surface/60 px-3 py-2 text-xs text-content-muted">
          <label className="flex items-center gap-1.5">
            Quality
            <select
              value={activeQuality}
              onChange={(e) => handleQualityChange(Number(e.target.value))}
              className="h-8 rounded border border-border bg-surface-raised px-1.5 text-xs text-content"
            >
              <option value={-1}>Auto</option>
              {qualityLevels.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>

          {audioTracks.length > 0 ? (
            <label className="flex items-center gap-1.5">
              Audio
              <select
                value={activeAudio}
                onChange={(e) => handleAudioChange(Number(e.target.value))}
                className="h-8 rounded border border-border bg-surface-raised px-1.5 text-xs text-content"
              >
                {audioTracks.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          {subtitleTracks.length > 0 ? (
            <label className="flex items-center gap-1.5">
              Subtitles
              <select
                value={activeSubtitle}
                onChange={(e) => handleSubtitleChange(Number(e.target.value))}
                className="h-8 rounded border border-border bg-surface-raised px-1.5 text-xs text-content"
              >
                <option value={-1}>Off</option>
                {subtitleTracks.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
