'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type Player from 'video.js/dist/types/player';
import { reportProgressAction } from '@/features/playback/progress-actions';
import { updateGuestPosition } from '@/features/playback/guest-watch';

export interface NativePlayerProps {
  source: { url: string; kind: 'mp4' | 'hls' | 'dash' };
  titleId: string;
  titleSlug: string;
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

interface TrackOption { id: string; label: string }
interface QualityLevel { id: string; height?: number; bitrate?: number; enabled: boolean }
interface AudioTrack { id: string; label: string; language: string; enabled: boolean }
interface TextTrack { id: string; label: string; language: string; kind: string; mode: TextTrackMode }
interface QualityLevelList {
  readonly length: number;
  readonly selectedIndex: number;
  readonly [index: number]: QualityLevel | undefined;
  on: (event: 'addqualitylevel' | 'removequalitylevel' | 'change', listener: () => void) => void;
  off: (event: 'addqualitylevel' | 'removequalitylevel' | 'change', listener: () => void) => void;
}
interface PublicTrackList<Track> {
  readonly length: number;
  readonly [index: number]: Track | undefined;
  on: (event: 'addtrack' | 'removetrack' | 'change', listener: () => void) => void;
  off: (event: 'addtrack' | 'removetrack' | 'change', listener: () => void) => void;
}
type PlayerWithQualityLevels = Player & { qualityLevels: () => QualityLevelList };

const REPORT_INTERVAL_SECONDS = 5;
const QUALITY_PREF_PREFIX = 'lumora:pref:quality:';

function readQualityPref(titleSlug: string): number | null {
  try {
    const raw = localStorage.getItem(`${QUALITY_PREF_PREFIX}${titleSlug}`);
    const height = raw ? Number.parseInt(raw, 10) : NaN;
    return Number.isInteger(height) && height > 0 ? height : null;
  } catch { return null; }
}

function writeQualityPref(titleSlug: string, height: number): void {
  try { localStorage.setItem(`${QUALITY_PREF_PREFIX}${titleSlug}`, String(height)); } catch { /* Best effort. */ }
}

function clearQualityPref(titleSlug: string): void {
  try { localStorage.removeItem(`${QUALITY_PREF_PREFIX}${titleSlug}`); } catch { /* Best effort. */ }
}

function mimeType(kind: NativePlayerProps['source']['kind']): string {
  return kind === 'hls' ? 'application/x-mpegURL' : kind === 'dash' ? 'application/dash+xml' : 'video/mp4';
}

function qualityLevelEntries(list: QualityLevelList): QualityLevel[] {
  const levels: QualityLevel[] = [];
  for (let index = 0; index < list.length; index += 1) {
    const level = list[index];
    if (level) levels.push(level);
  }
  return levels;
}

function audioTrackList(player: Player): PublicTrackList<AudioTrack> {
  return player.audioTracks() as unknown as PublicTrackList<AudioTrack>;
}

function textTrackList(player: Player): PublicTrackList<TextTrack> {
  return player.textTracks() as unknown as PublicTrackList<TextTrack>;
}

function configureMediaElement(player: Player): void {
  const video = player.el().querySelector('video');
  if (!(video instanceof HTMLVideoElement)) return;
  try {
    (video as HTMLVideoElement & { controlsList?: { add: (...tokens: string[]) => void } }).controlsList?.add('nodownload', 'noremoteplayback');
  } catch { /* Unsupported browser. */ }
  video.disablePictureInPicture = true;
  video.disableRemotePlayback = true;
  video.playsInline = true;
}

export function NativePlayer({ source, sources, selectedSourceId, onSelectSource, titleId, titleSlug, episodeId, seasonNumber, episodeNumber, initialPosition, posterUrl, onReady, onError }: NativePlayerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<Player | null>(null);
  const qualityLevelListRef = useRef<QualityLevelList | null>(null);
  const preferredQualityHeightRef = useRef<number | null>(null);
  const selectedQualityIdRef = useRef<string | null>(null);
  const resumedRef = useRef(false);
  const lastReportedRef = useRef(0);
  const [qualityLevels, setQualityLevels] = useState<TrackOption[]>([]);
  const [audioTracks, setAudioTracks] = useState<TrackOption[]>([]);
  const [subtitleTracks, setSubtitleTracks] = useState<TrackOption[]>([]);
  const [activeQuality, setActiveQuality] = useState('auto');
  const [activeAudio, setActiveAudio] = useState('');
  const [activeSubtitle, setActiveSubtitle] = useState('off');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsPortalTarget, setSettingsPortalTarget] = useState<Element | null>(null);

  const report = useCallback((player: Player) => {
    const currentTime = player.currentTime();
    const duration = player.duration();
    const positionSeconds = typeof currentTime === 'number' && Number.isFinite(currentTime) ? currentTime : 0;
    const durationSeconds = typeof duration === 'number' && Number.isFinite(duration) ? duration : undefined;
    const guestPosition = () => updateGuestPosition(titleSlug, positionSeconds, durationSeconds, {
      ...(episodeId ? { episodeId } : {}),
      ...(seasonNumber !== undefined ? { seasonNumber } : {}),
      ...(episodeNumber !== undefined ? { episodeNumber } : {}),
    });
    void reportProgressAction({ titleId, ...(episodeId ? { episodeId } : {}), positionSeconds, durationSeconds })
      .then((result) => { if (!result.ok) guestPosition(); })
      .catch(guestPosition);
  }, [titleId, titleSlug, episodeId, seasonNumber, episodeNumber]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    let player: Player | null = null;
    let playerElement: Element | null = null;
    let qualityList: QualityLevelList | null = null;
    let detachTrackListeners: (() => void) | null = null;
    let readyReported = false;
    let fatalErrorReported = false;
    resumedRef.current = false;
    lastReportedRef.current = 0;
    preferredQualityHeightRef.current = readQualityPref(titleSlug);
    selectedQualityIdRef.current = null;
    qualityLevelListRef.current = null;
    setQualityLevels([]); setAudioTracks([]); setSubtitleTracks([]);
    setActiveQuality('auto'); setActiveAudio(''); setActiveSubtitle('off'); setSettingsOpen(false);

    const videoElement = document.createElement('video-js');
    videoElement.className = 'video-js lumora-videojs h-full w-full';
    videoElement.setAttribute('aria-label', 'Video player');
    videoElement.setAttribute('controlslist', 'nodownload noremoteplayback');
    videoElement.setAttribute('disablepictureinpicture', '');
    videoElement.setAttribute('disableremoteplayback', '');
    container.appendChild(videoElement);

    const markReady = () => {
      if (cancelled || readyReported) return;
      readyReported = true;
      onReady?.();
    };
    const reportFatalError = () => {
      if (cancelled || fatalErrorReported) return;
      fatalErrorReported = true;
      onError?.();
    };

    void import('video.js').then(({ default: createPlayer }) => {
      if (cancelled) return;
      const videoPlayer = createPlayer(videoElement, {
        controls: true,
        preload: 'metadata',
        playsinline: true,
        responsive: true,
        fill: true,
        disablePictureInPicture: true,
        playbackRates: [0.5, 0.75, 1, 1.25, 1.5, 2],
        sources: [{ src: source.url, type: mimeType(source.kind) }],
        ...(posterUrl ? { poster: posterUrl } : {}),
        html5: {
          vhs: { overrideNative: true, limitRenditionByPlayerDimensions: true },
          ...(source.kind !== 'mp4' ? { nativeAudioTracks: false, nativeVideoTracks: false, nativeTextTracks: false } : {}),
        },
        controlBar: { pictureInPictureToggle: false },
      });
      player = videoPlayer;
      playerRef.current = videoPlayer;
      playerElement = videoPlayer.el();
      setSettingsPortalTarget(playerElement);

      qualityList = (videoPlayer as PlayerWithQualityLevels).qualityLevels();
      qualityLevelListRef.current = qualityList;
      const audioList = audioTrackList(videoPlayer);
      const textList = textTrackList(videoPlayer);

      const refreshQualityLevels = () => {
        if (cancelled || !qualityList) return;
        const levels = qualityLevelEntries(qualityList);
        setQualityLevels(levels.map((level, index) => ({
          id: String(level.id),
          label: level.height ? `${level.height}p` : level.bitrate ? `${Math.round(level.bitrate / 1000)} kbps` : `Quality ${index + 1}`,
        })));

        const selectedId = selectedQualityIdRef.current;
        const preferredHeight = preferredQualityHeightRef.current;
        const preferred = (selectedId ? levels.find((level) => String(level.id) === selectedId) : undefined)
          ?? (preferredHeight ? levels.find((level) => level.height === preferredHeight) : undefined);
        if (preferred) {
          const preferredId = String(preferred.id);
          selectedQualityIdRef.current = preferredId;
          for (const level of levels) level.enabled = String(level.id) === preferredId;
          setActiveQuality(preferredId);
          return;
        }

        selectedQualityIdRef.current = null;
        for (const level of levels) level.enabled = true;
        setActiveQuality('auto');
      };
      const refreshAudioTracks = () => {
        if (cancelled) return;
        const audioOptions: TrackOption[] = [];
        let enabledId = '';
        for (let index = 0; index < audioList.length; index += 1) {
          const track = audioList[index];
          if (!track) continue;
          audioOptions.push({ id: track.id, label: track.label || track.language || `Audio ${index + 1}` });
          if (track.enabled) enabledId = track.id;
        }
        setAudioTracks(audioOptions);
        setActiveAudio(enabledId);
      };
      const refreshSubtitleTracks = () => {
        if (cancelled) return;
        const subtitleOptions: TrackOption[] = [];
        let showingId = 'off';
        for (let index = 0; index < textList.length; index += 1) {
          const track = textList[index];
          if (!track || (track.kind !== 'subtitles' && track.kind !== 'captions')) continue;
          subtitleOptions.push({ id: track.id, label: track.label || track.language || `Subtitle ${index + 1}` });
          if (track.mode === 'showing') showingId = track.id;
        }
        setSubtitleTracks(subtitleOptions);
        setActiveSubtitle(showingId);
      };
      const refreshTracks = () => {
        refreshQualityLevels();
        refreshAudioTracks();
        refreshSubtitleTracks();
      };

      qualityList.on('addqualitylevel', refreshQualityLevels);
      qualityList.on('removequalitylevel', refreshQualityLevels);
      qualityList.on('change', refreshQualityLevels);
      audioList.on('addtrack', refreshAudioTracks);
      audioList.on('removetrack', refreshAudioTracks);
      audioList.on('change', refreshAudioTracks);
      textList.on('addtrack', refreshSubtitleTracks);
      textList.on('removetrack', refreshSubtitleTracks);
      textList.on('change', refreshSubtitleTracks);
      detachTrackListeners = () => {
        qualityList?.off('addqualitylevel', refreshQualityLevels);
        qualityList?.off('removequalitylevel', refreshQualityLevels);
        qualityList?.off('change', refreshQualityLevels);
        audioList.off('addtrack', refreshAudioTracks);
        audioList.off('removetrack', refreshAudioTracks);
        audioList.off('change', refreshAudioTracks);
        textList.off('addtrack', refreshSubtitleTracks);
        textList.off('removetrack', refreshSubtitleTracks);
        textList.off('change', refreshSubtitleTracks);
      };

      const handleMetadata = () => {
        if (!resumedRef.current && initialPosition && initialPosition > 0) {
          resumedRef.current = true;
          videoPlayer.currentTime(initialPosition);
        }
        refreshTracks();
        markReady();
      };
      const handleTimeUpdate = () => {
        const currentTime = videoPlayer.currentTime() ?? 0;
        if (currentTime - lastReportedRef.current >= REPORT_INTERVAL_SECONDS) {
          lastReportedRef.current = currentTime;
          report(videoPlayer);
        }
      };
      videoPlayer.on('loadedmetadata', handleMetadata);
      videoPlayer.on('loadeddata', refreshTracks);
      videoPlayer.on('timeupdate', handleTimeUpdate);
      videoPlayer.on('pause', () => { if (!cancelled) report(videoPlayer); });
      videoPlayer.on('ended', () => {
        if (cancelled) return;
        lastReportedRef.current = videoPlayer.currentTime() ?? 0;
        report(videoPlayer);
      });
      videoPlayer.on('error', reportFatalError);
      configureMediaElement(videoPlayer);
      refreshTracks();
      videoPlayer.ready(() => {
        if (cancelled || videoPlayer.isDisposed()) return;
        configureMediaElement(videoPlayer);
        refreshTracks();
        markReady();
      });
      if (videoPlayer.readyState() >= 1) handleMetadata();
    }).catch(reportFatalError);

    return () => {
      cancelled = true;
      detachTrackListeners?.();
      if (qualityLevelListRef.current === qualityList) qualityLevelListRef.current = null;
      if (playerRef.current === player) playerRef.current = null;
      setSettingsPortalTarget((current) => current === playerElement ? null : current);
      if (player && !player.isDisposed()) player.dispose();
      videoElement.remove();
    };
  }, [source.url, source.kind, initialPosition, posterUrl, report, onReady, onError, titleSlug]);

  const handleQualityChange = (id: string) => {
    const list = qualityLevelListRef.current;
    if (!list) return;
    const levels = qualityLevelEntries(list);
    if (id === 'auto') {
      selectedQualityIdRef.current = null;
      preferredQualityHeightRef.current = null;
      for (const level of levels) level.enabled = true;
      setActiveQuality('auto');
      clearQualityPref(titleSlug);
      return;
    }

    const selected = levels.find((level) => String(level.id) === id);
    if (!selected) return;
    const preferredHeight = typeof selected.height === 'number' && selected.height > 0 ? selected.height : null;
    selectedQualityIdRef.current = id;
    preferredQualityHeightRef.current = preferredHeight;
    for (const level of levels) level.enabled = String(level.id) === id;
    setActiveQuality(id);
    if (preferredHeight) writeQualityPref(titleSlug, preferredHeight);
    else clearQualityPref(titleSlug);
  };
  const handleAudioChange = (id: string) => {
    const player = playerRef.current;
    if (!player) return;
    const tracks = audioTrackList(player);
    let hasSelectedTrack = false;
    for (let index = 0; index < tracks.length; index += 1) {
      if (tracks[index]?.id === id) hasSelectedTrack = true;
    }
    if (!hasSelectedTrack) return;
    for (let index = 0; index < tracks.length; index += 1) {
      const track = tracks[index];
      if (track) track.enabled = track.id === id;
    }
    setActiveAudio(id);
  };
  const handleSubtitleChange = (id: string) => {
    const player = playerRef.current;
    if (!player) return;
    const tracks = textTrackList(player);
    let hasSelectedTrack = id === 'off';
    for (let index = 0; index < tracks.length; index += 1) {
      const track = tracks[index];
      if (track && (track.kind === 'subtitles' || track.kind === 'captions') && track.id === id) hasSelectedTrack = true;
    }
    if (!hasSelectedTrack) return;
    for (let index = 0; index < tracks.length; index += 1) {
      const track = tracks[index];
      if (track && (track.kind === 'subtitles' || track.kind === 'captions')) track.mode = id !== 'off' && track.id === id ? 'showing' : 'disabled';
    }
    setActiveSubtitle(id);
  };
  const serverOptions = sources ?? [];
  const hasServerControls = serverOptions.length > 1 && Boolean(onSelectSource);
  const hasTrackControls = hasServerControls || qualityLevels.length > 0 || audioTracks.length > 0 || subtitleTracks.length > 0;

  return (
    <div className="relative h-full w-full bg-black">
      <div ref={containerRef} data-vjs-player="" className="h-full w-full" onContextMenu={(event) => event.preventDefault()} />
      {settingsPortalTarget && hasTrackControls ? createPortal(<div className="absolute bottom-14 right-3 z-20">
        <button type="button" onClick={() => setSettingsOpen((open) => !open)} aria-expanded={settingsOpen} aria-controls="hls-settings" className="inline-flex h-10 items-center rounded-full border border-white/20 bg-black/75 px-3 text-xs font-semibold text-white shadow-soft backdrop-blur transition hover:bg-black/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">Settings</button>
        {settingsOpen ? <div id="hls-settings" className="absolute bottom-12 right-0 max-h-[calc(100cqh-7rem)] w-64 overflow-y-auto rounded-xl border border-white/15 bg-zinc-950/95 p-2 text-sm text-white shadow-raised backdrop-blur">
          <p className="px-2 pb-2 pt-1 text-xs font-semibold uppercase tracking-wider text-white/55">Playback settings</p>
          {hasServerControls ? <SettingsSelect label="Server" value={selectedSourceId ?? serverOptions[0]?.id ?? ''} onChange={(id) => onSelectSource?.(id)}>{serverOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</SettingsSelect> : null}
          {qualityLevels.length > 0 ? <SettingsSelect label="Quality" value={activeQuality} onChange={handleQualityChange}><option value="auto">Auto</option>{qualityLevels.map((level) => <option key={level.id} value={level.id}>{level.label}</option>)}</SettingsSelect> : null}
          {audioTracks.length > 0 ? <SettingsSelect label="Audio" value={activeAudio} onChange={handleAudioChange}>{audioTracks.map((track) => <option key={track.id} value={track.id}>{track.label}</option>)}</SettingsSelect> : null}
          {subtitleTracks.length > 0 ? <SettingsSelect label="Subtitles" value={activeSubtitle} onChange={handleSubtitleChange}><option value="off">Off</option>{subtitleTracks.map((track) => <option key={track.id} value={track.id}>{track.label}</option>)}</SettingsSelect> : null}
        </div> : null}
      </div>, settingsPortalTarget) : null}
    </div>
  );
}

function SettingsSelect({ label, value, onChange, children }: { label: string; value: string; onChange: (value: string) => void; children: React.ReactNode }) {
  return <label className="flex items-center justify-between gap-3 rounded-lg px-2 py-2 hover:bg-white/10"><span className="text-white/75">{label}</span><select value={value} onChange={(event) => onChange(event.target.value)} className="max-w-36 rounded-md border border-white/15 bg-white/10 px-2 py-1 text-right text-xs text-white outline-none focus:border-primary">{children}</select></label>;
}
