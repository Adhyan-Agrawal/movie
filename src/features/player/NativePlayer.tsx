'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type Player from 'video.js/dist/types/player';
import type { DirectStream, Quality } from '@/lib/providers/types';
import { reportProgressAction } from '@/features/playback/progress-actions';
import { readGuestEntries, updateGuestPosition } from '@/features/playback/guest-watch';
import { markPlaybackCheckpointSynced, playbackMediaKey, readPlaybackCheckpoint, writePlaybackCheckpoint, type PlaybackCheckpoint } from '@/features/playback/playback-checkpoint';
import { shiftedCueTiming } from './subtitle-timing';
import { aggregateStreamOptions, chooseStream, preferencesForStream, qualityKey, trackKey, type StreamPreferences, type StreamOption } from './stream-options';

export interface NativePlayerProps {
  source: { url: string; kind: 'mp4' | 'hls' | 'dash'; streamCatalogUrl?: string };
  titleId: string;
  titleSlug: string;
  titleName?: string;
  viewerKey?: string;
  resumeUpdatedAt?: number;
  episodeId?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  initialPosition?: number;
  posterUrl?: string;
  sources?: Array<{ id: string; label: string }>;
  selectedSourceId?: string | null;
  onSelectSource?: (id: string) => void;
  onReady?: () => void;
  onError?: () => void;
}

interface QualityLevel { id: string; width?: number; height?: number; bitrate?: number; enabled: boolean }
interface AudioTrack { id: string; label: string; language: string; enabled: boolean }
interface SubtitleTrack {
  id: string; label: string; language: string; kind: string; mode: TextTrackMode;
  cues: TextTrackCueList | null;
  addCue: (cue: TextTrackCue) => void;
  removeCue: (cue: TextTrackCue) => void;
}
interface EventList<T> {
  readonly length: number;
  readonly [index: number]: T | undefined;
  on: (event: string, listener: () => void) => void;
  off: (event: string, listener: () => void) => void;
}
type PlayerWithQualityLevels = Player & { qualityLevels: () => EventList<QualityLevel> };
type RemoteTrack = ReturnType<Player['addRemoteTextTrack']> & { track: SubtitleTrack };
interface PendingPosition { position: number; playing: boolean; rate: number }

const REPORT_INTERVAL_MS = 5000;
const QUALITY_PREF_PREFIX = 'lumora:pref:quality:';
const INITIAL_PREFERENCES: StreamPreferences = { quality: 'auto', audio: '', subtitle: 'off' };
const CONTROL_TARGETS = 'button, select, input, textarea, a, [role="button"], [role="slider"], .vjs-control-bar, .vjs-modal-dialog, [data-player-ui]';

function entries<T>(list: EventList<T>): T[] {
  const result: T[] = [];
  for (let index = 0; index < list.length; index += 1) if (list[index]) result.push(list[index]!);
  return result;
}

function readQualityPref(titleSlug: string): string {
  try {
    const height = Number(localStorage.getItem(`${QUALITY_PREF_PREFIX}${titleSlug}`));
    return Number.isInteger(height) && height > 0 ? `quality:${height}` : 'auto';
  } catch { return 'auto'; }
}

function storeQualityPref(titleSlug: string, id: string): void {
  try {
    if (id.startsWith('quality:')) localStorage.setItem(`${QUALITY_PREF_PREFIX}${titleSlug}`, id.slice(8));
    else localStorage.removeItem(`${QUALITY_PREF_PREFIX}${titleSlug}`);
  } catch { /* Preferences remain optional when storage is unavailable. */ }
}

function mimeType(kind: NativePlayerProps['source']['kind']): string {
  return kind === 'hls' ? 'application/x-mpegURL' : kind === 'dash' ? 'application/dash+xml' : 'video/mp4';
}

function renditionQuality(level: QualityLevel): Quality {
  return { id: String(level.id), label: level.height ? `${level.height}p` : `${Math.round((level.bitrate ?? 0) / 1000)} kbps`, width: level.width, height: level.height, bitrateKbps: level.bitrate ? level.bitrate / 1000 : undefined };
}

function formatTime(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor(value / 60) % 60;
  return `${hours ? `${hours}:` : ''}${hours ? String(minutes).padStart(2, '0') : minutes}:${String(value % 60).padStart(2, '0')}`;
}

function configureMediaElement(player: Player): void {
  const video = player.el().querySelector('video');
  if (!(video instanceof HTMLVideoElement)) return;
  try { (video as HTMLVideoElement & { controlsList?: { add: (...tokens: string[]) => void } }).controlsList?.add('nodownload', 'noremoteplayback'); } catch { /* Unsupported browser. */ }
  video.disablePictureInPicture = true;
  video.disableRemotePlayback = true;
  video.playsInline = true;
}

export function NativePlayer(props: NativePlayerProps) {
  const { source, titleId, titleSlug, titleName, episodeId, seasonNumber, episodeNumber, viewerKey = 'guest', sources = [], selectedSourceId, onSelectSource } = props;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<Player | null>(null);
  const latestProps = useRef(props);
  latestProps.current = props;
  const chooseRef = useRef<(field: keyof StreamPreferences, id: string) => void>(() => {});
  const delayRef = useRef<(offset: number) => void>(() => {});
  const [options, setOptions] = useState<{ qualities: StreamOption[]; audioTracks: StreamOption[]; subtitles: StreamOption[] }>({ qualities: [], audioTracks: [], subtitles: [] });
  const [preferences, setPreferences] = useState<StreamPreferences>(INITIAL_PREFERENCES);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [portalTarget, setPortalTarget] = useState<Element | null>(null);
  const [timingOffset, setTimingOffset] = useState(0);
  const [progress, setProgress] = useState({ position: 0, duration: 0 });
  const [switching, setSwitching] = useState(false);
  const [catalogStatus, setCatalogStatus] = useState<'loading' | 'ready' | 'unavailable'>('ready');
  const [selectionNotice, setSelectionNotice] = useState<string | null>(null);
  const [fastestAvailable, setFastestAvailable] = useState(false);
  const [seekFeedback, setSeekFeedback] = useState<{ side: 'left' | 'right'; sequence: number } | null>(null);
  const settingsId = useId();
  const settingsButtonRef = useRef<HTMLButtonElement | null>(null);
  const hasCoordinates = seasonNumber !== undefined && episodeNumber !== undefined;
  const mediaKey = playbackMediaKey(titleId, hasCoordinates ? undefined : episodeId, seasonNumber, episodeNumber);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    let player: Player | null = null;
    let detach = () => {};
    let flush = () => {};
    const abortController = new AbortController();
    const startProps = latestProps.current;
    let local = readPlaybackCheckpoint(viewerKey, mediaKey);
    if (!local && episodeId) local = readPlaybackCheckpoint(viewerKey, playbackMediaKey(titleId, episodeId));
    if (!local && viewerKey === 'guest') {
      const previous = readGuestEntries().find((entry) => entry.slug === titleSlug && (hasCoordinates
        ? entry.type === 'tv' && entry.seasonNumber === seasonNumber && entry.episodeNumber === episodeNumber
        : episodeId ? entry.type === 'tv' && entry.episodeId === episodeId : entry.type === 'movie'));
      if (previous?.positionSeconds !== undefined) local = { positionSeconds: previous.positionSeconds, updatedAt: previous.updatedAt };
    }
    const useLocal = Boolean(local && (local.pendingSync || local.updatedAt > (startProps.resumeUpdatedAt ?? 0)));
    const resumePosition = local && useLocal
      ? local.positionSeconds : Math.max(0, startProps.initialPosition ?? 0);
    if (local && useLocal) {
      writePlaybackCheckpoint(viewerKey, mediaKey, local.positionSeconds, local.durationSeconds, local.pendingSync ?? false);
    }
    let resumed = false;
    let sourceReady = false;
    let pendingPosition: PendingPosition | null = null;
    let currentUrl = source.url;
    let currentCatalogId = source.streamCatalogUrl ? new URL(source.url, window.location.href).searchParams.get('stream') ?? '0' : undefined;
    let catalog: DirectStream[] = [];
    let catalogPending = Boolean(source.streamCatalogUrl);
    let userSelected = false;
    let explicitAudio = false;
    let desired: StreamPreferences = { ...INITIAL_PREFERENCES, quality: readQualityPref(titleSlug) };
    let subtitleOffset = 0;
    let selectedSubtitle: SubtitleTrack | null = null;
    let presentation: SubtitleTrack | null = null;
    let presentationElement: RemoteTrack | null = null;
    let subtitleTimer: ReturnType<typeof setInterval> | undefined;
    const ownedTracks = new Set<SubtitleTrack>();
    const sidecars = new Map<string, RemoteTrack>();
    const clonedCues = new Map<TextTrackCue, { signature: string; cue: TextTrackCue }>();
    let feedbackTimer: ReturnType<typeof setTimeout> | undefined;
    let readyReported = false;
    let fatalReported = false;
    let switchTimer: ReturnType<typeof setTimeout> | undefined;
    const failedStreams = new Set<string>();
    setOptions({ qualities: [], audioTracks: [], subtitles: [] });
    setPreferences(desired); setSettingsOpen(false); setTimingOffset(0);
    setProgress({ position: resumePosition, duration: local?.durationSeconds ?? 0 });
    setSwitching(false); setSeekFeedback(null); setSelectionNotice(null); setFastestAvailable(false);
    setCatalogStatus(source.streamCatalogUrl ? 'loading' : 'ready');

    // React owns only this container. Video.js owns its imperative element, including fullscreen.
    const videoElement = document.createElement('video-js');
    videoElement.className = 'video-js lumora-videojs h-full w-full';
    videoElement.setAttribute('aria-label', startProps.titleName ? `Watch ${startProps.titleName}` : 'Video player');
    videoElement.setAttribute('controlslist', 'nodownload noremoteplayback');
    videoElement.setAttribute('disablepictureinpicture', '');
    videoElement.setAttribute('disableremoteplayback', '');
    container.appendChild(videoElement);

    const markReady = () => {
      if (cancelled || readyReported) return;
      readyReported = true;
      latestProps.current.onReady?.();
    };
    const reportFatal = () => {
      if (cancelled || fatalReported) return;
      fatalReported = true;
      latestProps.current.onError?.();
    };

    void import('video.js').then(({ default: createPlayer }) => {
      if (cancelled) return;
      const videoPlayer = createPlayer(videoElement, {
        controls: true, preload: 'auto', playsinline: true, responsive: true, fill: true,
        disablePictureInPicture: true,
        playbackRates: [0.5, 0.75, 1, 1.25, 1.5, 2],
        sources: [{ src: source.url, type: mimeType(source.kind) }],
        ...(startProps.posterUrl ? { poster: startProps.posterUrl } : {}),
        html5: {
          vhs: { overrideNative: true, limitRenditionByPlayerDimensions: false },
          ...(source.kind !== 'mp4' ? { nativeAudioTracks: false, nativeVideoTracks: false, nativeTextTracks: false } : {}),
        },
        userActions: { doubleClick: (event: MouseEvent) => {
          if (Date.now() < suppressClicksUntil || (event as MouseEvent & { sourceCapabilities?: { firesTouchEvents?: boolean } }).sourceCapabilities?.firesTouchEvents) return;
          if (videoPlayer.isFullscreen()) videoPlayer.exitFullscreen();
          else void videoPlayer.requestFullscreen();
        } },
        controlBar: { pictureInPictureToggle: false, subsCapsButton: false, audioTrackButton: false, skipButtons: { backward: 10, forward: 10 }, remainingTimeDisplay: false, currentTimeDisplay: true, timeDivider: true, durationDisplay: true },
      });
      player = videoPlayer;
      playerRef.current = videoPlayer;
      const playerElement = videoPlayer.el() as HTMLElement;
      setPortalTarget(playerElement);
      const qualityList = (videoPlayer as PlayerWithQualityLevels).qualityLevels();
      const audioList = videoPlayer.audioTracks() as unknown as EventList<AudioTrack>;
      const textList = videoPlayer.textTracks() as unknown as EventList<SubtitleTrack>;
      let lastFlushAt = Date.now();
      let lastRenderedSecond = -1;
      let lastDuration = -1;
      let reporting = false;
      let queuedReport: { positionSeconds: number; durationSeconds?: number; checkpoint: PlaybackCheckpoint | null } | null = null;
      let refreshQueued = false;
      let suppressClicksUntil = 0;

      const sendReports = async () => {
        if (reporting || !queuedReport) return;
        reporting = true;
        try {
          while (queuedReport) {
            const report = queuedReport;
            queuedReport = null;
            try {
              const result = await reportProgressAction({ titleId, ...(episodeId ? { episodeId } : {}), positionSeconds: report.positionSeconds, durationSeconds: report.durationSeconds, viewerKey });
              if (result.ok && report.checkpoint) markPlaybackCheckpointSynced(viewerKey, mediaKey, report.checkpoint);
            }
            catch { /* The scoped synchronous checkpoint survives server failures. */ }
          }
        } finally { reporting = false; }
      };
      flush = () => {
        if (videoPlayer.isDisposed() || !resumed || pendingPosition) return;
        const position = videoPlayer.currentTime();
        const duration = videoPlayer.duration();
        if (typeof position !== 'number' || !Number.isFinite(position)) return;
        const durationSeconds = typeof duration === 'number' && Number.isFinite(duration) && duration > 0 ? duration : undefined;
        const canReport = viewerKey.startsWith('account:') && Boolean(episodeId || (seasonNumber === undefined && episodeNumber === undefined));
        const checkpoint = writePlaybackCheckpoint(viewerKey, mediaKey, position, durationSeconds, canReport);
        lastFlushAt = Date.now();
        if (viewerKey === 'guest') {
          updateGuestPosition(titleSlug, position, durationSeconds, { episodeId, seasonNumber, episodeNumber });
        } else if (canReport) {
          queuedReport = { positionSeconds: position, durationSeconds, checkpoint };
          void sendReports();
        }
      };

      const clearPresentation = () => {
        if (presentation) {
          presentation.mode = 'disabled';
          for (const { cue } of clonedCues.values()) presentation.removeCue(cue);
        }
        clonedCues.clear();
      };
      const reconcileCues = () => {
        if (!selectedSubtitle || !presentation || selectedSubtitle.mode !== 'hidden') return;
        const cues = selectedSubtitle.cues;
        const now = videoPlayer.currentTime() ?? 0;
        const candidates = new Set<TextTrackCue>();
        if (cues?.length) {
          // HLS cues can accumulate for a whole film. Limit work to a bounded window around playback.
          let low = 0; let high = cues.length;
          while (low < high) {
            const middle = (low + high) >>> 1;
            if ((cues[middle]?.endTime ?? 0) + subtitleOffset < now - 120) low = middle + 1;
            else high = middle;
          }
          for (let index = low; index < cues.length && index < low + 600; index += 1) {
            const cue = cues[index] as VTTCue;
            if (cue.startTime + subtitleOffset > now + 180) break;
            const timing = shiftedCueTiming(cue.startTime, cue.endTime, subtitleOffset);
            if (!timing || typeof cue.text !== 'string') continue;
            candidates.add(cue);
            const signature = `${timing.startTime}|${timing.endTime}|${cue.text}|${cue.line}|${cue.position}|${cue.size}|${cue.align}|${cue.vertical}`;
            const previous = clonedCues.get(cue);
            if (previous?.signature === signature) continue;
            if (previous) presentation.removeCue(previous.cue);
            const Cue = window.VTTCue;
            if (!Cue) continue;
            const clone = new Cue(timing.startTime, timing.endTime, cue.text);
            clone.id = cue.id;
            clone.line = cue.line; clone.position = cue.position; clone.size = cue.size;
            clone.align = cue.align; clone.vertical = cue.vertical; clone.snapToLines = cue.snapToLines;
            if (cue.lineAlign) clone.lineAlign = cue.lineAlign;
            if (cue.positionAlign) clone.positionAlign = cue.positionAlign;
            if (cue.region) clone.region = cue.region;
            presentation.addCue(clone);
            clonedCues.set(cue, { signature, cue: clone });
          }
        }
        for (const [original, { cue }] of clonedCues) {
          if (!candidates.has(original)) { presentation.removeCue(cue); clonedCues.delete(original); }
        }
      };
      const ensurePresentation = () => {
        if (presentation) return;
        presentationElement = videoPlayer.addRemoteTextTrack({ kind: 'subtitles', label: 'Lumora subtitle presentation', language: 'und' }, true) as RemoteTrack;
        presentation = presentationElement.track as unknown as SubtitleTrack;
        ownedTracks.add(presentation);
      };
      const realTextTracks = () => entries(textList).filter((track) => !ownedTracks.has(track) && (track.kind === 'subtitles' || track.kind === 'captions'));
      const currentMetadata = () => catalog.find((stream) => stream.id === currentCatalogId) ?? catalog.find((stream) => stream.url === currentUrl);
      const runtimeStream = (): DirectStream => {
        const metadata = currentMetadata();
        return {
          id: metadata?.id ?? 'current', url: currentUrl,
          ...(metadata?.startupLatencyMs !== undefined ? { startupLatencyMs: metadata.startupLatencyMs } : {}),
          qualities: [...(metadata?.qualities ?? []), ...entries(qualityList).map(renditionQuality)],
          audioTracks: [...(metadata?.audioTracks ?? []), ...entries(audioList).map((track) => ({ id: track.id, label: track.label || track.language || 'Default audio', language: track.language, default: track.enabled }))],
          subtitles: [...(metadata?.subtitles ?? []), ...realTextTracks().map((track) => ({ id: track.id, label: track.label || track.language || 'Subtitles', language: track.language, kind: track.kind as 'subtitles' | 'captions' }))],
        };
      };
      const availableStreams = () => {
        const current = runtimeStream();
        return [...catalog.filter((stream) => stream.id !== current.id && stream.url !== currentUrl), current];
      };
      const updatePreferences = () => setPreferences({ ...desired });
      const installSidecars = () => {
        const stream = currentMetadata();
        for (const track of stream?.subtitles ?? []) {
          if (!track.url || sidecars.has(track.id) || realTextTracks().some((existing) => trackKey(existing) === trackKey(track))) continue;
          const element = videoPlayer.addRemoteTextTrack({ id: track.id, src: track.url, kind: track.kind, label: track.label, language: track.language, srclang: track.language, default: false }, true) as RemoteTrack;
          sidecars.set(track.id, element);
          element.addEventListener('load', scheduleRefresh);
        }
      };
      const applyChoices = () => {
        if (!sourceReady) return;
        const levels = entries(qualityList);
        const matching = levels.filter((level) => qualityKey(renditionQuality(level)) === desired.quality);
        if (desired.quality === 'auto' || matching.length) {
          for (const level of levels) {
            const enabled = desired.quality === 'auto' || matching.includes(level);
            if (level.enabled !== enabled) level.enabled = enabled;
          }
        }
        const audio = entries(audioList);
        const audioChoice = audio.find((track) => trackKey(track) === desired.audio);
        if (audioChoice) {
          for (const track of audio) if (track.enabled !== (track === audioChoice)) track.enabled = track === audioChoice;
        } else if (!desired.audio) {
          const active = audio.find((track) => track.enabled) ?? audio[0];
          if (active) { desired.audio = trackKey(active); updatePreferences(); }
        }
        const subtitles = realTextTracks();
        const subtitleChoice = desired.subtitle === 'off' ? null : subtitles.find((track) => trackKey(track) === desired.subtitle) ?? null;
        if (desired.subtitle !== 'off' && !subtitleChoice) return;
        if (subtitleChoice !== selectedSubtitle) {
          clearInterval(subtitleTimer);
          clearPresentation(); selectedSubtitle = subtitleChoice;
          // Reconcile late-arriving HLS/sidecar cues even while paused, without patching loader cues.
          if (selectedSubtitle) subtitleTimer = setInterval(reconcileCues, 250);
        }
        if (selectedSubtitle) ensurePresentation();
        for (const track of subtitles) {
          const mode = track === selectedSubtitle ? 'hidden' : 'disabled';
          if (track.mode !== mode) track.mode = mode;
        }
        if (presentation) {
          const mode = selectedSubtitle ? 'showing' : 'disabled';
          if (presentation.mode !== mode) presentation.mode = mode;
        }
        reconcileCues();
      };
      const refresh = () => {
        if (cancelled || videoPlayer.isDisposed()) return;
        const next = aggregateStreamOptions(availableStreams());
        setOptions((previous) => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
        installSidecars();
        applyChoices();
      };
      function scheduleRefresh() {
        if (refreshQueued || cancelled) return;
        refreshQueued = true;
        queueMicrotask(() => { refreshQueued = false; refresh(); });
      }
      const clearSidecars = () => {
        clearInterval(subtitleTimer);
        clearPresentation(); selectedSubtitle = null;
        if (presentationElement) videoPlayer.removeRemoteTextTrack(presentationElement);
        presentation = null; presentationElement = null; ownedTracks.clear();
        for (const element of sidecars.values()) {
          element.removeEventListener('load', scheduleRefresh);
          videoPlayer.removeRemoteTextTrack(element);
        }
        sidecars.clear();
      };
      const loadStream = (stream: DirectStream) => {
        if (stream.url === currentUrl) { applyChoices(); return; }
        flush();
        pendingPosition = pendingPosition ?? { position: resumed ? videoPlayer.currentTime() ?? 0 : resumePosition, playing: !videoPlayer.paused(), rate: videoPlayer.playbackRate() ?? 1 };
        sourceReady = false;
        clearSidecars();
        currentUrl = stream.url;
        currentCatalogId = stream.id;
        setSwitching(true);
        clearTimeout(switchTimer);
        switchTimer = setTimeout(handlePlaybackError, 15_000);
        videoPlayer.src({ src: currentUrl, type: 'application/x-mpegURL' });
        scheduleRefresh();
      };
      function handlePlaybackError() {
        if (cancelled || videoPlayer.isDisposed()) return;
        if (catalogPending) {
          if (!switchTimer) switchTimer = setTimeout(() => { catalogPending = false; handlePlaybackError(); }, 25_000);
          return;
        }
        failedStreams.add(currentUrl);
        const candidates = availableStreams().filter((stream) => stream.url !== currentUrl && !failedStreams.has(stream.url));
        const fallbackPreferences = { ...desired, quality: 'auto' };
        const fallback = chooseStream(candidates, desired, 'quality') ?? chooseStream(candidates, fallbackPreferences, 'quality');
        if (!fallback) { setSwitching(false); reportFatal(); return; }
        desired = preferencesForStream(fallback, desired);
        updatePreferences();
        setSelectionNotice('That stream could not play. Switched to another available source.');
        loadStream(fallback);
      }
      const choose = (field: keyof StreamPreferences, id: string, manual: boolean) => {
        if (cancelled || videoPlayer.isDisposed()) return;
        if (manual) { userSelected = true; if (field === 'audio') explicitAudio = true; }
        let next = { ...desired, [field]: id };
        if (field === 'quality' && id === 'auto' && !explicitAudio
          && !catalog.some((stream) => stream.audioTracks.some((track) => trackKey(track) === next.audio))) next = { ...next, audio: '' };
        const stream = chooseStream(availableStreams(), next, field, runtimeStream().id);
        if (!stream) return;
        desired = preferencesForStream(stream, next);
        setSelectionNotice((['quality', 'audio', 'subtitle'] as const).some((key) => key !== field && next[key] && next[key] !== desired[key])
          ? 'Some previous settings are unavailable with this option and were adjusted.' : null);
        updatePreferences();
        if (field === 'quality') storeQualityPref(titleSlug, desired.quality);
        loadStream(stream);
      };
      chooseRef.current = (field, id) => choose(field, id, true);
      delayRef.current = (offset) => {
        subtitleOffset = Math.min(10, Math.max(-10, Math.round(offset * 4) / 4));
        setTimingOffset(subtitleOffset);
        clearPresentation();
        if (presentation && selectedSubtitle) presentation.mode = 'showing';
        reconcileCues();
      };

      const updateProgress = () => {
        const position = pendingPosition?.position ?? videoPlayer.currentTime() ?? 0;
        const rawDuration = videoPlayer.duration();
        const duration = typeof rawDuration === 'number' && Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : 0;
        if (Math.floor(position) !== lastRenderedSecond || duration !== lastDuration) {
          lastRenderedSecond = Math.floor(position); lastDuration = duration;
          setProgress({ position, duration });
        }
      };
      const handleMetadata = () => {
        clearTimeout(switchTimer); switchTimer = undefined;
        sourceReady = true;
        installSidecars();
        const position = pendingPosition;
        if (position) {
          const duration = videoPlayer.duration();
          videoPlayer.currentTime(duration && Number.isFinite(duration) ? Math.min(position.position, Math.max(0, duration - 0.05)) : position.position);
          videoPlayer.playbackRate(position.rate);
          if (position.playing) void videoPlayer.play()?.catch(() => {});
          else videoPlayer.pause();
          pendingPosition = null;
          setSwitching(false);
        } else if (!resumed) {
          resumed = true;
          if (resumePosition > 0) {
            const duration = videoPlayer.duration();
            videoPlayer.currentTime(duration && Number.isFinite(duration) ? Math.min(resumePosition, Math.max(0, duration - 0.05)) : resumePosition);
          }
        }
        resumed = true;
        refresh(); updateProgress(); markReady();
      };
      const handleTimeUpdate = () => {
        if (cancelled) return;
        updateProgress();
        const now = Date.now();
        if (!videoPlayer.paused() && now - lastFlushAt >= REPORT_INTERVAL_MS) flush();
      };
      const handleSeeked = () => { reconcileCues(); updateProgress(); flush(); };
      const handleHidden = () => { if (document.visibilityState === 'hidden') flush(); };
      const handlePause = () => { if (!cancelled) flush(); };
      const handleSkip = (event: Event) => {
        const target = event.target as Element;
        if (target.closest('.vjs-skip-backward-10')) showSeek('left');
        else if (target.closest('.vjs-skip-forward-10')) showSeek('right');
      };
      const showSeek = (side: 'left' | 'right') => {
        setSeekFeedback((previous) => ({ side, sequence: (previous?.sequence ?? 0) + 1 }));
        clearTimeout(feedbackTimer);
        feedbackTimer = setTimeout(() => { if (!cancelled) setSeekFeedback(null); }, 750);
        videoPlayer.userActive(true);
      };
      let pointer: { id: number; x: number; y: number; at: number; moved: boolean } | null = null;
      let lastTap: { side: 'left' | 'right'; at: number; x: number; y: number } | null = null;
      const isControl = (target: EventTarget | null) => target instanceof Element && Boolean(target.closest(CONTROL_TARGETS));
      const handlePointerDown = (event: PointerEvent) => {
        if (event.pointerType !== 'touch') return;
        suppressClicksUntil = Date.now() + 700;
        if (!event.isPrimary || isControl(event.target)) { pointer = null; lastTap = null; return; }
        pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, at: Date.now(), moved: false };
      };
      const handlePointerMove = (event: PointerEvent) => {
        if (pointer?.id === event.pointerId && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 16) { pointer.moved = true; lastTap = null; }
      };
      const handlePointerCancel = () => { pointer = null; lastTap = null; };
      const handlePointerUp = (event: PointerEvent) => {
        const start = pointer;
        pointer = null;
        if (!start || start.id !== event.pointerId || start.moved || Date.now() - start.at > 300 || isControl(event.target) || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 16) { lastTap = null; return; }
        const bounds = playerElement.getBoundingClientRect();
        const relative = (event.clientX - bounds.left) / bounds.width;
        const side = relative < 0.38 ? 'left' : relative > 0.62 ? 'right' : null;
        if (!side) { lastTap = null; return; }
        const now = Date.now();
        if (lastTap && lastTap.side === side && now - lastTap.at <= 300 && Math.hypot(event.clientX - lastTap.x, event.clientY - lastTap.y) <= 48) {
          event.preventDefault();
          event.stopPropagation();
          const duration = videoPlayer.duration();
          const max = duration && Number.isFinite(duration) ? duration : Infinity;
          videoPlayer.currentTime(Math.max(0, Math.min(max, (videoPlayer.currentTime() ?? 0) + (side === 'left' ? -10 : 10))));
          showSeek(side); lastTap = null;
        } else lastTap = { side, at: now, x: event.clientX, y: event.clientY };
      };
      const blockTouchClick = (event: MouseEvent) => {
        if (Date.now() < suppressClicksUntil && !isControl(event.target)) { event.preventDefault(); event.stopPropagation(); }
      };
      for (const event of ['addqualitylevel', 'removequalitylevel', 'change']) qualityList.on(event, scheduleRefresh);
      for (const list of [audioList, textList]) for (const event of ['addtrack', 'removetrack', 'change']) list.on(event, scheduleRefresh);
      videoPlayer.on('loadedmetadata', handleMetadata);
      videoPlayer.on('loadeddata', scheduleRefresh);
      videoPlayer.on('durationchange', updateProgress);
      videoPlayer.on('timeupdate', handleTimeUpdate);
      videoPlayer.on('seeked', handleSeeked);
      videoPlayer.on('pause', handlePause);
      videoPlayer.on('ended', flush);
      videoPlayer.on('error', handlePlaybackError);
      document.addEventListener('visibilitychange', handleHidden);
      window.addEventListener('pagehide', flush);
      playerElement.addEventListener('pointerdown', handlePointerDown, true);
      playerElement.addEventListener('pointermove', handlePointerMove, true);
      playerElement.addEventListener('pointerup', handlePointerUp, true);
      playerElement.addEventListener('pointercancel', handlePointerCancel, true);
      playerElement.addEventListener('click', blockTouchClick, true);
      playerElement.addEventListener('dblclick', blockTouchClick, true);
      playerElement.addEventListener('click', handleSkip);
      detach = () => {
        clearTimeout(feedbackTimer);
        clearTimeout(switchTimer);
        for (const event of ['addqualitylevel', 'removequalitylevel', 'change']) qualityList.off(event, scheduleRefresh);
        for (const list of [audioList, textList]) for (const event of ['addtrack', 'removetrack', 'change']) list.off(event, scheduleRefresh);
        document.removeEventListener('visibilitychange', handleHidden);
        window.removeEventListener('pagehide', flush);
        playerElement.removeEventListener('pointerdown', handlePointerDown, true);
        playerElement.removeEventListener('pointermove', handlePointerMove, true);
        playerElement.removeEventListener('pointerup', handlePointerUp, true);
        playerElement.removeEventListener('pointercancel', handlePointerCancel, true);
        playerElement.removeEventListener('click', blockTouchClick, true);
        playerElement.removeEventListener('dblclick', blockTouchClick, true);
        playerElement.removeEventListener('click', handleSkip);
        clearSidecars();
      };
      configureMediaElement(videoPlayer);
      videoPlayer.ready(() => {
        if (cancelled || videoPlayer.isDisposed()) return;
        configureMediaElement(videoPlayer); scheduleRefresh(); markReady();
      });
      if (videoPlayer.readyState() >= 1) handleMetadata();

      // Catalog discovery never blocks creation/loading of the first M3U8.
      if (source.streamCatalogUrl) {
        void fetch(source.streamCatalogUrl, { signal: abortController.signal, credentials: 'same-origin' })
          .then(async (response) => {
            if (!response.ok) throw new Error('Stream catalog unavailable');
            return response.json() as Promise<{ streams: DirectStream[]; recommendedStreamId?: string }>;
          })
          .then((result) => {
            if (cancelled) return;
            catalog = Array.isArray(result.streams) ? result.streams.filter((stream) => stream && typeof stream.url === 'string' && Array.isArray(stream.qualities) && Array.isArray(stream.audioTracks) && Array.isArray(stream.subtitles)) : [];
            catalogPending = false;
            setFastestAvailable(catalog.some((stream) => Number.isFinite(stream.startupLatencyMs)));
            setCatalogStatus(catalog.length ? 'ready' : 'unavailable');
            refresh();
            if (videoPlayer.error()) { handlePlaybackError(); return; }
            if (!userSelected) {
              if (desired.quality !== 'auto' && !aggregateStreamOptions(catalog).qualities.some((quality) => quality.id === desired.quality)) {
                const savedHeight = Number(desired.quality.slice('quality:'.length));
                const legacy = catalog.flatMap((stream) => stream.qualities).find((quality) => quality.height === savedHeight);
                desired.quality = legacy ? qualityKey(legacy) : 'auto';
                updatePreferences();
              }
              choose('quality', desired.quality, false);
            }
          })
          .catch(() => {
            if (cancelled) return;
            catalogPending = false; setCatalogStatus('unavailable');
            if (videoPlayer.error()) handlePlaybackError();
          });
      }
    }).catch(reportFatal);

    return () => {
      flush();
      cancelled = true;
      abortController.abort();
      detach();
      chooseRef.current = () => {};
      delayRef.current = () => {};
      if (playerRef.current === player) playerRef.current = null;
      const disposedTarget = player?.el();
      setPortalTarget((current) => current === disposedTarget ? null : current);
      if (player && !player.isDisposed()) player.dispose();
      videoElement.remove();
    };
  }, [source.url, source.kind, source.streamCatalogUrl, titleId, titleSlug, episodeId, seasonNumber, episodeNumber, viewerKey, mediaKey, hasCoordinates]);

  useEffect(() => {
    if (!settingsOpen || !portalTarget) return;
    const handleOutside = (event: PointerEvent) => {
      if (event.target instanceof Element && !event.target.closest('[data-player-settings]')) setSettingsOpen(false);
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopPropagation();
      setSettingsOpen(false); settingsButtonRef.current?.focus();
    };
    document.addEventListener('pointerdown', handleOutside);
    portalTarget.addEventListener('keydown', handleEscape as EventListener);
    return () => {
      document.removeEventListener('pointerdown', handleOutside);
      portalTarget.removeEventListener('keydown', handleEscape as EventListener);
    };
  }, [settingsOpen, portalTarget]);

  const percentage = progress.duration > 0 ? Math.min(100, Math.max(0, progress.position / progress.duration * 100)) : null;
  const subtitlesAvailable = options.subtitles.length > 0;
  const audioAvailable = options.audioTracks.length > 0;

  return <div className="lumora-player-frame relative h-full w-full bg-black">
    <div ref={containerRef} data-vjs-player="" className="h-full w-full" onContextMenu={(event) => event.preventDefault()} />
    {portalTarget ? createPortal(<>
      <div className="lumora-player-heading" aria-hidden="true"><span className="lumora-player-eyebrow">Now Playing</span>{titleName ? <span className="lumora-player-title">{titleName}</span> : null}</div>
      <div className={`lumora-player-tools${settingsOpen ? ' is-open' : ''}`} data-player-ui="">
        <div className="lumora-player-progress" aria-label={`Watched ${formatTime(progress.position)} of ${progress.duration ? formatTime(progress.duration) : 'unknown duration'}${percentage !== null ? `, ${Math.round(percentage)} percent` : ''}`}>
          <span className="lumora-player-eyebrow">Watched</span><span className="lumora-player-clock">{formatTime(progress.position)}<span> / {progress.duration ? formatTime(progress.duration) : '--:--'}</span></span>
          <span className="lumora-player-percent">{percentage !== null ? `${Math.round(percentage)}%` : '--%'}</span>
        </div>
        <div className="lumora-player-settings-anchor" data-player-settings="">
          <button ref={settingsButtonRef} type="button" onClick={() => { setSettingsOpen((open) => !open); playerRef.current?.userActive(true); }} aria-expanded={settingsOpen} aria-controls={settingsId} className="lumora-player-settings-button"><SettingsIcon /><span>Settings</span></button>
          {settingsOpen ? <div id={settingsId} className="lumora-player-settings" role="region" aria-label="Playback settings">
            <div className="lumora-player-settings-heading"><span>Playback settings</span><span className="lumora-player-eyebrow">Fine Tune</span></div>
             <SettingsSelect label="Quality" value={preferences.quality} onChange={(id) => chooseRef.current('quality', id)}><option value="auto">{fastestAvailable ? 'Auto (fastest compatible)' : options.qualities.length ? 'Auto (adaptive)' : 'Original quality'}</option>{options.qualities.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</SettingsSelect>
            <SettingsSelect label="Audio" value={audioAvailable ? preferences.audio : 'unavailable'} disabled={options.audioTracks.length <= 1} status={options.audioTracks.length === 1 ? 'Single track' : !audioAvailable ? 'No alternate tracks reported' : undefined} onChange={(id) => chooseRef.current('audio', id)}>{audioAvailable ? options.audioTracks.map((track) => <option key={track.id} value={track.id}>{track.label}</option>) : <option value="unavailable">Default stream audio</option>}</SettingsSelect>
            <SettingsSelect label="Subtitles" value={preferences.subtitle} disabled={!subtitlesAvailable} status={!subtitlesAvailable ? 'No subtitles reported' : undefined} onChange={(id) => chooseRef.current('subtitle', id)}><option value="off">{subtitlesAvailable ? 'Off' : 'Unavailable'}</option>{options.subtitles.map((track) => <option key={track.id} value={track.id}>{track.label}</option>)}</SettingsSelect>
            <div className="lumora-subtitle-timing"><div><span>Subtitle timing</span><output aria-label="Subtitle timing offset">{timingOffset > 0 ? '+' : ''}{timingOffset.toFixed(2)}s</output></div><div className="lumora-subtitle-timing-controls"><button type="button" disabled={!subtitlesAvailable || preferences.subtitle === 'off' || timingOffset <= -10} aria-label="Advance subtitles by 0.25 seconds" onClick={() => delayRef.current(timingOffset - 0.25)}>-0.25s</button><button type="button" disabled={!subtitlesAvailable || timingOffset === 0} aria-label="Reset subtitle timing" onClick={() => delayRef.current(0)}>Reset</button><button type="button" disabled={!subtitlesAvailable || preferences.subtitle === 'off' || timingOffset >= 10} aria-label="Delay subtitles by 0.25 seconds" onClick={() => delayRef.current(timingOffset + 0.25)}>+0.25s</button></div><p>Negative: earlier. Positive: later.</p></div>
            {!source.streamCatalogUrl && sources.length > 1 && onSelectSource ? <SettingsSelect label="Playback fallback" value={selectedSourceId ?? sources[0]?.id ?? ''} onChange={onSelectSource}>{sources.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</SettingsSelect> : null}
             {catalogStatus !== 'ready' ? <p className="lumora-player-catalog-status" role="status">{catalogStatus === 'loading' ? 'Discovering available quality and language options...' : 'Some stream options could not be loaded. Current playback is unaffected.'}</p> : null}
             {selectionNotice ? <p className="lumora-player-catalog-status" role="status">{selectionNotice}</p> : null}
          </div> : null}
        </div>
      </div>
      {switching ? <div className="lumora-player-switch-status" role="status">Updating playback<span>Your position is preserved</span></div> : null}
      {seekFeedback ? <div key={seekFeedback.sequence} className={`lumora-player-seek-feedback is-${seekFeedback.side}`} role="status"><span aria-hidden="true">{seekFeedback.side === 'left' ? '-10' : '+10'}</span><span>{seekFeedback.side === 'left' ? 'Back' : 'Forward'} 10 seconds</span></div> : null}
    </>, portalTarget) : null}
  </div>;
}

function SettingsSelect({ label, value, onChange, disabled, status, children }: { label: string; value: string; onChange: (value: string) => void; disabled?: boolean; status?: string; children: React.ReactNode }) {
  return <label className="lumora-player-setting"><span>{label}{status ? <small>{status}</small> : null}</span><select aria-label={label} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>{children}</select></label>;
}

function SettingsIcon() {
  return <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M4 7h16M4 17h16" /><circle cx="9" cy="7" r="2.5" fill="currentColor" stroke="none" /><circle cx="15" cy="17" r="2.5" fill="currentColor" stroke="none" /></svg>;
}
