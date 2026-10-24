'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
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
}

export function NativePlayer({ source, titleId, titleSlug, episodeId, seasonNumber, episodeNumber, initialPosition, posterUrl, onReady, onError }: NativePlayerProps) {
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
    const video = videoRef.current;
    if (!video) return;
    let cancelled = false;
    let player: Player | null = null;
    let hls: Hls | null = null;
    let fallbackStarted = false;
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
    resumedRef.current = false;
    lastReportedRef.current = 0;
    setQualityLevels([]); setAudioTracks([]); setSubtitleTracks([]);
    setActiveQuality('auto'); setActiveAudio(''); setActiveSubtitle('off'); setSettingsOpen(false);
    try {
      (video as HTMLVideoElement & { controlsList?: { add: (...tokens: string[]) => void } }).controlsList?.add('nodownload', 'noremoteplayback');
    } catch { /* Unsupported browser. */ }
    video.disablePictureInPicture = true;
    video.disableRemotePlayback = true;

    void import('video.js').then(({ default: createPlayer }) => {
      if (cancelled) return;
      player = createPlayer(video, {
        controls: true,
        preload: 'metadata',
        responsive: true,
        fill: true,
        playbackRates: [0.5, 0.75, 1, 1.25, 1.5, 2],
        sources: [{ src: source.url, type: mimeType(source.kind) }],
        html5: { vhs: { limitRenditionByPlayerDimensions: true } },
        controlBar: { pictureInPictureToggle: false },
      });
      playerRef.current = player;

      const refreshTracks = () => {
        if (!player) return;
        const levels = representations();
        setQualityLevels(levels.map((level) => ({ id: level.id, label: level.height ? `${level.height}p` : 'Adaptive' })));
        const audio = audioTrackEntries(player);
        const audioOptions: TrackOption[] = [];
        for (let index = 0; index < audio.length; index += 1) {
          const track = audio[index];
          if (!track) continue;
          audioOptions.push({ id: track.id, label: track.label || track.language || `Audio ${index + 1}` });
          if (track.enabled) setActiveAudio(track.id);
        }
        setAudioTracks(audioOptions);
        const subtitles = textTrackEntries(player);
        const subtitleOptions: TrackOption[] = [];
        for (let index = 0; index < subtitles.length; index += 1) {
          const track = subtitles[index];
          if (!track || (track.kind !== 'subtitles' && track.kind !== 'captions')) continue;
          subtitleOptions.push({ id: track.id, label: track.label || track.language || `Subtitle ${index + 1}` });
          if (track.mode === 'showing') setActiveSubtitle(track.id);
        }
        setSubtitleTracks(subtitleOptions);
        const preferredHeight = readQualityPref(titleSlug);
        const preferred = preferredHeight ? levels.find((level) => level.height === preferredHeight) : undefined;
        if (preferred) {
          levels.forEach((level) => level.enabled(level.id === preferred.id));
          setActiveQuality(preferred.id);
        }
      };
      const handleMetadata = () => {
        if (!resumedRef.current && initialPosition && initialPosition > 0 && player) {
          resumedRef.current = true;
          player.currentTime(initialPosition);
        }
        refreshTracks();
      };
      const handleTimeUpdate = () => {
        if (video.currentTime - lastReportedRef.current >= REPORT_INTERVAL_SECONDS) {
          lastReportedRef.current = video.currentTime;
          report(video);
        }
      };
      player.on('loadedmetadata', handleMetadata);
      player.on('loadeddata', refreshTracks);
      player.on('timeupdate', handleTimeUpdate);
      player.on('pause', () => report(video));
      player.on('ended', () => { lastReportedRef.current = video.currentTime; report(video); });
      const startHlsFallback = () => {
        if (fallbackStarted || cancelled || source.kind !== 'hls') {
          onError?.();
          return;
        }
        fallbackStarted = true;
        if (fallbackTimer) clearTimeout(fallbackTimer);
        player?.dispose();
        playerRef.current = null;
        void import('hls.js').then(({ default: Hls }) => {
          if (cancelled || !Hls.isSupported()) {
            onError?.();
            return;
          }
          hls = new Hls();
          hlsRef.current = hls;
          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            setQualityLevels(hls!.levels.map((level, index) => ({ id: String(index), label: level.height ? `${level.height}p` : `Quality ${index + 1}` })));
            setAudioTracks(hls!.audioTracks.map((track) => ({ id: String(track.id), label: track.name || track.lang || `Audio ${track.id + 1}` })));
            setSubtitleTracks(hls!.subtitleTracks.map((track) => ({ id: String(track.id), label: track.name || track.lang || `Subtitle ${track.id + 1}` })));
            onReady?.();
          });
          hls.on(Hls.Events.ERROR, (_event, data) => { if (data.fatal) onError?.(); });
          hls.loadSource(source.url);
          hls.attachMedia(video);
        }).catch(() => onError?.());
      };
      if (source.kind === 'hls') fallbackTimer = setTimeout(startHlsFallback, 10_000);
      player.on('canplay', () => {
        if (fallbackTimer) clearTimeout(fallbackTimer);
        onReady?.();
      });
      player.on('error', startHlsFallback);
    }).catch(() => onError?.());

    return () => {
      cancelled = true;
      if (fallbackTimer) clearTimeout(fallbackTimer);
      player?.dispose();
      hls?.destroy();
      playerRef.current = null;
      hlsRef.current = null;
    };
  }, [source.url, source.kind, initialPosition, report, onReady, onError, titleSlug, representations]);

  const handleQualityChange = (id: string) => {
    const hls = hlsRef.current;
    if (hls) {
      hls.currentLevel = id === 'auto' ? -1 : Number(id);
      setActiveQuality(id);
      if (id === 'auto') clearQualityPref(titleSlug);
      else {
        const selected = hls.levels[Number(id)];
        if (selected?.height) writeQualityPref(titleSlug, selected.height);
      }
      return;
    }
    const levels = representations();
    levels.forEach((level) => level.enabled(id === 'auto' || level.id === id));
    setActiveQuality(id);
    if (id === 'auto') { clearQualityPref(titleSlug); return; }
    const selected = levels.find((level) => level.id === id);
    if (selected?.height) writeQualityPref(titleSlug, selected.height);
  };
  const handleAudioChange = (id: string) => {
    const hls = hlsRef.current;
    if (hls) {
      hls.audioTrack = Number(id);
      setActiveAudio(id);
      return;
    }
    const player = playerRef.current;
    const tracks = player ? audioTrackEntries(player) : undefined;
    if (!tracks) return;
    for (let index = 0; index < tracks.length; index += 1) {
      const track = tracks[index];
      if (track) track.enabled = track.id === id;
    }
    setActiveAudio(id);
  };
  const handleSubtitleChange = (id: string) => {
    const hls = hlsRef.current;
    if (hls) {
      hls.subtitleTrack = id === 'off' ? -1 : Number(id);
      setActiveSubtitle(id);
      return;
    }
    const player = playerRef.current;
    const tracks = player ? textTrackEntries(player) : undefined;
    if (!tracks) return;
    for (let index = 0; index < tracks.length; index += 1) {
      const track = tracks[index];
      if (track && (track.kind === 'subtitles' || track.kind === 'captions')) track.mode = id !== 'off' && track.id === id ? 'showing' : 'disabled';
    }
    setActiveSubtitle(id);
  };
  const hasTrackControls = qualityLevels.length > 0 || audioTracks.length > 0 || subtitleTracks.length > 0;

  return (
    <div className="relative h-full w-full bg-black">
      <video ref={videoRef} className="video-js lumora-videojs h-full w-full" aria-label="Video player" onContextMenu={(event) => event.preventDefault()} />
      {hasTrackControls ? <div className="absolute bottom-14 right-3 z-20">
        <button type="button" onClick={() => setSettingsOpen((open) => !open)} aria-expanded={settingsOpen} aria-controls="hls-settings" className="inline-flex h-10 items-center gap-2 rounded-full border border-white/20 bg-black/75 px-3 text-xs font-semibold text-white shadow-soft backdrop-blur transition hover:bg-black/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"><span aria-hidden="true">⚙</span> Settings</button>
        {settingsOpen ? <div id="hls-settings" className="absolute bottom-12 right-0 w-64 overflow-hidden rounded-xl border border-white/15 bg-zinc-950/95 p-2 text-sm text-white shadow-raised backdrop-blur">
          <p className="px-2 pb-2 pt-1 text-xs font-semibold uppercase tracking-wider text-white/55">Playback settings</p>
          {qualityLevels.length > 0 ? <SettingsSelect label="Quality" value={activeQuality} onChange={handleQualityChange}><option value="auto">Auto</option>{qualityLevels.map((level) => <option key={level.id} value={level.id}>{level.label}</option>)}</SettingsSelect> : null}
          {audioTracks.length > 0 ? <SettingsSelect label="Audio" value={activeAudio} onChange={handleAudioChange}>{audioTracks.map((track) => <option key={track.id} value={track.id}>{track.label}</option>)}</SettingsSelect> : null}
          {subtitleTracks.length > 0 ? <SettingsSelect label="Subtitles" value={activeSubtitle} onChange={handleSubtitleChange}><option value="off">Off</option>{subtitleTracks.map((track) => <option key={track.id} value={track.id}>{track.label}</option>)}</SettingsSelect> : null}
        </div> : null}
      </div> : null}
    </div>
  );
}

function SettingsSelect({ label, value, onChange, children }: { label: string; value: string; onChange: (value: string) => void; children: React.ReactNode }) {
  return <label className="flex items-center justify-between gap-3 rounded-lg px-2 py-2 hover:bg-white/10"><span className="text-white/75">{label}</span><select value={value} onChange={(event) => onChange(event.target.value)} className="max-w-36 rounded-md border border-white/15 bg-white/10 px-2 py-1 text-right text-xs text-white outline-none focus:border-primary">{children}</select></label>;
}
