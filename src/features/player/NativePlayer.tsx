'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type Player from 'video.js/dist/types/player';
import type { DirectStream, Quality, Track } from '@/lib/providers/types';
import { reportProgressAction } from '@/features/playback/progress-actions';
import { readGuestEntries, updateGuestPosition } from '@/features/playback/guest-watch';
import { markPlaybackCheckpointSynced, playbackMediaKey, readPlaybackCheckpoint, writePlaybackCheckpoint, type PlaybackCheckpoint } from '@/features/playback/playback-checkpoint';
import { shiftedCueTiming } from './subtitle-timing';
import { createFullscreenOrientation, type PlayerOrientation } from './fullscreen-orientation';
import { readConsent } from '@/components/consent/ConsentBanner';
import { DEFAULT_VAST_CONFIGURATION, type PlaybackAdPolicy } from '@/features/commerce/types';
import { createVastSchedule } from '@/features/ads/vast/scheduler';
import { VastAdBreak, type VastBreakResult } from '@/features/ads/vast/VastAdBreak';
import type { VastCreative } from '@/features/ads/vast/types';
import { requestCasting, type CastingHandle, type CastingProgress } from './casting';
import type { IntroMarker } from './intro-markers';
import { EpisodeControls, type EpisodeNavigationControls } from './PlayerControlsBar';
import { aggregateStreamOptions, audioStreamId, chooseStream, numberedAudioStreamOptions, preferencesForStream, qualityKey, trackKey, type StreamPreferences, type StreamOption } from './stream-options';

export interface NativePlayerProps {
  source: { url: string; kind: 'mp4' | 'hls' | 'dash'; streamCatalogUrl?: string };
  subtitleCatalogUrl?: string;
  introCatalogUrl?: string;
  upNext?: { name: string; href: string; posterUrl?: string };
  episodeNavigation?: Pick<EpisodeNavigationControls, 'previous' | 'next'>;
  episodeNavigationDisabled?: boolean;
  episodeNavigationPending?: boolean;
  onNavigateEpisode?: (direction: 'previous' | 'next') => boolean;
  registerEpisodeTransition?: (prepare: (() => Promise<boolean>) | null) => void;
  onContentEnded?: () => void;
  autoNext?: boolean;
  onAutoNextChange?: (enabled: boolean) => void;
  adPolicy?: PlaybackAdPolicy;
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
  retryKey?: number;
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
type PlayerWithQualityLevels = Player & { qualityLevels: () => EventList<QualityLevel> & { readonly selectedIndex: number } };
type RemoteTrack = ReturnType<Player['addRemoteTextTrack']> & { track: SubtitleTrack };
interface PendingPosition { position: number; playing: boolean; rate: number }
type DisplayMode = 'fit' | 'fill' | 'zoom';
type PictureInPictureSupport = 'standard' | 'safari';
type PingStatus = { state: 'idle' | 'checking' | 'online' | 'offline' | 'unavailable'; milliseconds?: number };
interface SafariPictureInPictureVideo extends HTMLVideoElement {
  webkitPresentationMode?: string;
  webkitSupportsPresentationMode?: (mode: 'picture-in-picture') => boolean;
  webkitSetPresentationMode?: (mode: 'inline' | 'picture-in-picture') => void;
}

const REPORT_INTERVAL_MS = 5000;
const MAX_AUTOMATIC_STREAM_SWITCHES = 1;
const SOURCE_READY_TIMEOUT_MS = 15_000;
// The initial response can include both the 15s resolver and 12s catalog probe budgets.
const CATALOG_TIMEOUT_MS = 35_000;
const MAX_CATALOG_REUSE_MS = 4 * 60 * 60 * 1000;
const INITIAL_PREFERENCES: StreamPreferences = { quality: 'auto', audio: '', subtitle: 'off' };
const CONTROL_TARGETS = 'button, select, input, textarea, a, [role="button"], [role="slider"], .vjs-control-bar, .vjs-modal-dialog, [data-player-ui]';
const KEYBOARD_EXCLUDED_TARGETS = 'input, textarea, select, button, a, dialog, [role="dialog"], [role="button"], [role="slider"], [contenteditable]:not([contenteditable="false"]), .vjs-control-bar, .vjs-modal-dialog, [data-player-settings], [data-player-ui]';
const KEYBOARD_SHORTCUTS = 'Space K ArrowLeft ArrowRight J L ArrowUp ArrowDown M F C I Home End 0 1 2 3 4 5 6 7 8 9 Shift+N Shift+P';
const DISPLAY_MODE_STORAGE_KEY = 'lumora:player:display-mode:v1';
const PING_STORAGE_KEY = 'lumora:player:show-ping:v1';
const PING_INTERVAL_MS = 15_000;
const PING_TIMEOUT_MS = 5_000;
const DISPLAY_MODES: DisplayMode[] = ['fit', 'fill', 'zoom'];

function isDisplayMode(value: unknown): value is DisplayMode {
  return value === 'fit' || value === 'fill' || value === 'zoom';
}

function displayModeLabel(mode: DisplayMode): string {
  return mode === 'fit' ? 'Fit' : mode === 'fill' ? 'Fill' : 'Zoom';
}

function nextDisplayMode(mode: DisplayMode): DisplayMode {
  return DISPLAY_MODES[(DISPLAY_MODES.indexOf(mode) + 1) % DISPLAY_MODES.length]!;
}

function readDisplayMode(): DisplayMode {
  try {
    const value = window.localStorage.getItem(DISPLAY_MODE_STORAGE_KEY);
    return isDisplayMode(value) ? value : 'fit';
  } catch {
    return 'fit';
  }
}

function persistDisplayMode(mode: DisplayMode): void {
  try { window.localStorage.setItem(DISPLAY_MODE_STORAGE_KEY, mode); }
  catch { /* Playback display preferences are optional when storage is unavailable. */ }
}

function readPingPreference(): boolean {
  try { return window.localStorage.getItem(PING_STORAGE_KEY) === 'true'; }
  catch { return false; }
}

function persistPingPreference(enabled: boolean): void {
  try { window.localStorage.setItem(PING_STORAGE_KEY, String(enabled)); }
  catch { /* Connection diagnostics remain optional when storage is unavailable. */ }
}

function applyDisplayMode(element: HTMLElement, mode: DisplayMode): void {
  for (const candidate of DISPLAY_MODES) element.classList.toggle(`lumora-display-${candidate}`, candidate === mode);
}

function detectPictureInPicture(video: HTMLVideoElement): PictureInPictureSupport | null {
  if (document.pictureInPictureEnabled === true && typeof video.requestPictureInPicture === 'function') return 'standard';
  const safariVideo = video as SafariPictureInPictureVideo;
  if (typeof safariVideo.webkitSupportsPresentationMode !== 'function' || typeof safariVideo.webkitSetPresentationMode !== 'function') return null;
  try { return safariVideo.webkitSupportsPresentationMode('picture-in-picture') ? 'safari' : null; }
  catch { return null; }
}

function isSafariPictureInPictureActive(video: HTMLVideoElement): boolean {
  return (video as SafariPictureInPictureVideo).webkitPresentationMode === 'picture-in-picture';
}

function validIntro(value: unknown): value is IntroMarker {
  if (!value || typeof value !== 'object') return false;
  const marker = value as IntroMarker;
  return typeof marker.startSeconds === 'number' && typeof marker.endSeconds === 'number'
    && Number.isFinite(marker.startSeconds) && Number.isFinite(marker.endSeconds)
    && marker.startSeconds >= 0 && marker.startSeconds < marker.endSeconds;
}

function introTarget(marker: IntroMarker | null, position: number | undefined, duration: number | undefined): number | null {
  return validIntro(marker) && typeof position === 'number' && Number.isFinite(position)
    && typeof duration === 'number' && Number.isFinite(duration) && duration > 0
    && marker.endSeconds <= duration && position >= marker.startSeconds && position < marker.endSeconds
    ? marker.endSeconds : null;
}

function entries<T>(list: EventList<T>): T[] {
  const result: T[] = [];
  for (let index = 0; index < list.length; index += 1) if (list[index]) result.push(list[index]!);
  return result;
}

function mimeType(kind: NativePlayerProps['source']['kind']): string {
  return kind === 'hls' ? 'application/x-mpegURL' : kind === 'dash' ? 'application/dash+xml' : 'video/mp4';
}

function catalogStreamId(source: NativePlayerProps['source']): string | undefined {
  if (!source.streamCatalogUrl) return undefined;
  const id = new URL(source.url, window.location.href).searchParams.get('stream');
  return id && /^\d+$/.test(id) ? id : undefined;
}

function startsFromCatalog(source: NativePlayerProps['source']): boolean {
  if (source.kind !== 'hls' || !source.streamCatalogUrl) return false;
  try {
    const playback = new URL(source.url, window.location.href);
    const catalog = new URL(source.streamCatalogUrl, window.location.href);
    return playback.origin === window.location.origin && catalog.origin === playback.origin
      && playback.pathname === '/api/vidnest' && catalog.pathname === playback.pathname
      && !playback.searchParams.has('token') && catalog.searchParams.get('metadata') === '1'
      && ['tmdbId', 'type', 'season', 'episode'].every((name) => playback.searchParams.get(name) === catalog.searchParams.get(name));
  } catch { return false; }
}

function catalogScope(source: NativePlayerProps['source'], selectedSourceId?: string | null): string | null {
  if (!source.streamCatalogUrl) return null;
  if (selectedSourceId) return `${source.kind}:${selectedSourceId}`;
  const url = new URL(source.streamCatalogUrl, window.location.href);
  for (const key of ['token', 'signature', 'expires']) url.searchParams.delete(key);
  return `${source.kind}:${url.href}`;
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

function canShowUpNext(upNext: NativePlayerProps['upNext'], position: number, duration: number): boolean {
  return Boolean(upNext && duration > 0 && position >= duration * 0.9 && duration - position <= 90);
}

function pingLabel(status: PingStatus): string {
  if (status.state === 'online') return `Ping ${status.milliseconds ?? 0} ms`;
  if (status.state === 'offline') return 'Offline';
  if (status.state === 'unavailable') return 'Unavailable';
  return 'Checking ping';
}

function configureMediaElement(player: Player): HTMLVideoElement | null {
  const video = player.el().querySelector('video');
  if (!(video instanceof HTMLVideoElement)) return null;
  try { (video as HTMLVideoElement & { controlsList?: { add: (...tokens: string[]) => void } }).controlsList?.add('nodownload'); } catch { /* Unsupported browser. */ }
  video.disablePictureInPicture = false;
  video.playsInline = true;
  return video;
}

export function NativePlayer(props: NativePlayerProps) {
  const { source, titleId, titleName, episodeId, seasonNumber, episodeNumber, viewerKey = 'guest', sources = [], selectedSourceId, onSelectSource } = props;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<Player | null>(null);
  const latestProps = useRef(props);
  latestProps.current = props;
  const chooseRef = useRef<(field: keyof StreamPreferences, id: string) => void>(() => {});
  const delayRef = useRef<(offset: number) => void>(() => {});
  const displayActionRef = useRef<() => void>(() => {});
  const pictureInPictureActionRef = useRef<() => boolean>(() => false);
  const sourceSelectionRef = useRef<(id: string) => void>(() => {});
  const updateSourceRef = useRef<() => void>(() => {});
  const updateCatalogsRef = useRef<() => void>(() => {});
  const updateAdPolicyRef = useRef<() => void>(() => {});
  const upNextLinkRef = useRef<HTMLAnchorElement | null>(null);
  const [options, setOptions] = useState<{ qualities: StreamOption[]; audioTracks: StreamOption[]; subtitles: StreamOption[] }>({ qualities: [], audioTracks: [], subtitles: [] });
  const [audioStreams, setAudioStreams] = useState<StreamOption[]>([]);
  const [audioStreamPin, setAudioStreamPin] = useState<StreamOption | null>(null);
  const [initializationRetry, setInitializationRetry] = useState(0);
  const [preferences, setPreferences] = useState<StreamPreferences>(INITIAL_PREFERENCES);
  const [displayMode, setDisplayMode] = useState<DisplayMode>('fit');
  const displayModeRef = useRef<DisplayMode>('fit');
  displayModeRef.current = displayMode;
  const [activePanel, setActivePanel] = useState<'quality' | 'audio' | 'subtitles' | 'settings' | null>(null);
  const [portalTarget, setPortalTarget] = useState<Element | null>(null);
  const [timingOffset, setTimingOffset] = useState(0);
  const [progress, setProgress] = useState({ position: 0, duration: 0 });
  const [switching, setSwitching] = useState(false);
  const [contentBusy, setContentBusy] = useState(true);
  const [fullscreenActive, setFullscreenActive] = useState(false);
  const [catalogStatus, setCatalogStatus] = useState<'loading' | 'ready' | 'unavailable'>('ready');
  const [selectionNotice, setSelectionNotice] = useState<string | null>(null);
  const [fastestAvailable, setFastestAvailable] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [seekFeedback, setSeekFeedback] = useState<{ side: 'left' | 'right'; seconds: number; sequence: number } | null>(null);
  const [showPing, setShowPing] = useState(false);
  const [pingStatus, setPingStatus] = useState<PingStatus>({ state: 'idle' });
  const settingsId = useId();
  const keyboardHelpId = `${settingsId}-keyboard-shortcuts`;
  const panelButtonRef = useRef<HTMLButtonElement | null>(null);
  const speedRef = useRef<(rate: number) => void>(() => {});
  const castActionRef = useRef<() => void>(() => {});
  const castCommandRef = useRef<(command: 'play' | 'pause' | 'back' | 'forward') => void>(() => {});
  const [castStatus, setCastStatus] = useState<{ state: 'idle' | 'connecting' | 'connected' | 'error'; message?: string }>({ state: 'idle' });
  const [remoteProgress, setRemoteProgress] = useState<CastingProgress | null>(null);
  const [pictureInPictureSupport, setPictureInPictureSupport] = useState<PictureInPictureSupport | null>(null);
  const [pictureInPictureActive, setPictureInPictureActive] = useState(false);
  const [pictureInPicturePending, setPictureInPicturePending] = useState(false);
  const [pictureInPictureNotice, setPictureInPictureNotice] = useState<string | null>(null);
  const [adBreak, setAdBreak] = useState<{ creative: VastCreative; policy: PlaybackAdPolicy; volume: number; muted: boolean } | null>(null);
  const [adLoading, setAdLoading] = useState(false);
  const adDoneRef = useRef<(result: VastBreakResult) => void>(() => {});
  const [introCatalog, setIntroCatalog] = useState<{ url?: string; marker: IntroMarker | null }>({ marker: null });
  const introRef = useRef<IntroMarker | null>(null);
  introRef.current = introCatalog.url === props.introCatalogUrl ? introCatalog.marker : null;
  const refreshIntroRef = useRef<() => void>(() => {});
  const skipIntroRef = useRef<() => void>(() => {});
  const [introVisible, setIntroVisible] = useState(false);
  const [introPending, setIntroPending] = useState(false);
  const [introNotice, setIntroNotice] = useState<string | null>(null);
  const skipIntroButtonRef = useRef<HTMLButtonElement | null>(null);
  const hasCoordinates = seasonNumber !== undefined && episodeNumber !== undefined;
  const mediaKey = playbackMediaKey(titleId, hasCoordinates ? undefined : episodeId, seasonNumber, episodeNumber);

  useEffect(() => { setShowPing(readPingPreference()); }, []);

  useEffect(() => {
    const stored = readDisplayMode();
    displayModeRef.current = stored;
    setDisplayMode(stored);
  }, []);

  useEffect(() => {
    const player = playerRef.current;
    if (player && !player.isDisposed()) applyDisplayMode(player.el() as HTMLElement, displayMode);
  }, [displayMode]);

  useEffect(() => {
    if (!showPing) {
      setPingStatus((current) => current.state === 'idle' ? current : { state: 'idle' });
      return;
    }

    let disposed = false;
    let sequence = 0;
    let cadenceTimer: ReturnType<typeof setTimeout> | undefined;
    let active: { id: number; controller: AbortController; timeout: ReturnType<typeof setTimeout> } | null = null;

    const publish = (next: PingStatus) => {
      if (!disposed) setPingStatus((current) => current.state === next.state && current.milliseconds === next.milliseconds ? current : next);
    };
    const clearCadence = () => { clearTimeout(cadenceTimer); cadenceTimer = undefined; };
    const abortActive = () => {
      const request = active;
      active = null;
      sequence += 1;
      if (!request) return;
      clearTimeout(request.timeout);
      request.controller.abort();
    };
    const schedule = () => {
      clearCadence();
      if (!disposed && document.visibilityState !== 'hidden') cadenceTimer = setTimeout(measure, PING_INTERVAL_MS);
    };
    const complete = (id: number, next: PingStatus) => {
      if (disposed || active?.id !== id) return;
      clearTimeout(active.timeout);
      active = null;
      publish(next);
      schedule();
    };
    function measure() {
      clearCadence();
      if (disposed || document.visibilityState === 'hidden' || active) return;
      if (navigator.onLine === false) {
        publish({ state: 'offline' });
        schedule();
        return;
      }
      const id = ++sequence;
      const controller = new AbortController();
      const startedAt = Date.now();
      const timeout = setTimeout(() => {
        if (disposed || active?.id !== id) return;
        active = null;
        controller.abort();
        publish({ state: navigator.onLine === false ? 'offline' : 'unavailable' });
        schedule();
      }, PING_TIMEOUT_MS);
      active = { id, controller, timeout };
      publish({ state: 'checking' });
      void fetch('/api/health', { cache: 'no-store', credentials: 'same-origin', signal: controller.signal })
        .then((response) => complete(id, response.ok
          ? { state: 'online', milliseconds: Math.min(9999, Math.max(0, Math.round(Date.now() - startedAt))) }
          : { state: 'unavailable' }))
        .catch(() => complete(id, { state: navigator.onLine === false ? 'offline' : 'unavailable' }));
    }
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') { clearCadence(); abortActive(); }
      else measure();
    };
    const handleOffline = () => {
      clearCadence(); abortActive(); publish({ state: 'offline' }); schedule();
    };
    const handleOnline = () => { clearCadence(); abortActive(); measure(); };

    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('offline', handleOffline);
    window.addEventListener('online', handleOnline);
    measure();
    return () => {
      disposed = true;
      clearCadence(); abortActive();
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online', handleOnline);
    };
  }, [showPing]);

  useEffect(() => {
    const url = props.introCatalogUrl;
    const controller = new AbortController();
    let active = true;
    setIntroCatalog({ url, marker: null });
    if (url) {
      void fetch(url, { signal: controller.signal, credentials: 'same-origin', cache: 'no-store' })
        .then(async (response): Promise<unknown> => response.ok ? response.json() : null)
        .then((body) => {
          if (!active || controller.signal.aborted || latestProps.current.introCatalogUrl !== url) return;
          const marker = body && typeof body === 'object' && 'intro' in body ? body.intro : null;
          setIntroCatalog({ url, marker: validIntro(marker) ? { startSeconds: marker.startSeconds, endSeconds: marker.endSeconds } : null });
        }).catch(() => { /* Missing or unavailable markers never interrupt playback. */ });
    }
    return () => { active = false; controller.abort(); };
  }, [props.introCatalogUrl]);

  useEffect(() => { refreshIntroRef.current(); }, [introCatalog, props.introCatalogUrl]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    let player: Player | null = null;
    let detach = () => {};
    let flush = () => {};
    let exitPictureInPictureForCleanup: () => Promise<boolean> = async () => true;
    let pictureInPictureNeedsCleanup = () => false;
    const startProps = latestProps.current;
    const { source, titleId, titleSlug, titleName, episodeId, seasonNumber, episodeNumber } = startProps;
    const hasCoordinates = seasonNumber !== undefined && episodeNumber !== undefined;
    const contentProps = () => {
      const latest = latestProps.current;
      const coordinates = latest.seasonNumber !== undefined && latest.episodeNumber !== undefined;
      return (latest.viewerKey ?? 'guest') === viewerKey
        && playbackMediaKey(latest.titleId, coordinates ? undefined : latest.episodeId, latest.seasonNumber, latest.episodeNumber) === mediaKey ? latest : startProps;
    };
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
    let lastPlayback: PendingPosition = { position: resumePosition, playing: false, rate: 1 };
    let currentUrl = source.url;
    let currentKind = source.kind;
    let currentCatalogId = catalogStreamId(source);
    let inputSource = source;
    let inputSourceId = startProps.selectedSourceId;
    let retryKey = startProps.retryKey;
    let catalog: DirectStream[] = [];
    let catalogExpiresAt = 0;
    let awaitingCatalogPlayback = startsFromCatalog(source);
    let pendingCatalogChoice: { field: keyof StreamPreferences; id: string } | { retry: true } | null = null;
    let externalSubtitles: Track[] = [];
    let catalogPending = Boolean(source.streamCatalogUrl);
    let userSelected = false;
    let automaticRecoveryAllowed = true;
    let automaticSwitches = 0;
    let recommendationApplied = false;
    let pendingPlaybackFailure = false;
    let handledFailureGeneration = -1;
    let explicitAudio = false;
    let pinnedAudioStream: { stream: DirectStream; option: StreamOption; scope: string | null } | null = null;
    let desired: StreamPreferences = { ...INITIAL_PREFERENCES };
    let lastSubtitleChoice = '';
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
    let sourceChangeGeneration = 0;
    let sourceReplacementPending = false;
    let externalSourceSelecting = false;
    let episodeTransitionPending = false;
    let contentEnded = false;
    let castHandle: CastingHandle | null = null;
    let castConnecting = false;
    let contentLoading = true;
    let pictureInPictureVideo: HTMLVideoElement | null = null;
    let pictureInPictureKind: PictureInPictureSupport | null = null;
    let pictureInPictureCommandPending = false;
    let pictureInPictureCommand: Promise<void> | null = null;
    let suppressPictureInPictureLeaveAdResume = false;
    let resumeAdSchedule = () => {};
    let introCommand: symbol | null = null;
    let introCommandTimer: ReturnType<typeof setTimeout> | undefined;
    let lastRemote: CastingProgress | null = null;
    let lastCastReportAt = 0;
    let adActive = false;
    let deferredAdBreak = false;
    let adResume: PendingPosition | null = null;
    let adRequest: AbortController | undefined;
    let schedulePolicy = startProps.adPolicy ?? DEFAULT_VAST_CONFIGURATION;
    let adSchedule = createVastSchedule(schedulePolicy, resumePosition);
    const failedStreams = new Set<string>();
    setOptions({ qualities: [], audioTracks: [], subtitles: [] });
    setAudioStreams([]); setAudioStreamPin(null);
    setPreferences(desired); setActivePanel(null); setTimingOffset(0); setPlaybackRate(1);
    setProgress({ position: resumePosition, duration: local?.durationSeconds ?? 0 });
    setSwitching(false); setContentBusy(true); setFullscreenActive(false); setSeekFeedback(null); setSelectionNotice(null); setFastestAvailable(false); setCastStatus({ state: 'idle' }); setRemoteProgress(null); setAdBreak(null); setAdLoading(false);
    setPictureInPictureSupport(null); setPictureInPictureActive(false); setPictureInPicturePending(false); setPictureInPictureNotice(null);
    setCatalogStatus(source.streamCatalogUrl ? 'loading' : 'ready');
    setIntroVisible(false); setIntroPending(false); setIntroNotice(null);

    // React owns only this container. Video.js owns its imperative element, including fullscreen.
    const videoElement = document.createElement('video-js');
    videoElement.className = 'video-js lumora-videojs h-full w-full';
    videoElement.setAttribute('aria-label', startProps.titleName ? `Watch ${startProps.titleName}` : 'Video player');
    videoElement.setAttribute('aria-describedby', keyboardHelpId);
    videoElement.setAttribute('aria-keyshortcuts', KEYBOARD_SHORTCUTS);
    videoElement.setAttribute('controlslist', 'nodownload');
    videoElement.setAttribute('tabindex', '0');
    container.appendChild(videoElement);
    let requestFullscreenSafely: () => Promise<void> = async () => {};

    const markReady = () => {
      if (cancelled || readyReported || fatalReported || sourceReplacementPending || !sourceReady || pendingPosition
        || !player || player.isDisposed() || player.readyState() < 2 || player.error()) return;
      readyReported = true;
      latestProps.current.onReady?.();
    };
    const reportFatal = () => {
      if (cancelled || fatalReported) return;
      fatalReported = true;
      sourceReplacementPending = false;
      sourceReady = false; contentLoading = true;
      try { if (player && !player.isDisposed()) player.pause(); } catch { /* Preserve the fatal error if the tech already failed. */ }
      clearTimeout(switchTimer); switchTimer = undefined;
      setSwitching(false); setContentBusy(true);
      setIntroVisible(false); setIntroPending(false);
      setSelectionNotice('Playback failed. Your selections are unchanged. Retry or choose another option.');
      latestProps.current.onError?.();
    };
    updateSourceRef.current = () => {
      if (fatalReported && latestProps.current.retryKey !== startProps.retryKey) setInitializationRetry((attempt) => attempt + 1);
    };

    void import('video.js').then(({ default: createPlayer }) => {
      if (cancelled) return;
      const videoPlayer = createPlayer(videoElement, {
        controls: true, preload: 'auto', playsinline: true, responsive: true, fill: true,
        disablePictureInPicture: false,
        playbackRates: [0.5, 0.75, 1, 1.25, 1.5, 2],
        sources: awaitingCatalogPlayback ? [] : [{ src: source.url, type: mimeType(source.kind) }],
        ...(startProps.posterUrl ? { poster: startProps.posterUrl } : {}),
        html5: {
          vhs: { overrideNative: true, limitRenditionByPlayerDimensions: false },
          ...(source.kind !== 'mp4' ? { nativeAudioTracks: false, nativeVideoTracks: false, nativeTextTracks: false } : {}),
        },
        userActions: { hotkeys: false, doubleClick: (event: MouseEvent) => {
          if (Date.now() < suppressClicksUntil || (event as MouseEvent & { sourceCapabilities?: { firesTouchEvents?: boolean } }).sourceCapabilities?.firesTouchEvents) return;
          if (videoPlayer.isFullscreen()) videoPlayer.exitFullscreen();
          else void requestFullscreenSafely();
        } },
        controlBar: { pictureInPictureToggle: false, subsCapsButton: false, audioTrackButton: false, skipButtons: { backward: 10, forward: 10 }, remainingTimeDisplay: false, currentTimeDisplay: true, timeDivider: true, durationDisplay: true },
      });
      player = videoPlayer;
      playerRef.current = videoPlayer;
      const playerElement = videoPlayer.el() as HTMLElement;
      playerElement.setAttribute('aria-describedby', keyboardHelpId);
      playerElement.setAttribute('aria-keyshortcuts', KEYBOARD_SHORTCUTS);
      playerElement.setAttribute('tabindex', '0');
      applyDisplayMode(playerElement, displayModeRef.current);
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
      let unavailableChoiceNotice = false;
      let catalogUrl: string | undefined | null = null;
      let subtitleUrl: string | undefined | null = null;
      let catalogRequest: AbortController | undefined;
      let subtitleRequest: AbortController | undefined;
      let catalogTimer: ReturnType<typeof setTimeout> | undefined;

      const currentPictureInPictureState = () => pictureInPictureKind === 'standard'
        ? Boolean(videoPlayer.isInPictureInPicture())
        : Boolean(pictureInPictureKind === 'safari' && pictureInPictureVideo && isSafariPictureInPictureActive(pictureInPictureVideo));
      const syncPictureInPictureState = () => {
        const active = currentPictureInPictureState();
        if (!cancelled) setPictureInPictureActive(active);
        return active;
      };
      const handlePlayerPictureInPictureEnter = () => {
        videoPlayer.isInPictureInPicture(true);
        const active = syncPictureInPictureState();
        if (active && !cancelled) setPictureInPictureNotice(null);
      };
      const handlePlayerPictureInPictureLeave = () => {
        videoPlayer.isInPictureInPicture(false);
        syncPictureInPictureState();
        if (!suppressPictureInPictureLeaveAdResume) resumeAdSchedule();
      };
      const handleSafariPictureInPictureChange = () => {
        if (pictureInPictureVideo && isSafariPictureInPictureActive(pictureInPictureVideo)) handlePlayerPictureInPictureEnter();
        else handlePlayerPictureInPictureLeave();
      };
      const unbindPictureInPictureVideo = () => {
        if (!pictureInPictureVideo) return;
        pictureInPictureVideo.removeEventListener('webkitpresentationmodechanged', handleSafariPictureInPictureChange);
      };
      const bindPictureInPictureVideo = () => {
        try { videoPlayer.disablePictureInPicture(false); } catch { /* Some techs do not expose the native flag. */ }
        const nextVideo = configureMediaElement(videoPlayer);
        if (nextVideo !== pictureInPictureVideo) {
          unbindPictureInPictureVideo();
          pictureInPictureVideo = nextVideo;
          pictureInPictureVideo?.addEventListener('webkitpresentationmodechanged', handleSafariPictureInPictureChange);
        }
        pictureInPictureKind = pictureInPictureVideo ? detectPictureInPicture(pictureInPictureVideo) : null;
        if (pictureInPictureKind === 'safari') videoPlayer.isInPictureInPicture(Boolean(pictureInPictureVideo && isSafariPictureInPictureActive(pictureInPictureVideo)));
        else if (!pictureInPictureKind) videoPlayer.isInPictureInPicture(false);
        if (!cancelled) setPictureInPictureSupport(pictureInPictureKind);
        syncPictureInPictureState();
      };
      const setPlayerPictureInPicture = async (enter: boolean) => {
        const video = pictureInPictureVideo;
        const support = pictureInPictureKind;
        if (!video || !support) throw new Error('Picture-in-Picture is unavailable');
        if (support === 'standard') {
          if (enter) await videoPlayer.requestPictureInPicture();
          else if (videoPlayer.isInPictureInPicture()) await videoPlayer.exitPictureInPicture();
        } else {
          const safariVideo = video as SafariPictureInPictureVideo;
          safariVideo.webkitSetPresentationMode?.(enter ? 'picture-in-picture' : 'inline');
          videoPlayer.isInPictureInPicture(isSafariPictureInPictureActive(video));
        }
        if (currentPictureInPictureState() !== enter) throw new Error('Picture-in-Picture state did not change');
        syncPictureInPictureState();
      };
      const exitPictureInPictureBeforeTransition = async () => {
        if (pictureInPictureCommand) {
          try { await pictureInPictureCommand; } catch { /* The command reports its own sanitized failure. */ }
        }
        if (!currentPictureInPictureState()) return true;
        try {
          suppressPictureInPictureLeaveAdResume = true;
          await setPlayerPictureInPicture(false);
          return !currentPictureInPictureState();
        } catch {
          if (!cancelled) {
            setPictureInPictureNotice('Picture-in-Picture could not close. Try again from the player.');
            videoPlayer.userActive(true);
          }
          return false;
        } finally {
          suppressPictureInPictureLeaveAdResume = false;
        }
      };
      exitPictureInPictureForCleanup = exitPictureInPictureBeforeTransition;
      pictureInPictureNeedsCleanup = () => pictureInPictureCommandPending || currentPictureInPictureState();
      pictureInPictureActionRef.current = () => {
        if (pictureInPictureCommandPending || !pictureInPictureVideo || !pictureInPictureKind || !sourceReady
          || contentLoading || pendingPosition || adActive || castConnecting || castHandle || episodeTransitionPending
          || latestProps.current.episodeNavigationPending || videoPlayer.isFullscreen()) return false;
        const enter = !currentPictureInPictureState();
        pictureInPictureCommandPending = true;
        setPictureInPicturePending(true);
        setPictureInPictureNotice(null);
        const command = setPlayerPictureInPicture(enter);
        pictureInPictureCommand = command;
        void command.catch(() => {
          if (!cancelled) setPictureInPictureNotice(enter
            ? 'Picture-in-Picture could not start. Try again from the player.'
            : 'Picture-in-Picture could not close. Try again from the player.');
        }).finally(() => {
          if (pictureInPictureCommand === command) pictureInPictureCommand = null;
          pictureInPictureCommandPending = false;
          if (!cancelled) {
            setPictureInPicturePending(false);
            if (!syncPictureInPictureState()) resumeAdSchedule();
            videoPlayer.userActive(true);
          }
        });
        return true;
      };
      requestFullscreenSafely = async () => {
        if (videoPlayer.isFullscreen()) return;
        if (!pictureInPictureCommandPending && !currentPictureInPictureState()) {
          await videoPlayer.requestFullscreen();
          return;
        }
        if (!await exitPictureInPictureBeforeTransition()) return;
        if (!cancelled && !videoPlayer.isDisposed()) await videoPlayer.requestFullscreen();
      };
      displayActionRef.current = () => {
        const next = nextDisplayMode(displayModeRef.current);
        displayModeRef.current = next;
        applyDisplayMode(playerElement, next);
        persistDisplayMode(next);
        setDisplayMode(next);
        videoPlayer.userActive(true);
      };
      sourceSelectionRef.current = (id) => {
        if (externalSourceSelecting || cancelled || videoPlayer.isDisposed() || episodeTransitionPending
          || latestProps.current.episodeNavigationPending) return;
        if (!pictureInPictureCommandPending && !currentPictureInPictureState()) {
          latestProps.current.onSelectSource?.(id);
          return;
        }
        externalSourceSelecting = true;
        void exitPictureInPictureBeforeTransition().then((exited) => {
          if (exited && !cancelled && !videoPlayer.isDisposed()) latestProps.current.onSelectSource?.(id);
        }).finally(() => { externalSourceSelecting = false; });
      };

      const currentIntroTarget = () => {
        if (cancelled || videoPlayer.isDisposed() || !sourceReady || !resumed || pendingPosition || adActive || castConnecting
          || (!castHandle && (contentLoading || videoPlayer.readyState() < 2 || videoPlayer.seeking())) || videoPlayer.error()) return null;
        return castHandle
          ? introTarget(introRef.current, lastRemote?.positionSeconds, lastRemote?.durationSeconds)
          : introTarget(introRef.current, videoPlayer.currentTime(), videoPlayer.duration());
      };
      function refreshIntro() {
        setIntroVisible(currentIntroTarget() !== null);
      }
      const cancelIntroCommand = () => {
        const returnFocus = document.activeElement === skipIntroButtonRef.current;
        introCommand = null;
        clearTimeout(introCommandTimer); introCommandTimer = undefined;
        if (!cancelled) setIntroPending(false);
        if (returnFocus && !videoPlayer.isDisposed()) {
          const playerElement = videoPlayer.el() as HTMLElement;
          playerElement.setAttribute('tabindex', '0');
          playerElement.focus({ preventScroll: true });
        }
      };
      refreshIntroRef.current = refreshIntro;

      const sendReports = async () => {
        if (reporting || !queuedReport) return;
        reporting = true;
        try {
          while (queuedReport) {
            const report = queuedReport;
            queuedReport = null;
            try {
              const identity = contentProps();
              const result = await reportProgressAction({ titleId, ...(identity.episodeId ? { episodeId: identity.episodeId } : {}), positionSeconds: report.positionSeconds, durationSeconds: report.durationSeconds, viewerKey });
              if (result.ok && report.checkpoint) markPlaybackCheckpointSynced(viewerKey, mediaKey, report.checkpoint);
            }
            catch { /* The scoped synchronous checkpoint survives server failures. */ }
          }
        } finally { reporting = false; }
      };
      flush = () => {
        if (videoPlayer.isDisposed() || !resumed || pendingPosition || !sourceReady || videoPlayer.error()) return;
        const position = castHandle && lastRemote ? lastRemote.positionSeconds : videoPlayer.currentTime();
        const duration = castHandle && lastRemote ? lastRemote.durationSeconds : videoPlayer.duration();
        if (typeof position !== 'number' || !Number.isFinite(position)) return;
        const durationSeconds = typeof duration === 'number' && Number.isFinite(duration) && duration > 0 ? duration : undefined;
        const identity = contentProps();
        const canReport = viewerKey.startsWith('account:') && Boolean(identity.episodeId || (identity.seasonNumber === undefined && identity.episodeNumber === undefined));
        const checkpoint = writePlaybackCheckpoint(viewerKey, mediaKey, position, durationSeconds, canReport);
        lastFlushAt = Date.now();
        if (viewerKey === 'guest') {
          updateGuestPosition(identity.titleSlug, position, durationSeconds, { episodeId: identity.episodeId, seasonNumber: identity.seasonNumber, episodeNumber: identity.episodeNumber });
        } else if (canReport) {
          queuedReport = { positionSeconds: position, durationSeconds, checkpoint };
          void sendReports();
        }
      };
      const prepareEpisodeTransition = async () => {
        if (cancelled || videoPlayer.isDisposed() || episodeTransitionPending || latestProps.current.episodeNavigationDisabled) return false;
        if (castConnecting || castHandle) {
          setSelectionNotice('Stop casting before changing episodes.');
          return false;
        }
        episodeTransitionPending = true;
        try {
          if ((pictureInPictureCommandPending || currentPictureInPictureState()) && !await exitPictureInPictureBeforeTransition()) return false;
          if (cancelled || videoPlayer.isDisposed() || latestProps.current.episodeNavigationDisabled) return false;
          flush();
          if (adActive) {
            adRequest?.abort();
            if (adResume) adResume.playing = false;
            finishAd();
          }
          videoPlayer.pause();
          return true;
        } finally {
          // Shell owns the navigation latch; a failed router transition must remain retryable.
          episodeTransitionPending = false;
        }
      };
      latestProps.current.registerEpisodeTransition?.(prepareEpisodeTransition);

      const clearPresentation = () => {
        if (presentation) {
          presentation.mode = 'disabled';
          for (const { cue } of clonedCues.values()) presentation.removeCue(cue);
        }
        clonedCues.clear();
      };
      const reconcileCues = () => {
        if (cancelled || fatalReported || !selectedSubtitle || !presentation || selectedSubtitle.mode !== 'hidden') return;
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
      const currentMetadata = () => catalog.find((stream) => stream.url === currentUrl)
        ?? (pinnedAudioStream?.stream.url === currentUrl ? pinnedAudioStream.stream
          : startsFromCatalog(inputSource) ? undefined : catalog.find((stream) => stream.id === currentCatalogId));
      const runtimeStream = (): DirectStream => {
        const metadata = currentMetadata();
        return {
          id: metadata?.id ?? currentCatalogId ?? 'current', url: currentUrl,
          ...(metadata?.startupLatencyMs !== undefined ? { startupLatencyMs: metadata.startupLatencyMs } : {}),
          qualities: [...(metadata?.qualities ?? []), ...entries(qualityList).map(renditionQuality)],
          audioTracks: metadata?.audioTracks.length ? metadata.audioTracks : entries(audioList)
            .filter((track) => track.label || (track.language && track.language.toLowerCase() !== 'und'))
            .map((track) => ({ id: track.id, label: track.label || track.language, language: track.language, default: track.enabled })),
          subtitles: [...(metadata?.subtitles ?? []), ...externalSubtitles, ...realTextTracks().map((track) => ({ id: track.id, label: track.label || track.language || 'Subtitles', language: track.language, kind: track.kind as 'subtitles' | 'captions' }))],
        };
      };
      const availableStreams = () => {
        const current = runtimeStream();
        // Live track evidence belongs to the loaded URL, not a newly issued same-ID capability.
        if (startsFromCatalog(inputSource)) return catalogExpiresAt > Date.now() ? catalog.map((stream) => stream.url === currentUrl
          ? current : { ...stream, subtitles: [...stream.subtitles, ...externalSubtitles] }) : [];
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
        if (!sourceReady || fatalReported || videoPlayer.error()) return;
        const levels = entries(qualityList);
        const matching = levels.filter((level) => qualityKey(renditionQuality(level)) === desired.quality);
        for (const level of levels) {
          const enabled = desired.quality === 'auto' || matching.includes(level);
          if (level.enabled !== enabled) level.enabled = enabled;
        }
        const audio = entries(audioList);
        const audioChoice = audio.find((track) => trackKey(track) === desired.audio);
        if (audioChoice) {
          for (const track of audio) if (track.enabled !== (track === audioChoice)) track.enabled = track === audioChoice;
        } else if (explicitAudio && desired.audio !== 'auto' && audioStreamId(desired.audio) === undefined) {
          for (const track of audio) if (track.enabled) track.enabled = false;
        } else if (!desired.audio) {
          const active = audio.find((track) => track.enabled) ?? audio[0];
          if (active && (active.label || (active.language && active.language.toLowerCase() !== 'und'))) { desired.audio = trackKey(active); updatePreferences(); }
        }
        const subtitles = realTextTracks();
        const subtitleChoice = desired.subtitle === 'off' ? null : subtitles.find((track) => trackKey(track) === desired.subtitle) ?? null;
        const unavailable = (desired.quality !== 'auto' && !runtimeStream().qualities.some((quality) => qualityKey(quality) === desired.quality))
          || (explicitAudio && desired.audio !== 'auto' && audioStreamId(desired.audio) === undefined && !audioChoice)
          || (desired.subtitle !== 'off' && !subtitleChoice);
        if (unavailable) {
          unavailableChoiceNotice = true;
          setSelectionNotice('A selected option is not available in this source yet. Your selections are unchanged.');
        } else if (unavailableChoiceNotice) {
          unavailableChoiceNotice = false;
          setSelectionNotice(null);
        }
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
        if (cancelled || videoPlayer.isDisposed() || fatalReported) return;
        try {
          const next = aggregateStreamOptions(availableStreams());
          setOptions((previous) => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
          const numbered = numberedAudioStreamOptions(catalog);
          if (pinnedAudioStream && !numbered.some((option) => option.id === pinnedAudioStream!.option.id)) numbered.push(pinnedAudioStream.option);
          setAudioStreams((previous) => JSON.stringify(previous) === JSON.stringify(numbered) ? previous : numbered);
          installSidecars();
          applyChoices();
        } catch { reportFatal(); }
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
      const loadStream = (stream: DirectStream, kind = currentKind, force = false) => {
        if (!force && stream.url === currentUrl && kind === currentKind) { refresh(); return; }
        const generation = ++sourceChangeGeneration;
        sourceReplacementPending = true;
        const replace = () => {
          if (cancelled || fatalReported || videoPlayer.isDisposed() || generation !== sourceChangeGeneration) return;
          sourceReplacementPending = false;
          flush();
          pendingPosition = pendingPosition ?? adResume ?? (castHandle && lastRemote
            ? { position: lastRemote.positionSeconds, playing: !lastRemote.paused, rate: videoPlayer.playbackRate() ?? 1 }
            : sourceReady && !videoPlayer.error()
              ? { position: resumed ? videoPlayer.currentTime() ?? 0 : resumePosition, playing: !videoPlayer.paused(), rate: videoPlayer.playbackRate() ?? 1 }
              : { ...lastPlayback });
          if (castHandle || castConnecting) disconnectCast(false);
          if (adActive) { adRequest?.abort(); finishAd(); }
          sourceReady = false;
          contentLoading = true;
          readyReported = false;
          pendingPlaybackFailure = false;
          cancelIntroCommand(); refreshIntro();
          clearSidecars();
          setSwitching(true); setContentBusy(true);
          clearTimeout(switchTimer);
          currentUrl = stream.url;
          currentCatalogId = stream.id;
          currentKind = kind;
          if (pinnedAudioStream?.stream.id === stream.id) pinnedAudioStream = { ...pinnedAudioStream, stream };
          switchTimer = setTimeout(() => { if (generation === sourceChangeGeneration) handlePlaybackError(true); }, SOURCE_READY_TIMEOUT_MS);
          try { videoPlayer.src({ src: currentUrl, type: mimeType(currentKind) }); }
          catch { reportFatal(); }
          scheduleRefresh();
        };
        if (!pictureInPictureCommandPending && !currentPictureInPictureState()) { replace(); return; }
        setSwitching(true);
        void exitPictureInPictureBeforeTransition().then((exited) => {
          if (cancelled || generation !== sourceChangeGeneration) return;
          if (exited) replace();
          else { sourceReplacementPending = false; setSwitching(false); reportFatal(); }
        });
      };
      function handlePlaybackError(timedOut = false) {
        try {
          if (cancelled || videoPlayer.isDisposed() || fatalReported || sourceReplacementPending || handledFailureGeneration === sourceChangeGeneration
            || (!timedOut && !pendingPlaybackFailure && !videoPlayer.error())) return;
          if (!automaticRecoveryAllowed || desired.quality !== 'auto' || pinnedAudioStream) { reportFatal(); return; }
          if (catalogPending) {
            pendingPlaybackFailure = true;
            setSelectionNotice('Playback failed while stream options are loading. Your selections are unchanged.');
            return;
          }
          handledFailureGeneration = sourceChangeGeneration;
          pendingPlaybackFailure = false;
          failedStreams.add(runtimeStream().id);
          const candidates = availableStreams().filter((stream) => stream.url !== currentUrl && !failedStreams.has(stream.id));
          const constraints = { ...desired, audio: explicitAudio ? desired.audio : '' };
          const fallback = automaticSwitches < MAX_AUTOMATIC_STREAM_SWITCHES ? chooseStream(candidates, constraints, 'quality') : undefined;
          if (!fallback) { reportFatal(); return; }
          automaticSwitches += 1;
          desired = preferencesForStream(fallback, constraints);
          updatePreferences();
          setSelectionNotice('Playback failed. Auto is trying one other compatible source.');
          loadStream(fallback);
        } catch { reportFatal(); }
      }
      const retryStream = () => {
        if (!startsFromCatalog(inputSource)) { loadStream(runtimeStream(), currentKind, true); return; }
        if (!catalog.length || catalogExpiresAt <= Date.now()) {
          pendingCatalogChoice = { retry: true };
          setSelectionNotice('Refreshing expired playback links. Current playback is unchanged.');
          updateCatalogs(true);
          return;
        }
        const id = pinnedAudioStream?.stream.id ?? currentCatalogId;
        const stream = chooseStream(availableStreams().filter((candidate) => candidate.id === id), desired, 'quality');
        if (!stream) {
          reportFatal();
          setSelectionNotice('The selected stream is unavailable with your current selections. Your selections are unchanged.');
          return;
        }
        loadStream(stream, currentKind, true);
      };
      const choose = (field: keyof StreamPreferences, id: string, manual: boolean) => {
        if (cancelled || videoPlayer.isDisposed() || episodeTransitionPending || latestProps.current.episodeNavigationPending) return false;
        try {
          if (manual && startsFromCatalog(inputSource) && catalog.length && catalogExpiresAt <= Date.now()) {
            pendingCatalogChoice = { field, id };
            setSelectionNotice('Refreshing expired playback links. Current playback is unchanged.');
            updateCatalogs(true);
            return true;
          }
          const numberedId = field === 'audio' ? audioStreamId(id) : undefined;
          const numberedStream = numberedId === undefined ? undefined : catalog.find((stream) => stream.id === numberedId);
          if (numberedId !== undefined && !numberedStream) {
            setSelectionNotice('That audio stream is unavailable. Your selections and playback have not changed.');
            return false;
          }
          const nextPin = numberedStream ? { stream: numberedStream,
            option: numberedAudioStreamOptions(catalog).find((option) => option.id === id)!,
            scope: catalogScope(inputSource, inputSourceId) }
            : field === 'audio' && id === 'auto' ? null : pinnedAudioStream;
          const nextExplicitAudio = field === 'audio' ? id !== 'auto' : explicitAudio;
          const next = { ...desired, [field]: id, ...(!nextExplicitAudio ? { audio: '' } : {}) };
          if (field === 'audio' && id === 'auto') next.audio = 'auto';
          const candidates = numberedStream ? [{ ...numberedStream, subtitles: [...numberedStream.subtitles, ...externalSubtitles] }] : availableStreams();
          const stream = chooseStream(candidates, next, field, runtimeStream().id, nextPin?.stream.id);
          if (!stream) {
            unavailableChoiceNotice = false;
            setSelectionNotice(nextPin
              ? 'That audio stream and your selected quality or subtitles are unavailable together. Numbered audio changes the full stream; independent audio from another stream is unavailable. Your selections and playback have not changed.'
              : 'That option is unavailable with your current selections. Playback has not changed.');
            return false;
          }
          const retry = fatalReported || Boolean(videoPlayer.error());
          if (manual) {
            userSelected = true; explicitAudio = nextExplicitAudio;
            pinnedAudioStream = nextPin;
            setAudioStreamPin(nextPin?.option ?? null);
            automaticRecoveryAllowed = !nextPin && ((field === 'quality' && id === 'auto') || (field === 'audio' && id === 'auto' && desired.quality === 'auto'));
            fatalReported = false; handledFailureGeneration = -1; automaticSwitches = 0; failedStreams.clear();
          }
          if (field === 'subtitle' && id !== 'off') lastSubtitleChoice = id;
          desired = preferencesForStream(stream, next);
          unavailableChoiceNotice = false; setSelectionNotice(null);
          updatePreferences();
          loadStream(stream, currentKind, retry);
          return !fatalReported;
        } catch { reportFatal(); return false; }
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
        if (pendingPosition) pendingPosition.rate = rate;
        else lastPlayback.rate = rate;
        setPlaybackRate(rate);
      };
      const saveRemote = (remote: CastingProgress, force = false) => {
        lastRemote = remote;
        setRemoteProgress(remote);
        setProgress({ position: remote.positionSeconds, duration: remote.durationSeconds ?? 0 });
        refreshIntro();
        const now = Date.now();
        if (!force && now - lastCastReportAt < 5_000) return;
        lastCastReportAt = now;
        const identity = contentProps();
        const canReport = viewerKey.startsWith('account:') && Boolean(identity.episodeId || (identity.seasonNumber === undefined && identity.episodeNumber === undefined));
        const checkpoint = writePlaybackCheckpoint(viewerKey, mediaKey, remote.positionSeconds, remote.durationSeconds, canReport);
        if (viewerKey === 'guest') {
          updateGuestPosition(identity.titleSlug, remote.positionSeconds, remote.durationSeconds, { episodeId: identity.episodeId, seasonNumber: identity.seasonNumber, episodeNumber: identity.episodeNumber });
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
        if (introCommand && !stop) setIntroNotice('Casting ended before the intro could be skipped.');
        const handle = castHandle;
        castHandle = null;
        castConnecting = false;
        cancelIntroCommand();
        if (stop) handle?.stop(); else handle?.dispose();
        restoreLocal();
        setRemoteProgress(null);
        setCastStatus({ state: 'idle' });
        refreshIntro();
      };
      castActionRef.current = () => {
        if (castConnecting) return;
        if (castHandle) {
          disconnectCast(true);
          return;
        }
        if (episodeTransitionPending || latestProps.current.episodeNavigationPending) return;
        const mediaElement = videoPlayer.el().querySelector('video');
        if (!(mediaElement instanceof HTMLVideoElement)) return;
        const castSource = currentUrl;
        castConnecting = true;
        cancelIntroCommand(); refreshIntro();
        setCastStatus({ state: 'connecting', message: 'Preparing device picker' });
        void (async () => {
          if ((pictureInPictureCommandPending || currentPictureInPictureState())
            && !await exitPictureInPictureBeforeTransition()) {
            castConnecting = false;
            setCastStatus({ state: 'error', message: 'Close Picture-in-Picture before casting and try again.' });
            refreshIntro();
            return;
          }
          if (cancelled || videoPlayer.isDisposed() || currentUrl !== castSource) { castConnecting = false; return; }
          setCastStatus({ state: 'connecting', message: 'Choose a device' });
          try {
            const handle = await requestCasting(mediaElement, {
              url: castSource, contentType: mimeType(currentKind),
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
            }, (remote) => saveRemote(remote), () => disconnectCast(false));
            if (cancelled || videoPlayer.isDisposed() || currentUrl !== castSource) { handle?.dispose(); return; }
            castConnecting = false;
            if (!handle) { setCastStatus({ state: 'idle', message: 'Device picker opened' }); refreshIntro(); return; }
            castHandle = handle;
            videoPlayer.pause();
            videoPlayer.controls(false);
            setActivePanel(null);
            setCastStatus({ state: 'connected', message: handle.deviceName });
            refreshIntro();
          } catch (error: unknown) {
            castConnecting = false;
            setCastStatus({ state: 'error', message: error instanceof Error ? error.message : 'Casting could not start.' });
            if (!cancelled) refreshIntro();
          }
        })();
      };
      castCommandRef.current = (command) => {
        if (!castHandle || !lastRemote) return;
        if (command === 'play') void castHandle.play();
        else if (command === 'pause') void castHandle.pause();
        else void castHandle.seek(Math.max(0, lastRemote.positionSeconds + (command === 'back' ? -10 : 10)));
      };
      skipIntroRef.current = () => {
        const target = currentIntroTarget();
        if (target === null || introCommand) return;
        const command = Symbol('skip-intro');
        introCommand = command;
        setIntroPending(true); setIntroNotice(null);
        if (castHandle) {
          const receiver = castHandle;
          const commandSource = currentUrl;
          const commandCatalog = latestProps.current.introCatalogUrl;
          const marker = introRef.current;
          const current = () => !cancelled && !videoPlayer.isDisposed() && castHandle === receiver
            && currentUrl === commandSource && latestProps.current.introCatalogUrl === commandCatalog && introRef.current === marker;
          const timeout = new Promise<never>((_resolve, reject) => {
            introCommandTimer = setTimeout(() => reject(new Error('Cast intro seek timed out')), 10_000);
          });
          void Promise.race([Promise.resolve().then(() => {
            if (current() && introCommand === command) return receiver.seek(target);
          }), timeout])
            .then(() => {
              // Cast publishes acknowledged receiver progress before resolving seek(). Never invent a remote position.
              if (current() && introCommand === command && lastRemote) saveRemote(lastRemote, true);
            }).catch(() => {
              if (current()) setIntroNotice('The device could not skip the intro. Try again.');
            }).finally(() => {
              if (!cancelled && introCommand === command) { cancelIntroCommand(); refreshIntro(); }
            });
          return;
        }
        try {
          adSchedule.update({ contentTimeSeconds: target, paused: videoPlayer.paused(), seeking: true, adPlaying: false });
          introCommandTimer = setTimeout(() => {
            if (cancelled || introCommand !== command) return;
            cancelIntroCommand();
            setIntroNotice('The intro could not be skipped. Try again.');
            refreshIntro();
          }, 10_000);
          // Seeking preserves pause and playback rate. The existing seeked listener flushes content checkpoints and captions.
          videoPlayer.currentTime(target);
          refreshIntro();
        } catch {
          cancelIntroCommand();
          setIntroNotice('The intro could not be skipped. Try again.');
          refreshIntro();
        }
      };
      const finishAd = () => {
        if (!adActive || cancelled || videoPlayer.isDisposed()) return;
        adActive = false;
        adSchedule.finish();
        setAdBreak(null); setAdLoading(false);
        videoPlayer.controls(true);
        if (adResume) {
          videoPlayer.currentTime(adResume.position);
          videoPlayer.playbackRate(adResume.rate);
          if (adResume.playing) void videoPlayer.play()?.catch(() => {});
        }
        adResume = null;
        refreshIntro();
      };
      adDoneRef.current = finishAd;
      updateAdPolicyRef.current = () => {
        const next = latestProps.current.adPolicy ?? DEFAULT_VAST_CONFIGURATION;
        if (JSON.stringify(next) === JSON.stringify(schedulePolicy)) return;
        if (adActive) { adRequest?.abort(); finishAd(); }
        schedulePolicy = next;
        adSchedule = createVastSchedule(next, pendingPosition?.position ?? (resumed ? videoPlayer.currentTime() ?? resumePosition : resumePosition));
      };
      const beginAd = () => {
        if (pictureInPictureCommandPending || currentPictureInPictureState()) {
          deferredAdBreak = true;
          return;
        }
        const policy = latestProps.current.adPolicy;
        if (!policy?.enabled || !readConsent()?.ads || adActive || cancelled || castHandle) { deferredAdBreak = false; adSchedule.finish(); return; }
        deferredAdBreak = false;
        adActive = true;
        cancelIntroCommand(); refreshIntro();
        flush();
        adResume = { position: videoPlayer.currentTime() ?? 0, playing: !videoPlayer.paused(), rate: videoPlayer.playbackRate() ?? 1 };
        videoPlayer.pause(); videoPlayer.controls(false); setActivePanel(null);
        setAdLoading(true);
        const controller = new AbortController(); adRequest = controller;
        const timer = setTimeout(() => controller.abort(), 10_000);
        void fetch('/api/vast?consent=1', { signal: controller.signal, credentials: 'same-origin', cache: 'no-store' })
          .then(async (response): Promise<{ creative?: VastCreative }> => response.ok && response.status !== 204 ? response.json() as Promise<{ creative?: VastCreative }> : {})
          .then((result) => {
            if (cancelled || controller.signal.aborted || adRequest !== controller || !adActive) return;
            if (!result.creative || typeof result.creative.mediaUrl !== 'string' || !Number.isFinite(result.creative.durationSeconds)) { finishAd(); return; }
            setAdLoading(false);
            setAdBreak({ creative: result.creative, policy, volume: videoPlayer.volume() ?? 1, muted: videoPlayer.muted() ?? false });
          }).catch(() => { if (adRequest === controller && adActive) finishAd(); }).finally(() => clearTimeout(timer));
      };
      const sampleAdSchedule = () => {
        if (cancelled || videoPlayer.isDisposed() || fatalReported || !sourceReady || !resumed || videoPlayer.error()) return;
        if (deferredAdBreak) {
          if (!pictureInPictureCommandPending && !currentPictureInPictureState()) beginAd();
          return;
        }
        if (adSchedule.update({
          contentTimeSeconds: videoPlayer.currentTime() ?? 0,
          paused: videoPlayer.paused() || document.visibilityState === 'hidden',
          seeking: videoPlayer.seeking() || Boolean(pendingPosition),
          adPlaying: adActive || castConnecting || Boolean(castHandle) || pictureInPictureCommandPending || currentPictureInPictureState(),
        })) beginAd();
      };
      resumeAdSchedule = sampleAdSchedule;

      const updateProgress = () => {
        const position = pendingPosition?.position ?? videoPlayer.currentTime() ?? 0;
        const rawDuration = videoPlayer.duration();
        const duration = typeof rawDuration === 'number' && Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : 0;
        if (!pendingPosition && sourceReady && !videoPlayer.error() && !adActive && !castHandle && Number.isFinite(position)) {
          lastPlayback = { position, playing: !videoPlayer.paused(), rate: videoPlayer.playbackRate() ?? 1 };
        }
        if (Math.floor(position) !== lastRenderedSecond || duration !== lastDuration) {
          lastRenderedSecond = Math.floor(position); lastDuration = duration;
          setProgress({ position, duration });
        }
        refreshIntro();
      };
      const handleMetadata = () => {
        if (cancelled || videoPlayer.isDisposed() || awaitingCatalogPlayback || fatalReported || videoPlayer.error()) return;
        sourceReady = true;
        bindPictureInPictureVideo();
        refresh();
        if (fatalReported) return;
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
        updateProgress(); markReady();
      };
      const orientation = createFullscreenOrientation(navigator.maxTouchPoints > 0
        ? screen.orientation as unknown as PlayerOrientation : undefined);
      const handleFullscreen = () => {
        const active = Boolean(videoPlayer.isFullscreen());
        setFullscreenActive(active);
        void orientation.setFullscreen(active);
      };
      const handleTimeUpdate = () => {
        if (cancelled) return;
        updateProgress();
        const now = Date.now();
        if (!videoPlayer.paused() && now - lastFlushAt >= REPORT_INTERVAL_MS) flush();
        sampleAdSchedule();
      };
      const handleSeeked = () => {
        if (!castHandle) cancelIntroCommand();
        contentLoading = videoPlayer.readyState() < 2;
        adSchedule.update({
          contentTimeSeconds: videoPlayer.currentTime() ?? 0,
          paused: videoPlayer.paused() || document.visibilityState === 'hidden',
          seeking: true,
          adPlaying: adActive || castConnecting || Boolean(castHandle) || pictureInPictureCommandPending || currentPictureInPictureState(),
        });
        reconcileCues(); updateProgress(); flush();
      };
      const handleHidden = () => { if (document.visibilityState === 'hidden') flush(); };
      const handlePause = () => {
        if (!cancelled && sourceReady && !pendingPosition && !videoPlayer.error() && !adActive && !castHandle) {
          lastPlayback = { position: videoPlayer.currentTime() ?? lastPlayback.position, playing: false, rate: videoPlayer.playbackRate() ?? lastPlayback.rate };
          flush();
        }
      };
      const handleContentLoading = () => { contentLoading = true; setContentBusy(true); refreshIntro(); };
      const handleContentReady = () => {
        if (cancelled || videoPlayer.isDisposed() || fatalReported || videoPlayer.error() || !sourceReady || videoPlayer.readyState() < 2) return;
        clearTimeout(switchTimer); switchTimer = undefined;
        contentLoading = false; setContentBusy(false); updateProgress(); markReady(); refreshIntro();
        if (!videoPlayer.ended()) contentEnded = false;
      };
      const handleEnded = () => {
        flush();
        if (cancelled || fatalReported || videoPlayer.isDisposed() || contentEnded || !videoPlayer.ended()
          || latestProps.current.episodeNavigationDisabled || latestProps.current.episodeNavigationPending
          || !sourceReady || !resumed || contentLoading || pendingPosition || sourceReplacementPending || externalSourceSelecting
          || videoPlayer.error() || videoPlayer.seeking() || adActive || castConnecting || castHandle
          || pictureInPictureCommandPending || suppressPictureInPictureLeaveAdResume || episodeTransitionPending) return;
        const position = videoPlayer.currentTime(); const duration = videoPlayer.duration();
        if (typeof position !== 'number' || !Number.isFinite(position) || typeof duration !== 'number'
          || !Number.isFinite(duration) || duration <= 0 || position < duration - 0.1) return;
        contentEnded = true;
        latestProps.current.onContentEnded?.();
      };
      const handleSkip = (event: Event) => {
        const target = event.target as Element;
        if (target.closest('.vjs-skip-backward-10')) showSeek('left');
        else if (target.closest('.vjs-skip-forward-10')) showSeek('right');
      };
      const handleFullscreenControl = (event: MouseEvent) => {
        const target = event.target as Element;
        if (!target.closest('.vjs-fullscreen-control') || videoPlayer.isFullscreen()
          || (!pictureInPictureCommandPending && !currentPictureInPictureState())) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        void requestFullscreenSafely();
      };
      const showSeek = (side: 'left' | 'right', seconds = 10) => {
        setSeekFeedback((previous) => ({ side, seconds, sequence: (previous?.sequence ?? 0) + 1 }));
        clearTimeout(feedbackTimer);
        feedbackTimer = setTimeout(() => { if (!cancelled) setSeekFeedback(null); }, 750);
        videoPlayer.userActive(true);
      };
      const keyboardPlaybackReady = () => !cancelled && !videoPlayer.isDisposed() && sourceReady && resumed
        && !contentLoading && !pendingPosition && videoPlayer.readyState() >= 2 && !videoPlayer.error()
        && !adActive && !castConnecting && !castHandle && !pictureInPictureCommandPending && !episodeTransitionPending
        && !latestProps.current.episodeNavigationPending;
      const togglePlayback = () => {
        if (!keyboardPlaybackReady()) return false;
        if (videoPlayer.paused()) void videoPlayer.play()?.catch(() => {});
        else videoPlayer.pause();
        return true;
      };
      const seekTo = (position: number, feedback?: { side: 'left' | 'right'; seconds: number }) => {
        if (!keyboardPlaybackReady() || !Number.isFinite(position)) return false;
        const duration = videoPlayer.duration();
        const maximum = typeof duration === 'number' && Number.isFinite(duration) && duration > 0 ? duration : Infinity;
        try {
          videoPlayer.currentTime(Math.max(0, Math.min(maximum, position)));
          if (feedback) showSeek(feedback.side, feedback.seconds);
          return true;
        } catch {
          return false;
        }
      };
      const seekBy = (seconds: number) => {
        if (!keyboardPlaybackReady()) return false;
        const position = videoPlayer.currentTime();
        return typeof position === 'number' && Number.isFinite(position)
          ? seekTo(position + seconds, { side: seconds < 0 ? 'left' : 'right', seconds: Math.abs(seconds) }) : false;
      };
      const seekToFraction = (fraction: number) => {
        if (!keyboardPlaybackReady()) return false;
        const duration = videoPlayer.duration();
        return typeof duration === 'number' && Number.isFinite(duration) && duration > 0
          ? seekTo(duration * Math.min(1, Math.max(0, fraction))) : false;
      };
      const adjustVolume = (amount: number) => {
        if (!keyboardPlaybackReady()) return false;
        const volume = videoPlayer.volume();
        if (typeof volume !== 'number' || !Number.isFinite(volume)) return false;
        videoPlayer.volume(Math.min(1, Math.max(0, Math.round((volume + amount) * 100) / 100)));
        return true;
      };
      const toggleMute = () => {
        if (!keyboardPlaybackReady()) return false;
        videoPlayer.muted(!videoPlayer.muted());
        return true;
      };
      const toggleFullscreen = () => {
        if (!keyboardPlaybackReady()) return false;
        if (videoPlayer.isFullscreen()) videoPlayer.exitFullscreen();
        else void requestFullscreenSafely().catch(() => {});
        return true;
      };
      const toggleCaptions = () => {
        if (!keyboardPlaybackReady()) return false;
        const subtitles = aggregateStreamOptions(availableStreams()).subtitles;
        if (!subtitles.length) return false;
        if (desired.subtitle !== 'off') {
          lastSubtitleChoice = desired.subtitle;
          return choose('subtitle', 'off', true);
        }
        const target = subtitles.find((track) => track.id === lastSubtitleChoice) ?? subtitles[0];
        return Boolean(target && choose('subtitle', target.id, true));
      };
      const openUpNext = () => {
        const latest = latestProps.current;
        if (latest.episodeNavigationDisabled || latest.episodeNavigationPending) return false;
        if (latest.episodeNavigation?.next && latest.onNavigateEpisode) return latest.onNavigateEpisode('next');
        if (!keyboardPlaybackReady()) return false;
        const link = upNextLinkRef.current;
        if (!link || !latestProps.current.upNext) return false;
        link.click();
        return true;
      };
      const keyboardTargetExcluded = (target: EventTarget | null) => target instanceof Element
        && Boolean(target.closest(KEYBOARD_EXCLUDED_TARGETS));
      const handleKeyboard = (event: KeyboardEvent) => {
        if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey
          || !(event.target instanceof Element) || keyboardTargetExcluded(event.target)
          || keyboardTargetExcluded(document.activeElement)) return;
        const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
        let handled = false;
        if (event.shiftKey) {
          if (event.repeat) return;
          if (key === 'n') handled = openUpNext();
          else if (key === 'p' && !latestProps.current.episodeNavigationDisabled && !latestProps.current.episodeNavigationPending
            && latestProps.current.episodeNavigation?.previous) handled = latestProps.current.onNavigateEpisode?.('previous') ?? false;
          else return;
        } else if (key === ' ' || key === 'Spacebar' || key === 'k') handled = togglePlayback();
        else if (key === 'ArrowLeft') handled = seekBy(-5);
        else if (key === 'ArrowRight') handled = seekBy(5);
        else if (key === 'j') handled = seekBy(-10);
        else if (key === 'l') handled = seekBy(10);
        else if (key === 'ArrowUp') handled = adjustVolume(0.05);
        else if (key === 'ArrowDown') handled = adjustVolume(-0.05);
        else if (key === 'm') handled = toggleMute();
        else if (key === 'f') handled = toggleFullscreen();
        else if (key === 'c') handled = toggleCaptions();
        else if (key === 'i') handled = keyboardPlaybackReady() && pictureInPictureActionRef.current();
        else if (key === 'Home' || key === '0') handled = seekTo(0);
        else if (key === 'End') handled = seekToFraction(1);
        else if (/^[1-9]$/.test(key)) handled = seekToFraction(Number(key) / 10);
        if (!handled) return;
        event.preventDefault();
        event.stopImmediatePropagation();
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
      const handleQualityChange = () => {
        try {
          const selected = qualityList[qualityList.selectedIndex];
          // Do not re-enable a failed manual rendition when VHS excludes it.
          if (sourceReady && !sourceReplacementPending && !pendingPosition && !fatalReported && desired.quality !== 'auto'
            && selected && qualityKey(renditionQuality(selected)) !== desired.quality) { reportFatal(); return; }
          scheduleRefresh();
        } catch { reportFatal(); }
      };
      for (const event of ['addqualitylevel', 'removequalitylevel', 'change']) qualityList.on(event, event === 'change' ? handleQualityChange : scheduleRefresh);
      for (const list of [audioList, textList]) for (const event of ['addtrack', 'removetrack', 'change']) list.on(event, scheduleRefresh);
      videoPlayer.on('loadedmetadata', handleMetadata);
      videoPlayer.on('loadeddata', scheduleRefresh);
      videoPlayer.on('techchange', bindPictureInPictureVideo);
      videoPlayer.on('enterpictureinpicture', handlePlayerPictureInPictureEnter);
      videoPlayer.on('leavepictureinpicture', handlePlayerPictureInPictureLeave);
      videoPlayer.on(['loadstart', 'waiting', 'emptied'], handleContentLoading);
      videoPlayer.on(['loadeddata', 'canplay', 'playing'], handleContentReady);
      videoPlayer.on('seeking', refreshIntro);
      videoPlayer.on('durationchange', updateProgress);
      videoPlayer.on('ratechange', () => {
        const rate = pendingPosition?.rate ?? videoPlayer.playbackRate() ?? 1;
        if (!pendingPosition && sourceReady) lastPlayback.rate = rate;
        setPlaybackRate(rate);
      });
      videoPlayer.on('fullscreenchange', handleFullscreen);
      videoPlayer.on('timeupdate', handleTimeUpdate);
      videoPlayer.on('seeked', handleSeeked);
      videoPlayer.on('pause', handlePause);
      videoPlayer.on('ended', handleEnded);
      videoPlayer.on('error', () => handlePlaybackError());
      document.addEventListener('visibilitychange', handleHidden);
      window.addEventListener('pagehide', flush);
      playerElement.addEventListener('pointerdown', handlePointerDown, true);
      playerElement.addEventListener('pointermove', handlePointerMove, true);
      playerElement.addEventListener('pointerup', handlePointerUp, true);
      playerElement.addEventListener('pointercancel', handlePointerCancel, true);
      playerElement.addEventListener('click', handleFullscreenControl, true);
      playerElement.addEventListener('click', blockTouchClick, true);
      playerElement.addEventListener('dblclick', blockTouchClick, true);
      playerElement.addEventListener('click', handleSkip);
      playerElement.addEventListener('keydown', handleKeyboard, true);
      detach = () => {
        latestProps.current.registerEpisodeTransition?.(null);
        orientation.dispose();
        catalogRequest?.abort(); subtitleRequest?.abort(); clearTimeout(catalogTimer);
        adRequest?.abort();
        clearTimeout(feedbackTimer);
        clearTimeout(switchTimer);
        clearTimeout(introCommandTimer);
        for (const event of ['addqualitylevel', 'removequalitylevel', 'change']) qualityList.off(event, event === 'change' ? handleQualityChange : scheduleRefresh);
        for (const list of [audioList, textList]) for (const event of ['addtrack', 'removetrack', 'change']) list.off(event, scheduleRefresh);
        document.removeEventListener('visibilitychange', handleHidden);
        window.removeEventListener('pagehide', flush);
        playerElement.removeEventListener('pointerdown', handlePointerDown, true);
        playerElement.removeEventListener('pointermove', handlePointerMove, true);
        playerElement.removeEventListener('pointerup', handlePointerUp, true);
        playerElement.removeEventListener('pointercancel', handlePointerCancel, true);
        playerElement.removeEventListener('click', handleFullscreenControl, true);
        playerElement.removeEventListener('click', blockTouchClick, true);
        playerElement.removeEventListener('dblclick', blockTouchClick, true);
        playerElement.removeEventListener('click', handleSkip);
        playerElement.removeEventListener('keydown', handleKeyboard, true);
        unbindPictureInPictureVideo();
        clearSidecars();
        if (lastRemote) saveRemote(lastRemote, true);
        castHandle?.dispose(); castHandle = null;
      };
      bindPictureInPictureVideo();
      videoPlayer.ready(() => {
        if (cancelled || videoPlayer.isDisposed()) return;
        bindPictureInPictureVideo(); scheduleRefresh();
      });
      if (!awaitingCatalogPlayback) switchTimer = setTimeout(() => handlePlaybackError(true), SOURCE_READY_TIMEOUT_MS);
      if (videoPlayer.readyState() >= 1) handleMetadata();

      // Direct playback resolves once; subsequent stream choices use issued capabilities.
      const updateCatalogs = (force = false) => {
        const latest = latestProps.current;
        const forceRefresh = force && !catalogPending;
        if (latest.source.streamCatalogUrl !== catalogUrl
          || (forceRefresh && (!catalog.length || catalogExpiresAt <= Date.now()))) {
          catalogRequest?.abort(); clearTimeout(catalogTimer);
          if (latest.source.streamCatalogUrl !== catalogUrl) pendingCatalogChoice = null;
          catalogUrl = latest.source.streamCatalogUrl;
          catalogExpiresAt = 0;
          catalogPending = Boolean(catalogUrl);
          setCatalogStatus(catalogPending ? 'loading' : 'ready');
          if (!catalogUrl) { catalog = []; setFastestAvailable(false); refresh(); }
          else {
            const controller = new AbortController();
            catalogRequest = controller;
            const active = () => !cancelled && !controller.signal.aborted && catalogRequest === controller;
            const unavailable = () => {
              if (pendingCatalogChoice) setSelectionNotice('Playback links could not be refreshed. Current playback is unchanged. Try your selection again.');
              pendingCatalogChoice = null;
              catalogPending = false; setCatalogStatus('unavailable');
              if (awaitingCatalogPlayback) { reportFatal(); return; }
              if (pendingPlaybackFailure || videoPlayer.error()) handlePlaybackError(pendingPlaybackFailure);
            };
            catalogTimer = setTimeout(() => {
              if (!active()) return;
              controller.abort(); unavailable();
            }, CATALOG_TIMEOUT_MS);
            void fetch(catalogUrl, { signal: controller.signal, credentials: 'same-origin', cache: 'no-store' })
              .then(async (response) => {
                if (!response.ok) throw new Error('Stream catalog unavailable');
                return response.json() as Promise<{ streams?: DirectStream[]; expiresAt?: number }>;
              })
              .then((result) => {
                if (!active()) return;
                clearTimeout(catalogTimer);
                catalog = Array.isArray(result?.streams) ? result.streams.filter((stream) => stream && typeof stream.id === 'string'
                  && typeof stream.url === 'string' && Array.isArray(stream.qualities) && Array.isArray(stream.audioTracks) && Array.isArray(stream.subtitles)) : [];
                const expiries = [result?.expiresAt, ...catalog.map((stream) => stream.expiresAt)]
                  .filter((value): value is number => typeof value === 'number' && Number.isSafeInteger(value));
                catalogExpiresAt = Math.min(Date.now() + (expiries.length ? MAX_CATALOG_REUSE_MS : 60_000), ...expiries);
                catalogPending = false;
                if (!catalog.length || catalogExpiresAt <= Date.now()) { unavailable(); return; }
                const measured = catalog.some((stream) => typeof stream.startupLatencyMs === 'number' && Number.isFinite(stream.startupLatencyMs) && stream.startupLatencyMs >= 0);
                setFastestAvailable(measured); setCatalogStatus(catalog.length ? 'ready' : 'unavailable');
                refresh();
                if (awaitingCatalogPlayback) {
                  const requestedId = catalogStreamId(inputSource);
                  const next = chooseStream(requestedId ? catalog.filter((stream) => stream.id === requestedId) : catalog, desired, 'quality');
                  if (!next) { unavailable(); return; }
                  awaitingCatalogPlayback = false;
                  recommendationApplied = true;
                  desired = preferencesForStream(next, desired);
                  updatePreferences();
                  if (!sourceReady) pendingPosition ??= { ...lastPlayback, playing: !videoPlayer.paused(), rate: videoPlayer.playbackRate() ?? 1 };
                  loadStream(next, inputSource.kind, true);
                  return;
                }
                if (pendingCatalogChoice) {
                  const choice = pendingCatalogChoice;
                  pendingCatalogChoice = null;
                  if ('retry' in choice) retryStream();
                  else choose(choice.field, choice.id, true);
                  return;
                }
                if (pendingPlaybackFailure || videoPlayer.error()) { handlePlaybackError(pendingPlaybackFailure); return; }
                if (!fatalReported && !userSelected && !recommendationApplied && desired.quality === 'auto' && measured) {
                  recommendationApplied = true;
                  choose('quality', 'auto', false);
                }
              }).catch(() => {
                if (!active()) return;
                clearTimeout(catalogTimer); unavailable();
              });
          }
        }
        if (forceRefresh || latest.subtitleCatalogUrl !== subtitleUrl) {
          subtitleRequest?.abort(); subtitleUrl = latest.subtitleCatalogUrl;
          if (!subtitleUrl) { externalSubtitles = []; refresh(); }
          else {
            const controller = new AbortController(); subtitleRequest = controller;
            void fetch(subtitleUrl, { signal: controller.signal, credentials: 'same-origin', cache: 'no-store' })
              .then(async (response) => response.ok ? response.json() as Promise<{ tracks?: Track[] }> : { tracks: [] })
              .then((result) => {
                if (cancelled || controller.signal.aborted || subtitleRequest !== controller) return;
                externalSubtitles = Array.isArray(result?.tracks) ? result.tracks.filter((track) => track
                  && typeof track.id === 'string' && typeof track.label === 'string' && typeof track.url === 'string'
                  && (track.kind === 'subtitles' || track.kind === 'captions')) : [];
                refresh();
              }).catch(() => undefined);
          }
        }
      };
      updateCatalogsRef.current = () => updateCatalogs();
      updateSourceRef.current = () => {
        try {
          const latest = latestProps.current;
          const selectedChanged = latest.selectedSourceId !== inputSourceId;
          const changed = latest.source.url !== inputSource.url || latest.source.kind !== inputSource.kind || selectedChanged;
          const sameCatalog = !selectedChanged && startsFromCatalog(inputSource) && startsFromCatalog(latest.source)
            && latest.source.streamCatalogUrl === inputSource.streamCatalogUrl
            && catalogStreamId(latest.source) === catalogStreamId(inputSource);
          const retry = latest.retryKey !== retryKey;
          if (!changed && !retry) return;
          // A refreshed URL is not permission to silently leave a terminal failure.
          if (fatalReported && !retry && !externalSourceSelecting) return;
          externalSourceSelecting = false;
          inputSource = latest.source; inputSourceId = latest.selectedSourceId; retryKey = latest.retryKey;
          fatalReported = false; handledFailureGeneration = -1; pendingPlaybackFailure = false;
          if (retry || selectedChanged) { automaticSwitches = 0; failedStreams.clear(); recommendationApplied = retry; }
          unavailableChoiceNotice = false; setSelectionNotice(null);
          if (changed) {
            if (sameCatalog) {
              if (retry && !awaitingCatalogPlayback) retryStream();
            } else if (startsFromCatalog(inputSource) && inputSource.streamCatalogUrl === catalogUrl
              && catalog.length && catalogExpiresAt > Date.now()) {
              const requestedId = catalogStreamId(inputSource);
              const next = chooseStream(requestedId ? catalog.filter((stream) => stream.id === requestedId) : catalog,
                { ...desired, audio: audioStreamId(desired.audio) === undefined ? desired.audio : '' }, 'quality');
              if (!next) { setSelectionNotice('That source is unavailable with your current selections. Playback has not changed.'); return; }
              pinnedAudioStream = null; setAudioStreamPin(null);
              if (audioStreamId(desired.audio) !== undefined) { desired.audio = ''; explicitAudio = false; }
              desired = preferencesForStream(next, desired); updatePreferences();
              loadStream(next, inputSource.kind, true);
            } else if (pinnedAudioStream && pinnedAudioStream.scope === catalogScope(inputSource, inputSourceId)) {
              // A refreshed Auto URL is not permission to replace the user's exact catalog source.
              if (retry) retryStream();
            } else {
              if (pinnedAudioStream) {
                pinnedAudioStream = null; setAudioStreamPin(null);
                if (audioStreamId(desired.audio) !== undefined) { desired.audio = ''; explicitAudio = false; }
              }
              catalog = []; setFastestAvailable(false);
              if (!explicitAudio) desired.audio = '';
              updatePreferences();
              awaitingCatalogPlayback = startsFromCatalog(inputSource);
              if (awaitingCatalogPlayback) clearTimeout(switchTimer);
              else loadStream({ id: catalogStreamId(inputSource) ?? 'current', url: inputSource.url, qualities: [], audioTracks: [], subtitles: [] }, inputSource.kind, true);
            }
          } else if (!awaitingCatalogPlayback) retryStream();
          updateCatalogs(retry || awaitingCatalogPlayback);
        } catch { reportFatal(); }
      };
      updateAdPolicyRef.current(); updateSourceRef.current(); updateCatalogs();
    }).catch(() => reportFatal());

    return () => {
      flush();
      cancelled = true;
      const pictureInPictureExit = pictureInPictureNeedsCleanup() ? exitPictureInPictureForCleanup() : null;
      detach();
      chooseRef.current = () => {};
      delayRef.current = () => {};
      displayActionRef.current = () => {};
      pictureInPictureActionRef.current = () => false;
      sourceSelectionRef.current = () => {};
      updateSourceRef.current = () => {};
      updateCatalogsRef.current = () => {};
      updateAdPolicyRef.current = () => {};
      speedRef.current = () => {};
      castActionRef.current = () => {};
      castCommandRef.current = () => {};
      adDoneRef.current = () => {};
      refreshIntroRef.current = () => {};
      skipIntroRef.current = () => {};
      if (playerRef.current === player) playerRef.current = null;
      const disposedTarget = player?.el();
      setPortalTarget((current) => current === disposedTarget ? null : current);
      const dispose = () => {
        if (player && !player.isDisposed()) player.dispose();
        videoElement.remove();
      };
      if (pictureInPictureExit) void pictureInPictureExit.finally(dispose);
      else dispose();
    };
  }, [viewerKey, mediaKey, keyboardHelpId, initializationRetry]);

  useEffect(() => { updateSourceRef.current(); }, [source.url, source.kind, selectedSourceId, props.retryKey]);
  useEffect(() => { updateCatalogsRef.current(); }, [source.streamCatalogUrl, props.subtitleCatalogUrl]);
  useEffect(() => { updateAdPolicyRef.current(); }, [props.adPolicy]);

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

  useEffect(() => {
    if (!props.adPolicy?.enabled) adDoneRef.current('skip');
  }, [props.adPolicy?.enabled]);

  const percentage = progress.duration > 0 ? Math.min(100, Math.max(0, progress.position / progress.duration * 100)) : null;
  const subtitlesAvailable = options.subtitles.length > 0;
  const qualityMissing = preferences.quality !== 'auto' && !options.qualities.some((option) => option.id === preferences.quality);
  const audioMissing = Boolean(preferences.audio) && preferences.audio !== 'auto'
    && ![...audioStreams, ...options.audioTracks].some((option) => option.id === preferences.audio);
  const subtitleMissing = preferences.subtitle !== 'off' && !options.subtitles.some((option) => option.id === preferences.subtitle);
  const upNextVisible = canShowUpNext(props.upNext, progress.position, progress.duration);
  const nextMode = nextDisplayMode(displayMode);
  const pictureInPictureBlocked = contentBusy || switching || Boolean(adBreak) || adLoading
    || props.episodeNavigationPending || fullscreenActive || castStatus.state === 'connecting' || castStatus.state === 'connected';
  const togglePanel = (panel: NonNullable<typeof activePanel>) => setActivePanel((current) => current === panel ? null : panel);
  const togglePing = () => setShowPing((current) => {
    const next = !current;
    persistPingPreference(next);
    return next;
  });

  return <div className="lumora-player-frame relative h-full w-full bg-black">
    <div ref={containerRef} data-vjs-player="" className="h-full w-full" onContextMenu={(event) => event.preventDefault()} />
    {portalTarget ? createPortal(<>
      <p id={keyboardHelpId} className="sr-only">Keyboard shortcuts are available when focus is on the video surface. Open Settings for the full shortcut list.</p>
      <div className="lumora-player-heading" aria-hidden="true"><span className="lumora-player-eyebrow">Now Playing</span>{titleName ? <span className="lumora-player-title">{titleName}</span> : null}</div>
      <div className={`lumora-player-tools${activePanel ? ' is-open' : ''}${adBreak || adLoading ? ' has-ad-break' : ''}`} data-player-ui="">
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
            {activePanel === 'quality' ? <SettingsSelect label="Quality" value={preferences.quality} onChange={(id) => chooseRef.current('quality', id)}><option value="auto">{fastestAvailable ? 'Auto (fastest compatible)' : options.qualities.length ? 'Auto (adaptive)' : 'Original quality'}</option>{qualityMissing ? <option value={preferences.quality} disabled>Selected quality (unavailable)</option> : null}{options.qualities.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</SettingsSelect> : null}
            {activePanel === 'audio' ? <>
              <SettingsSelect label="Audio" value={preferences.audio || options.audioTracks[0]?.id || 'auto'} status={audioStreamPin ? `${audioStreamPin.label} pinned` : audioMissing ? 'Selected track unavailable' : undefined} onChange={(id) => chooseRef.current('audio', id)}>
                <option value="auto">Auto</option>
                {audioMissing ? <option value={preferences.audio} disabled>Selected audio (unavailable)</option> : null}
                {audioStreams.length ? <optgroup label="Full stream choices">{audioStreams.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</optgroup> : null}
                {options.audioTracks.length ? <optgroup label="Reported languages and tracks">{options.audioTracks.map((track) => <option key={track.id} value={track.id}>{track.label}</option>)}</optgroup> : null}
              </SettingsSelect>
              {source.streamCatalogUrl ? <><p className="lumora-player-catalog-status">Select different audio streams to find your preferred audio.</p><p className="lumora-player-catalog-status">Numbered audio changes the full stream, including video, not an independent audio track. Manual quality is never lowered automatically. Choose Audio Auto to unpin.</p></> : null}
            </> : null}
            {activePanel === 'subtitles' ? <><SettingsSelect label="Subtitles" value={preferences.subtitle} disabled={!subtitlesAvailable && !subtitleMissing} status={subtitleMissing ? 'Selected track unavailable' : !subtitlesAvailable ? 'No subtitles reported' : undefined} onChange={(id) => chooseRef.current('subtitle', id)}><option value="off">{subtitlesAvailable || subtitleMissing ? 'Off' : 'Unavailable'}</option>{subtitleMissing ? <option value={preferences.subtitle} disabled>Selected subtitles (unavailable)</option> : null}{options.subtitles.map((track) => <option key={track.id} value={track.id}>{track.label}</option>)}</SettingsSelect><div className="lumora-subtitle-timing"><div><span>Subtitle timing</span><output aria-label="Subtitle timing offset">{timingOffset > 0 ? '+' : ''}{timingOffset.toFixed(2)}s</output></div><div className="lumora-subtitle-timing-controls"><button type="button" disabled={!subtitlesAvailable || preferences.subtitle === 'off' || timingOffset <= -10} aria-label="Advance subtitles by 0.25 seconds" onClick={() => delayRef.current(timingOffset - 0.25)}>-0.25s</button><button type="button" disabled={!subtitlesAvailable || timingOffset === 0} aria-label="Reset subtitle timing" onClick={() => delayRef.current(0)}>Reset</button><button type="button" disabled={!subtitlesAvailable || preferences.subtitle === 'off' || timingOffset >= 10} aria-label="Delay subtitles by 0.25 seconds" onClick={() => delayRef.current(timingOffset + 0.25)}>+0.25s</button></div><p>Negative plays captions earlier. Positive plays them later.</p></div></> : null}
            {activePanel === 'settings' ? <>
              <SettingsAction label="Display mode" status={displayMode === 'fit' ? 'Show the full frame' : displayMode === 'fill' ? 'Stretch video to fill the player' : 'Crop edges while preserving aspect ratio'} actionLabel={`Display mode ${displayModeLabel(displayMode)}. Change to ${displayModeLabel(nextMode)}`} buttonLabel={displayModeLabel(displayMode)} onClick={() => displayActionRef.current()} />
              {pictureInPictureSupport ? <SettingsAction label="Picture-in-Picture" status={pictureInPictureActive ? 'Video is in a floating window' : 'Keep video visible over other apps'} actionLabel={pictureInPictureActive ? 'Exit Picture-in-Picture' : 'Enter Picture-in-Picture'} buttonLabel={pictureInPicturePending ? 'Working...' : pictureInPictureActive ? 'Exit' : 'Open'} disabled={pictureInPictureBlocked || pictureInPicturePending} busy={pictureInPicturePending} pressed={pictureInPictureActive} onClick={() => pictureInPictureActionRef.current()} /> : null}
              <SettingsSelect label="Playback speed" value={String(playbackRate)} onChange={(value) => speedRef.current(Number(value))}>{[0.5, 0.75, 1, 1.25, 1.5, 2].map((rate) => <option key={rate} value={rate}>{rate === 1 ? 'Normal' : `${rate}x`}</option>)}</SettingsSelect>
              {props.onAutoNextChange ? <SettingsAction label="Auto Next" status={props.episodeNavigationDisabled ? 'Unavailable in a watch party' : !props.episodeNavigation?.next ? 'No verified next episode' : 'Play the next verified episode only when this one ends'} actionLabel={props.autoNext ? 'Turn off Auto Next' : 'Turn on Auto Next'} buttonLabel={props.autoNext ? 'On' : 'Off'} pressed={props.autoNext ?? false} disabled={props.episodeNavigationDisabled || !props.episodeNavigation?.next || props.episodeNavigationPending} onClick={() => {
                const latest = latestProps.current;
                if (!latest.episodeNavigationDisabled && !latest.episodeNavigationPending && latest.episodeNavigation?.next) latest.onAutoNextChange?.(!latest.autoNext);
              }} /> : null}
              {sources.length > 1 && onSelectSource ? <SettingsSelect label="Playback fallback" value={selectedSourceId ?? sources[0]?.id ?? ''} onChange={(id) => sourceSelectionRef.current(id)}>{sources.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</SettingsSelect> : null}
              <SettingsAction label="Show ping" status="Measure connection latency to this site" actionLabel={showPing ? 'Hide ping' : 'Show ping'} buttonLabel={showPing ? 'On' : 'Off'} pressed={showPing} onClick={togglePing} />
              <details className="lumora-player-shortcuts">
                <summary>Keyboard shortcuts</summary>
                <dl>
                  <div><dt>Play or pause</dt><dd><kbd>Space</kbd><kbd>K</kbd></dd></div>
                  <div><dt>Seek 5 seconds</dt><dd><kbd>Left</kbd><kbd>Right</kbd></dd></div>
                  <div><dt>Seek 10 seconds</dt><dd><kbd>J</kbd><kbd>L</kbd></dd></div>
                  <div><dt>Volume</dt><dd><kbd>Up</kbd><kbd>Down</kbd></dd></div>
                  <div><dt>Mute</dt><dd><kbd>M</kbd></dd></div>
                  <div><dt>Fullscreen</dt><dd><kbd>F</kbd></dd></div>
                  <div><dt>Captions</dt><dd><kbd>C</kbd></dd></div>
                  <div><dt>Picture-in-Picture</dt><dd><kbd>I</kbd></dd></div>
                  <div><dt>Start or end</dt><dd><kbd>Home</kbd><kbd>End</kbd></dd></div>
                  <div><dt>Seek by percentage</dt><dd><kbd>0-9</kbd></dd></div>
                  <div><dt>Up next</dt><dd><kbd>Shift</kbd><kbd>N</kbd></dd></div>
                  {props.episodeNavigation?.previous ? <div><dt>Previous episode</dt><dd><kbd>Shift</kbd><kbd>P</kbd></dd></div> : null}
                </dl>
              </details>
            </> : null}
            {catalogStatus !== 'ready' ? <p className="lumora-player-catalog-status" role="status">{catalogStatus === 'loading' ? 'Discovering available quality and language options...' : 'Some stream options could not be loaded. Current playback is unaffected.'}</p> : null}
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
      {introVisible && introRef.current && !switching && !adBreak && !adLoading && castStatus.state !== 'connecting' ? <button ref={skipIntroButtonRef} type="button" data-player-ui="" className={`lumora-player-skip-intro${castStatus.state === 'connected' ? ' is-casting' : ''}`} disabled={introPending} aria-busy={introPending} onClick={() => skipIntroRef.current()}>Skip intro<span aria-hidden="true">&gt;|</span></button> : null}
      {introNotice ? <div className="lumora-player-intro-notice" data-player-ui="" role="status">{introNotice}</div> : null}
      {selectionNotice ? <div className="lumora-player-intro-notice" data-player-ui="" role="alert">{selectionNotice}</div> : null}
      {pictureInPictureNotice ? <div className="lumora-player-pip-notice" data-player-ui="" role="status">{pictureInPictureNotice}</div> : null}
      {showPing ? <output className={`lumora-player-ping is-${pingStatus.state}`} data-player-ui="" role="status" aria-live="off" aria-label={`Connection latency: ${pingLabel(pingStatus)}`}>{pingLabel(pingStatus)}</output> : null}
      {props.upNext ? <a ref={upNextLinkRef} href={props.episodeNavigationDisabled ? undefined : props.upNext.href} aria-disabled={props.episodeNavigationDisabled || props.episodeNavigationPending} hidden={!upNextVisible} className={upNextVisible ? 'lumora-player-up-next' : undefined} data-player-up-next="" data-player-ui="" onClick={(event) => {
        if (!latestProps.current.onNavigateEpisode && !latestProps.current.episodeNavigationDisabled) return;
        event.preventDefault();
        if (!latestProps.current.episodeNavigationDisabled && !latestProps.current.episodeNavigationPending) latestProps.current.onNavigateEpisode?.('next');
      }}><span className="lumora-player-eyebrow">Up next</span><strong>{props.upNext.name}</strong><span>Play next episode</span></a> : null}
      {fullscreenActive && props.episodeNavigation && props.onNavigateEpisode ? <div className="lumora-player-episode-controls" data-player-ui=""><EpisodeControls {...props.episodeNavigation} disabled={props.episodeNavigationDisabled} pending={props.episodeNavigationPending} onNavigate={props.onNavigateEpisode} /></div> : null}
      {switching ? <div className={`lumora-player-switch-status${showPing ? ' has-ping' : ''}`} role="status">Updating playback<span>Your position is preserved</span></div> : null}
      {adLoading ? <div className="lumora-vast-loading" role="status">Loading advertisement</div> : null}
      {adBreak ? <VastAdBreak key={adBreak.creative.id} {...adBreak} onDone={(result) => adDoneRef.current(result)} /> : null}
      {seekFeedback ? <div key={seekFeedback.sequence} className={`lumora-player-seek-feedback is-${seekFeedback.side}`} role="status"><span aria-hidden="true">{seekFeedback.side === 'left' ? '-' : '+'}{seekFeedback.seconds}</span><span>{seekFeedback.side === 'left' ? 'Back' : 'Forward'} {seekFeedback.seconds} seconds</span></div> : null}
    </>, portalTarget) : null}
  </div>;
}

function SettingsSelect({ label, value, onChange, disabled, status, children }: { label: string; value: string; onChange: (value: string) => void; disabled?: boolean; status?: string; children: React.ReactNode }) {
  return <label className="lumora-player-setting"><span>{label}{status ? <small>{status}</small> : null}</span><select aria-label={label} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>{children}</select></label>;
}

function SettingsAction({ label, status, actionLabel, buttonLabel, disabled, busy, pressed, onClick }: { label: string; status: string; actionLabel: string; buttonLabel: string; disabled?: boolean; busy?: boolean; pressed?: boolean; onClick: () => void }) {
  return <div className="lumora-player-setting"><span>{label}<small>{status}</small></span><button type="button" className="lumora-player-setting-action" aria-label={actionLabel} aria-busy={busy} aria-pressed={pressed} disabled={disabled} onClick={onClick}>{buttonLabel}</button></div>;
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
