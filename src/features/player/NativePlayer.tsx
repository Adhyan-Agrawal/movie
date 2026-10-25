'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type Player from 'video.js/dist/types/player';
import type { DirectStream, Quality, Track } from '@/lib/providers/types';
import { reportProgressAction } from '@/features/playback/progress-actions';
import { readGuestEntries, updateGuestPosition } from '@/features/playback/guest-watch';
import { markPlaybackCheckpointSynced, playbackMediaKey, readPlaybackCheckpoint, writePlaybackCheckpoint, type PlaybackCheckpoint } from '@/features/playback/playback-checkpoint';
import { shiftedCueTiming } from './subtitle-timing';
import { requestCasting, type CastingHandle, type CastingProgress } from './casting';
import { aggregateStreamOptions, chooseStream, preferencesForStream, qualityKey, trackKey, type StreamPreferences, type StreamOption } from './stream-options';

export interface NativePlayerProps {
  source: { url: string; kind: 'mp4' | 'hls' | 'dash'; streamCatalogUrl?: string };
  subtitleCatalogUrl?: string;
  upNext?: { name: string; href: string; posterUrl?: string };
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
  try { (video as HTMLVideoElement & { controlsList?: { add: (...tokens: string[]) => void } }).controlsList?.add('nodownload'); } catch { /* Unsupported browser. */ }
  video.disablePictureInPicture = true;
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
  const [activePanel, setActivePanel] = useState<'quality' | 'audio' | 'subtitles' | 'settings' | null>(null);
  const [portalTarget, setPortalTarget] = useState<Element | null>(null);
  const [timingOffset, setTimingOffset] = useState(0);
  const [progress, setProgress] = useState({ position: 0, duration: 0 });
  const [switching, setSwitching] = useState(false);
  const [catalogStatus, setCatalogStatus] = useState<'loading' | 'ready' | 'unavailable'>('ready');
  const [selectionNotice, setSelectionNotice] = useState<string | null>(null);
  const [fastestAvailable, setFastestAvailable] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [seekFeedback, setSeekFeedback] = useState<{ side: 'left' | 'right'; sequence: number } | null>(null);
  const settingsId = useId();
  const panelButtonRef = useRef<HTMLButtonElement | null>(null);
  const speedRef = useRef<(rate: number) => void>(() => {});
  const castActionRef = useRef<() => void>(() => {});
  const castCommandRef = useRef<(command: 'play' | 'pause' | 'back' | 'forward') => void>(() => {});
  const [castStatus, setCastStatus] = useState<{ state: 'idle' | 'connecting' | 'connected' | 'error'; message?: string }>({ state: 'idle' });
  const [remoteProgress, setRemoteProgress] = useState<CastingProgress | null>(null);
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
    let localNeedsMigration = false;
    if (!local && episodeId) {
      local = readPlaybackCheckpoint(viewerKey, playbackMediaKey(titleId, episodeId));
      localNeedsMigration = Boolean(local);
    }
    if (!local && viewerKey === 'guest') {
      const previous = readGuestEntries().find((entry) => entry.slug === titleSlug && (hasCoordinates
        ? entry.type === 'tv' && entry.seasonNumber === seasonNumber && entry.episodeNumber === episodeNumber
        : episodeId ? entry.type === 'tv' && entry.episodeId === episodeId : entry.type === 'movie'));
      if (previous?.positionSeconds !== undefined) {
        local = { positionSeconds: previous.positionSeconds, updatedAt: previous.updatedAt };
        localNeedsMigration = true;
      }
    }
    const useLocal = Boolean(local && (local.pendingSync || local.updatedAt > (startProps.resumeUpdatedAt ?? 0)));
    const resumePosition = local && useLocal
      ? local.positionSeconds : Math.max(0, startProps.initialPosition ?? 0);
    if (local && useLocal && localNeedsMigration) {
      writePlaybackCheckpoint(viewerKey, mediaKey, local.positionSeconds, local.durationSeconds, local.pendingSync ?? false, local.updatedAt);
    }
    let resumed = false;
    let sourceReady = false;
    let pendingPosition: PendingPosition | null = null;
    let currentUrl = source.url;
    let currentCatalogId = source.streamCatalogUrl ? new URL(source.url, window.location.href).searchParams.get('stream') ?? '0' : undefined;
    let catalog: DirectStream[] = [];
    let externalSubtitles: Track[] = [];
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
    let castHandle: CastingHandle | null = null;
    let lastRemote: CastingProgress | null = null;
    let lastCastReportAt = 0;
    const failedStreams = new Set<string>();
    setOptions({ qualities: [], audioTracks: [], subtitles: [] });
    setPreferences(desired); setActivePanel(null); setTimingOffset(0); setPlaybackRate(1);
    setProgress({ position: resumePosition, duration: local?.durationSeconds ?? 0 });
    setSwitching(false); setSeekFeedback(null); setSelectionNotice(null); setFastestAvailable(false); setCastStatus({ state: 'idle' }); setRemoteProgress(null);
    setCatalogStatus(source.streamCatalogUrl ? 'loading' : 'ready');

    // React owns only this container. Video.js owns its imperative element, including fullscreen.
    const videoElement = document.createElement('video-js');
    videoElement.className = 'video-js lumora-videojs h-full w-full';
    videoElement.setAttribute('aria-label', startProps.titleName ? `Watch ${startProps.titleName}` : 'Video player');
    videoElement.setAttribute('controlslist', 'nodownload');
    videoElement.setAttribute('disablepictureinpicture', '');
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
        const position = castHandle && lastRemote ? lastRemote.positionSeconds : videoPlayer.currentTime();
        const duration = castHandle && lastRemote ? lastRemote.durationSeconds : videoPlayer.duration();
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
          // Loader cues can overlap and arrive out of order, so do not binary-search their native list.
          for (let index = 0; index < cues.length && index < 20_000; index += 1) {
            const cue = cues[index] as VTTCue;
            if (cue.endTime + subtitleOffset < now - 120 || cue.startTime + subtitleOffset > now + 180) continue;
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
          audioTracks: metadata?.audioTracks.length ? metadata.audioTracks : entries(audioList).map((track) => ({ id: track.id, label: track.label || track.language || 'Default audio', language: track.language, default: track.enabled })),
          subtitles: [...(metadata?.subtitles ?? []), ...externalSubtitles, ...realTextTracks().map((track) => ({ id: track.id, label: track.label || track.language || 'Subtitles', language: track.language, kind: track.kind as 'subtitles' | 'captions' }))],
        };
      };
      const availableStreams = () => {
        const current = runtimeStream();
        return [...catalog.filter((stream) => stream.id !== current.id && stream.url !== currentUrl)
          .map((stream) => ({ ...stream, subtitles: [...stream.subtitles, ...externalSubtitles] })), current];
      };
      const updatePreferences = () => setPreferences({ ...desired });
      const installSidecars = () => {
        const stream = currentMetadata();
        const candidate = [...(stream?.subtitles ?? []), ...externalSubtitles]
          .find((track) => track.url && trackKey(track) === desired.subtitle);
        for (const [key, element] of sidecars) {
          if (candidate && key === trackKey(candidate)) continue;
          element.removeEventListener('load', scheduleRefresh);
          videoPlayer.removeRemoteTextTrack(element);
          sidecars.delete(key);
        }
        for (const track of candidate ? [candidate] : []) {
          const key = trackKey(track);
          if (!track.url || sidecars.has(key) || realTextTracks().some((existing) => trackKey(existing) === key)) continue;
          const element = videoPlayer.addRemoteTextTrack({ id: track.id, src: track.url, kind: track.kind, label: track.label, language: track.language, srclang: track.language, default: false }, true) as RemoteTrack;
          sidecars.set(key, element);
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
          if (selectedSubtitle) subtitleTimer = setInterval(reconcileCues, 750);
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
        if (stream.url === currentUrl) { installSidecars(); applyChoices(); return; }
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
      speedRef.current = (rate) => {
        if (![0.5, 0.75, 1, 1.25, 1.5, 2].includes(rate)) return;
        videoPlayer.playbackRate(rate);
        setPlaybackRate(rate);
      };
      const saveRemote = (remote: CastingProgress, force = false) => {
        lastRemote = remote;
        setRemoteProgress(remote);
        setProgress({ position: remote.positionSeconds, duration: remote.durationSeconds ?? 0 });
        const now = Date.now();
        if (!force && now - lastCastReportAt < 5_000) return;
        lastCastReportAt = now;
        const canReport = viewerKey.startsWith('account:') && Boolean(episodeId || (seasonNumber === undefined && episodeNumber === undefined));
        const checkpoint = writePlaybackCheckpoint(viewerKey, mediaKey, remote.positionSeconds, remote.durationSeconds, canReport);
        if (viewerKey === 'guest') {
          updateGuestPosition(titleSlug, remote.positionSeconds, remote.durationSeconds, { episodeId, seasonNumber, episodeNumber });
        } else if (canReport) {
          queuedReport = { positionSeconds: remote.positionSeconds, durationSeconds: remote.durationSeconds, checkpoint };
          void sendReports();
        }
      };
      const restoreLocal = () => {
        videoPlayer.controls(true);
        if (!lastRemote) return;
        videoPlayer.currentTime(lastRemote.positionSeconds);
        if (lastRemote.paused) videoPlayer.pause();
        else void videoPlayer.play()?.catch(() => {});
        setProgress({ position: lastRemote.positionSeconds, duration: lastRemote.durationSeconds ?? 0 });
      };
      const disconnectCast = (stop: boolean) => {
        if (lastRemote) saveRemote(lastRemote, true);
        const handle = castHandle;
        castHandle = null;
        if (stop) handle?.stop(); else handle?.dispose();
        restoreLocal();
        setRemoteProgress(null);
        setCastStatus({ state: 'idle' });
      };
      castActionRef.current = () => {
        if (castHandle) {
          disconnectCast(true);
          return;
        }
        const mediaElement = videoPlayer.el().querySelector('video');
        if (!(mediaElement instanceof HTMLVideoElement)) return;
        const castSource = currentUrl;
        setCastStatus({ state: 'connecting', message: 'Choose a device' });
        void requestCasting(mediaElement, {
          url: castSource, contentType: mimeType(source.kind),
          resolveUrl: async () => {
            const target = new URL(castSource, window.location.href);
            if (target.origin !== window.location.origin || target.pathname !== '/api/vidnest') return target.href;
            target.searchParams.set('cast', '1');
            const response = await fetch(target, { credentials: 'same-origin', cache: 'no-store' });
            if (!response.ok) throw new Error('Cast playback is temporarily unavailable.');
            const body = await response.json() as { url?: string };
            if (!body.url) throw new Error('Cast playback is temporarily unavailable.');
            const capability = new URL(body.url, window.location.href);
            if (capability.origin !== window.location.origin || capability.pathname !== '/api/vidnest' || !capability.searchParams.has('token')) {
              throw new Error('Invalid Cast playback capability.');
            }
            return capability.href;
          },
          ...(titleName ? { title: titleName } : {}),
          ...(startProps.posterUrl ? { posterUrl: startProps.posterUrl } : {}),
          positionSeconds: videoPlayer.currentTime() ?? 0, autoplay: !videoPlayer.paused(),
          ...(() => {
            const track = externalSubtitles.find((candidate) => candidate.url && trackKey(candidate) === desired.subtitle);
            return track?.url ? { subtitle: { url: track.url, label: track.label, ...(track.language ? { language: track.language } : {}) } } : {};
          })(),
        }, (remote) => saveRemote(remote), () => disconnectCast(false))
          .then((handle) => {
            if (cancelled || videoPlayer.isDisposed()) { handle?.dispose(); return; }
            if (!handle) { setCastStatus({ state: 'idle', message: 'Device picker opened' }); return; }
            castHandle = handle;
            videoPlayer.pause();
            videoPlayer.controls(false);
            setActivePanel(null);
            setCastStatus({ state: 'connected', message: handle.deviceName });
          })
          .catch((error: unknown) => setCastStatus({ state: 'error', message: error instanceof Error ? error.message : 'Casting could not start.' }));
      };
      castCommandRef.current = (command) => {
        if (!castHandle || !lastRemote) return;
        if (command === 'play') void castHandle.play();
        else if (command === 'pause') void castHandle.pause();
        else void castHandle.seek(Math.max(0, lastRemote.positionSeconds + (command === 'back' ? -10 : 10)));
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
      videoPlayer.on('ratechange', () => setPlaybackRate(videoPlayer.playbackRate() ?? 1));
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
        if (lastRemote) saveRemote(lastRemote, true);
        castHandle?.dispose(); castHandle = null;
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
              if (desired.quality !== 'auto' || catalog.some((stream) => Number.isFinite(stream.startupLatencyMs))) {
                choose('quality', desired.quality, false);
              }
            }
          })
          .catch(() => {
            if (cancelled) return;
            catalogPending = false; setCatalogStatus('unavailable');
            if (videoPlayer.error()) handlePlaybackError();
          });
      }
      if (startProps.subtitleCatalogUrl) {
        void fetch(startProps.subtitleCatalogUrl, { signal: abortController.signal, credentials: 'same-origin' })
          .then(async (response) => response.ok ? response.json() as Promise<{ tracks?: Track[] }> : { tracks: [] })
          .then((result) => {
            if (cancelled) return;
            externalSubtitles = Array.isArray(result.tracks) ? result.tracks.filter((track) => track
              && typeof track.id === 'string' && typeof track.label === 'string' && typeof track.url === 'string'
              && (track.kind === 'subtitles' || track.kind === 'captions')) : [];
            refresh();
          }).catch(() => undefined);
      }
    }).catch(reportFatal);

    return () => {
      flush();
      cancelled = true;
      abortController.abort();
      detach();
      chooseRef.current = () => {};
      delayRef.current = () => {};
      speedRef.current = () => {};
      castActionRef.current = () => {};
      castCommandRef.current = () => {};
      if (playerRef.current === player) playerRef.current = null;
      const disposedTarget = player?.el();
      setPortalTarget((current) => current === disposedTarget ? null : current);
      if (player && !player.isDisposed()) player.dispose();
      videoElement.remove();
    };
  }, [source.url, source.kind, source.streamCatalogUrl, props.subtitleCatalogUrl, titleId, titleSlug, titleName, episodeId, seasonNumber, episodeNumber, viewerKey, mediaKey, hasCoordinates]);

  useEffect(() => {
    if (!activePanel || !portalTarget) return;
    const handleOutside = (event: PointerEvent) => {
      if (event.target instanceof Element && !event.target.closest('[data-player-settings]')) setActivePanel(null);
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopPropagation();
      setActivePanel(null); panelButtonRef.current?.focus();
    };
    document.addEventListener('pointerdown', handleOutside);
    portalTarget.addEventListener('keydown', handleEscape as EventListener);
    return () => {
      document.removeEventListener('pointerdown', handleOutside);
      portalTarget.removeEventListener('keydown', handleEscape as EventListener);
    };
  }, [activePanel, portalTarget]);

  const percentage = progress.duration > 0 ? Math.min(100, Math.max(0, progress.position / progress.duration * 100)) : null;
  const subtitlesAvailable = options.subtitles.length > 0;
  const audioAvailable = options.audioTracks.length > 0;
  const upNextVisible = Boolean(props.upNext && progress.duration > 0 && progress.position >= progress.duration * 0.9 && progress.duration - progress.position <= 90);
  const togglePanel = (panel: NonNullable<typeof activePanel>) => setActivePanel((current) => current === panel ? null : panel);

  return <div className="lumora-player-frame relative h-full w-full bg-black">
    <div ref={containerRef} data-vjs-player="" className="h-full w-full" onContextMenu={(event) => event.preventDefault()} />
    {portalTarget ? createPortal(<>
      <div className="lumora-player-heading" aria-hidden="true"><span className="lumora-player-eyebrow">Now Playing</span>{titleName ? <span className="lumora-player-title">{titleName}</span> : null}</div>
      <div className={`lumora-player-tools${activePanel ? ' is-open' : ''}`} data-player-ui="">
        <div className="lumora-player-progress" aria-label={`Watched ${formatTime(progress.position)} of ${progress.duration ? formatTime(progress.duration) : 'unknown duration'}${percentage !== null ? `, ${Math.round(percentage)} percent` : ''}`}>
          <span className="lumora-player-eyebrow">Watched</span><span className="lumora-player-clock">{formatTime(progress.position)}<span> / {progress.duration ? formatTime(progress.duration) : '--:--'}</span></span>
          <span className="lumora-player-percent">{percentage !== null ? `${Math.round(percentage)}%` : '--%'}</span>
        </div>
        <div className="lumora-player-settings-anchor" data-player-settings="">
          <div className="lumora-player-toolbar" role="toolbar" aria-label="Playback options">
            <ToolButton label="Quality" active={activePanel === 'quality'} disabled={castStatus.state === 'connected'} controls={settingsId} onClick={(event) => { panelButtonRef.current = event.currentTarget; togglePanel('quality'); }}><QualityIcon /></ToolButton>
            <ToolButton label="Audio" active={activePanel === 'audio'} disabled={castStatus.state === 'connected'} controls={settingsId} onClick={(event) => { panelButtonRef.current = event.currentTarget; togglePanel('audio'); }}><AudioIcon /></ToolButton>
            <ToolButton label="Subtitles" active={activePanel === 'subtitles'} disabled={castStatus.state === 'connected'} controls={settingsId} onClick={(event) => { panelButtonRef.current = event.currentTarget; togglePanel('subtitles'); }}><SubtitleIcon /></ToolButton>
            <ToolButton label={castStatus.state === 'connected' ? 'Stop casting' : 'Cast'} active={castStatus.state === 'connected'} onClick={() => castActionRef.current()}><CastIcon /></ToolButton>
            <button type="button" disabled={castStatus.state === 'connected'} onClick={(event) => { panelButtonRef.current = event.currentTarget; togglePanel('settings'); playerRef.current?.userActive(true); }} aria-label="Settings" aria-expanded={activePanel === 'settings'} aria-controls={settingsId} className="lumora-player-settings-button"><SettingsIcon /></button>
          </div>
          {activePanel ? <div id={settingsId} className="lumora-player-settings" role="region" aria-label={`${activePanel[0]!.toUpperCase()}${activePanel.slice(1)} settings`}>
            <div className="lumora-player-settings-heading"><span>{activePanel === 'settings' ? 'Playback' : activePanel[0]!.toUpperCase() + activePanel.slice(1)}</span><span className="lumora-player-eyebrow">{activePanel === 'settings' ? 'Settings' : 'Choose'}</span></div>
            {activePanel === 'quality' ? <SettingsSelect label="Quality" value={preferences.quality} onChange={(id) => chooseRef.current('quality', id)}><option value="auto">{fastestAvailable ? 'Auto (fastest compatible)' : options.qualities.length ? 'Auto (adaptive)' : 'Original quality'}</option>{options.qualities.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</SettingsSelect> : null}
            {activePanel === 'audio' ? <SettingsSelect label="Audio" value={audioAvailable ? preferences.audio : 'unavailable'} disabled={options.audioTracks.length <= 1} status={options.audioTracks.length === 1 ? 'Single track' : !audioAvailable ? 'No alternate tracks reported' : undefined} onChange={(id) => chooseRef.current('audio', id)}>{audioAvailable ? options.audioTracks.map((track) => <option key={track.id} value={track.id}>{track.label}</option>) : <option value="unavailable">Default stream audio</option>}</SettingsSelect> : null}
            {activePanel === 'subtitles' ? <><SettingsSelect label="Subtitles" value={preferences.subtitle} disabled={!subtitlesAvailable} status={!subtitlesAvailable ? 'No subtitles reported' : undefined} onChange={(id) => chooseRef.current('subtitle', id)}><option value="off">{subtitlesAvailable ? 'Off' : 'Unavailable'}</option>{options.subtitles.map((track) => <option key={track.id} value={track.id}>{track.label}</option>)}</SettingsSelect><div className="lumora-subtitle-timing"><div><span>Subtitle timing</span><output aria-label="Subtitle timing offset">{timingOffset > 0 ? '+' : ''}{timingOffset.toFixed(2)}s</output></div><div className="lumora-subtitle-timing-controls"><button type="button" disabled={!subtitlesAvailable || preferences.subtitle === 'off' || timingOffset <= -10} aria-label="Advance subtitles by 0.25 seconds" onClick={() => delayRef.current(timingOffset - 0.25)}>-0.25s</button><button type="button" disabled={!subtitlesAvailable || timingOffset === 0} aria-label="Reset subtitle timing" onClick={() => delayRef.current(0)}>Reset</button><button type="button" disabled={!subtitlesAvailable || preferences.subtitle === 'off' || timingOffset >= 10} aria-label="Delay subtitles by 0.25 seconds" onClick={() => delayRef.current(timingOffset + 0.25)}>+0.25s</button></div><p>Negative plays captions earlier. Positive plays them later.</p></div></> : null}
            {activePanel === 'settings' ? <><SettingsSelect label="Playback speed" value={String(playbackRate)} onChange={(value) => speedRef.current(Number(value))}>{[0.5, 0.75, 1, 1.25, 1.5, 2].map((rate) => <option key={rate} value={rate}>{rate === 1 ? 'Normal' : `${rate}x`}</option>)}</SettingsSelect>{sources.length > 1 && onSelectSource ? <SettingsSelect label="Playback fallback" value={selectedSourceId ?? sources[0]?.id ?? ''} onChange={onSelectSource}>{sources.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</SettingsSelect> : null}</> : null}
            {catalogStatus !== 'ready' ? <p className="lumora-player-catalog-status" role="status">{catalogStatus === 'loading' ? 'Discovering available quality and language options...' : 'Some stream options could not be loaded. Current playback is unaffected.'}</p> : null}
            {selectionNotice ? <p className="lumora-player-catalog-status" role="status">{selectionNotice}</p> : null}
          </div> : null}
        </div>
        {castStatus.message ? <div className={`lumora-player-cast-status is-${castStatus.state}`} role="status">{castStatus.message}</div> : null}
      </div>
      {castStatus.state === 'connected' && remoteProgress ? <div className="lumora-player-cast-controls" data-player-ui="" role="group" aria-label={`Casting to ${castStatus.message ?? 'device'}`}>
        <span><strong>{castStatus.message}</strong><small>{formatTime(remoteProgress.positionSeconds)} / {remoteProgress.durationSeconds ? formatTime(remoteProgress.durationSeconds) : '--:--'}</small></span>
        <button type="button" aria-label="Cast back 10 seconds" onClick={() => castCommandRef.current('back')}>-10</button>
        <button type="button" aria-label={remoteProgress.paused ? 'Play on Cast device' : 'Pause Cast device'} onClick={() => castCommandRef.current(remoteProgress.paused ? 'play' : 'pause')}>{remoteProgress.paused ? 'Play' : 'Pause'}</button>
        <button type="button" aria-label="Cast forward 10 seconds" onClick={() => castCommandRef.current('forward')}>+10</button>
        <button type="button" aria-label="Stop casting" onClick={() => castActionRef.current()}>Stop</button>
      </div> : null}
      {upNextVisible && props.upNext ? <a href={props.upNext.href} className="lumora-player-up-next" data-player-ui=""><span className="lumora-player-eyebrow">Up next</span><strong>{props.upNext.name}</strong><span>Play next episode</span></a> : null}
      {switching ? <div className="lumora-player-switch-status" role="status">Updating playback<span>Your position is preserved</span></div> : null}
      {seekFeedback ? <div key={seekFeedback.sequence} className={`lumora-player-seek-feedback is-${seekFeedback.side}`} role="status"><span aria-hidden="true">{seekFeedback.side === 'left' ? '-10' : '+10'}</span><span>{seekFeedback.side === 'left' ? 'Back' : 'Forward'} 10 seconds</span></div> : null}
    </>, portalTarget) : null}
  </div>;
}

function SettingsSelect({ label, value, onChange, disabled, status, children }: { label: string; value: string; onChange: (value: string) => void; disabled?: boolean; status?: string; children: React.ReactNode }) {
  return <label className="lumora-player-setting"><span>{label}{status ? <small>{status}</small> : null}</span><select aria-label={label} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>{children}</select></label>;
}

function ToolButton({ label, active, disabled, controls, onClick, children }: { label: string; active: boolean; disabled?: boolean; controls?: string; onClick: (event: React.MouseEvent<HTMLButtonElement>) => void; children: React.ReactNode }) {
  return <button type="button" disabled={disabled} className="lumora-player-tool-button" aria-label={label} title={label} {...(controls ? { 'aria-controls': controls, 'aria-expanded': active } : { 'aria-pressed': active })} onClick={onClick}>{children}<span>{label}</span></button>;
}

function SettingsIcon() {
  return <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V21h-4v-.08A1.7 1.7 0 0 0 9 19.37a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.63 15 1.7 1.7 0 0 0 3.08 14H3v-4h.08A1.7 1.7 0 0 0 4.63 9a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.63 1.7 1.7 0 0 0 10 3.08V3h4v.08A1.7 1.7 0 0 0 15 4.63a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.37 9 1.7 1.7 0 0 0 20.92 10H21v4h-.08A1.7 1.7 0 0 0 19.4 15Z" /></svg>;
}

function QualityIcon() { return <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="3" /><path d="m8 14 2.5-3 2.2 2.4 1.7-1.8L17 14" /></svg>; }
function AudioIcon() { return <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M5 10v4h3l4 3V7L8 10H5Z" /><path d="M15 9a4 4 0 0 1 0 6M17.5 6.5a7.5 7.5 0 0 1 0 11" /></svg>; }
function SubtitleIcon() { return <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="3" /><path d="M6.5 12h5M6.5 15h8M14 12h3.5" /></svg>; }
function CastIcon() { return <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M4 18.5a1.5 1.5 0 0 1 1.5 1.5M4 14a6 6 0 0 1 6 6M4 9.5A10.5 10.5 0 0 1 14.5 20" /><path d="M6 4h12a2 2 0 0 1 2 2v10" /></svg>; }
