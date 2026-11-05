import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Animated, AppState, BackHandler, Platform, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions, type GestureResponderEvent } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { isPictureInPictureSupported, useVideoPlayer, VideoView, type AudioTrack, type SubtitleTrack, type VideoContentFit } from 'expo-video';
import * as ScreenOrientation from 'expo-screen-orientation';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { fetchStreamCatalog, fetchSubtitleCatalog, fetchVastCreative, sameOriginPlaybackUrl, withPlaybackDeadline } from '../lib/api';
import type { DirectStream, IntroMarker, NativeAdPolicy, NativeVastCreative, PlaybackSource, Subtitle } from '../lib/types';
import { colors } from '../theme';
import { audioStreamOptions, chooseStream, compatiblePreferences, DEFAULT_PREFERENCES, qualityHeight, qualityKey, streamPlaybackUrl, trackKey,
  type AudioStreamOption, type Preferences } from './options';
import { doubleTap, parseVtt, subtitleText, type Cue, type Tap } from './subtitles';
import { acquireOrientation } from './orientation';
import NativeVastAd from './VastAdBreak';
import { createNativeAdResume, createNativeAdSchedule, validNativeAdPolicy } from './policy';
import { canQueryPictureInPicture, nativeSourceUrl, SOURCE_READY_TIMEOUT_MS } from './capabilities';
import type { WatchPartyMediaIdentity, WatchPartyPlaybackState, WatchPartyRole } from '../watch-party/protocol';
import type { PartyPlayerBlockReason, PartyPlayerIntent, PartyPlayerPort,
  PartyPlayerSnapshot, RegisterPartyPlayerPort } from '../watch-party/player-port';

export interface Snapshot { positionSeconds: number; durationSeconds?: number; playing: boolean }
export interface EpisodeControls {
  previous: { label: string; onPress: () => void } | null;
  next: { label: string; onPress: () => void } | null;
  autoNext: boolean;
  onAutoNextChange: (enabled: boolean) => void;
  blocked: boolean;
  loading: boolean;
  notice?: string;
  onRetry?: () => void;
}
const AD_CONSENT_KEY = 'lumora:ads:consent';
export const DISPLAY_MODE_KEY = 'lumora:player:display-mode:v1';
const PICTURE_IN_PICTURE_START_TIMEOUT_MS = 3000;
export type DisplayMode = 'fit' | 'fill' | 'zoom';

interface PictureInPictureSession {
  token: object;
  generation: number;
  url: string;
  snapshot: Snapshot;
  rate: number;
}

export function parseDisplayMode(value: unknown): DisplayMode | null {
  return value === 'fit' || value === 'fill' || value === 'zoom' ? value : null;
}

export function displayModeContentFit(mode: DisplayMode): VideoContentFit {
  return mode === 'fit' ? 'contain' : mode === 'fill' ? 'fill' : 'cover';
}

export function canSkipIntro(intro: IntroMarker | null | undefined, positionSeconds: number, durationSeconds: number, blocked = false): intro is IntroMarker {
  return !blocked && !!intro && Number.isFinite(intro.startSeconds) && Number.isFinite(intro.endSeconds)
    && intro.startSeconds >= 0 && intro.endSeconds > intro.startSeconds
    && Number.isFinite(positionSeconds) && positionSeconds >= intro.startSeconds && positionSeconds < intro.endSeconds
    && Number.isFinite(durationSeconds) && durationSeconds > 0 && intro.endSeconds <= durationSeconds;
}

function Action({ label, accessibilityLabel, displayLabel, onPress, selected, disabled, prominent, toggle }: {
  label: string; accessibilityLabel?: string; displayLabel?: string; onPress: () => void; selected?: boolean; disabled?: boolean; prominent?: boolean; toggle?: boolean;
}) {
  return <Pressable accessibilityRole={toggle ? 'switch' : 'button'} accessibilityLabel={accessibilityLabel ?? label}
    accessibilityState={{ selected, disabled, ...(toggle ? { checked: selected } : {}) }}
    disabled={disabled} onPress={onPress} style={[styles.button, prominent && styles.playButton, selected && styles.selected, disabled && { opacity: 0.45 }]}>
    <Text style={[styles.buttonText, prominent && styles.playText]}>{displayLabel ?? label}</Text>
  </Pressable>;
}

function SettingsHeading({ label, summary, expanded, onPress }: { label: string; summary: string; expanded: boolean; onPress: () => void }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={`${label} settings`} accessibilityState={{ expanded }} onPress={onPress}
    style={styles.settingsHeading}><Text style={styles.label}>{label}</Text>
    <Text style={styles.settingSummary} numberOfLines={1}>{summary} {expanded ? '-' : '+'}</Text></Pressable>;
}

function timeLabel(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
}

export default function NativePlayer({ source, initial, subtitleCatalogUrl, intro, adPolicy, episodes,
  partyMedia, partyConnected = false, partyRole = null, partyPlayback, registerPartyPlayerPort,
  onCheckpoint, onError, header, footer }: {
  source: PlaybackSource;
  initial: Snapshot;
  subtitleCatalogUrl?: string;
  intro?: IntroMarker | null;
  adPolicy?: NativeAdPolicy;
  episodes?: EpisodeControls;
  partyMedia?: WatchPartyMediaIdentity | null;
  partyConnected?: boolean;
  partyRole?: WatchPartyRole | null;
  partyPlayback?: WatchPartyPlaybackState | null;
  registerPartyPlayerPort?: RegisterPartyPlayerPort;
  onCheckpoint: (snapshot: Snapshot) => void;
  onError?: (pinnedAudioStream?: DirectStream) => void;
  header: ReactNode;
  footer: ReactNode;
}) {
  const player = useVideoPlayer(null, (p) => { p.timeUpdateEventInterval = 0.25; p.staysActiveInBackground = false; p.loop = false; });
  const videoView = useRef<VideoView | null>(null);
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const [fullscreen, setFullscreen] = useState(false);
  const [fullscreenTransitioningState, setFullscreenTransitioningState] = useState(false);
  const [settings, setSettings] = useState(false);
  const [settingsSection, setSettingsSection] = useState<'quality' | 'audio' | 'subtitles' | 'speed' | 'display' | null>('quality');
  const settingsMotion = useRef(new Animated.Value(0)).current;
  const [chrome, setChrome] = useState(true);
  const [position, setPosition] = useState(initial.positionSeconds);
  const [duration, setDuration] = useState(initial.durationSeconds ?? 0);
  const [playing, setPlaying] = useState(initial.playing);
  const [loading, setLoading] = useState(true);
  const [rate, setRate] = useState(1);
  const [catalog, setCatalog] = useState<{ sourceId: string; streams: DirectStream[] } | null>(null);
  const [selection, setSelection] = useState<{ sourceId: string; stream: DirectStream } | null>(null);
  const [audioSelection, setAudioSelection] = useState<{ sourceId: string; option: AudioStreamOption } | null>(null);
  const [preferences, setPreferences] = useState<Preferences>(DEFAULT_PREFERENCES);
  const [audioTracks, setAudioTracks] = useState<AudioTrack[]>([]);
  const [subtitleTracks, setSubtitleTracks] = useState<SubtitleTrack[]>([]);
  const [sidecars, setSidecars] = useState<Subtitle[]>([]);
  const [cues, setCues] = useState<Cue[]>([]);
  const [offset, setOffset] = useState(0);
  const [notice, setNotice] = useState('');
  const [catalogNotice, setCatalogNotice] = useState('');
  const [trackNotice, setTrackNotice] = useState('');
  const [playbackFailed, setPlaybackFailed] = useState(false);
  const [replacementAttempt, setReplacementAttempt] = useState(0);
  const [videoResolution, setVideoResolution] = useState('');
  const [controlsHeight, setControlsHeight] = useState(190);
  const [headerHeight, setHeaderHeight] = useState(96);
  const [captionHeight, setCaptionHeight] = useState(48);
  const [introSeeking, setIntroSeeking] = useState(false);
  const [displayMode, setDisplayMode] = useState<DisplayMode>('fit');
  const [pictureInPictureSupported] = useState(() => {
    if (!canQueryPictureInPicture(Platform.OS, Platform.Version)) return false;
    try { return isPictureInPictureSupported(); } catch { return false; }
  });
  const [pictureInPictureBusy, setPictureInPictureBusy] = useState(false);
  const [pictureInPictureState, setPictureInPictureState] = useState(false);
  const [adConsent, setAdConsent] = useState(false);
  const [adBusy, setAdBusy] = useState(false);
  const [ad, setAd] = useState<{ creative: NativeVastCreative; policy: NativeAdPolicy; volume: number; muted: boolean } | null>(null);
  const snapshot = useRef<Snapshot>(initial);
  const callbacks = useRef({ onCheckpoint, onError });
  callbacks.current = { onCheckpoint, onError };
  const sourceRef = useRef(source); sourceRef.current = source;
  const audioSelectionRef = useRef(audioSelection); audioSelectionRef.current = audioSelection;
  const pinnedAudio = audioSelection?.sourceId === source.id ? audioSelection.option : null;
  const selectedStream = pinnedAudio?.stream ?? (selection?.sourceId === source.id ? selection.stream : null);
  const streams = catalog?.sourceId === source.id ? catalog.streams : [];
  const desired = useRef(preferences);
  desired.current = preferences;
  const selectedRef = useRef(selectedStream);
  selectedRef.current = selectedStream;
  const replacing = useRef(true);
  const playbackFailure = useRef(false);
  const observed = useRef(false);
  const alive = useRef(true);
  const generation = useRef(0);
  const pending = useRef<{ generation: number; url: string; snapshot: Snapshot; metadataLoaded: boolean; ready: boolean; duration: number } | null>(null);
  const nativeUrl = useRef<string | null>(null);
  const readySource = useRef<{ generation: number; url: string } | null>(null);
  const endedGeneration = useRef<number | null>(null);
  const episodeControls = useRef(episodes); episodeControls.current = episodes;
  const pendingAutoNext = useRef<boolean | null>(null);
  const previousAutoNext = useRef(episodes?.autoNext);
  if (previousAutoNext.current !== episodes?.autoNext || episodes?.blocked || partyConnected) {
    pendingAutoNext.current = null;
    previousAutoNext.current = episodes?.autoNext;
  }
  const sourceDeadline = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastFlush = useRef(0);
  const requestedRate = useRef(rate);
  requestedRate.current = rate;
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const timelineWidth = useRef(Math.max(1, width - insets.left - insets.right - 32));
  const lastTap = useRef<Tap | null>(null);
  const advertisingConsent = useRef(false);
  const consentVersion = useRef(0);
  const consentWrites = useRef<Promise<void>>(Promise.resolve());
  const displayModeVersion = useRef(0);
  const displayModeWrites = useRef<Promise<void>>(Promise.resolve());
  const fullscreenTransitioning = useRef(false);
  const pictureInPicturePending = useRef(false);
  const pictureInPictureActive = useRef(false);
  const pictureInPictureSession = useRef<PictureInPictureSession | null>(null);
  const pictureInPictureRestore = useRef<Omit<PictureInPictureSession, 'token' | 'url'> | null>(null);
  const pictureInPictureTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const adActive = useRef(false);
  const adRequest = useRef<AbortController | null>(null);
  const adSchedule = useRef<ReturnType<typeof createNativeAdSchedule> | null>(null);
  const adResume = useRef<{ resume: ReturnType<typeof createNativeAdResume>; snapshot: Snapshot } | null>(null);
  const finishAdRef = useRef<() => void>(() => {});
  const policyRef = useRef(adPolicy); policyRef.current = adPolicy;
  const introRef = useRef(intro); introRef.current = intro;
  const introSeekTarget = useRef<number | null>(null);
  const partyContext = useRef({ media: partyMedia ?? null, connected: partyConnected, role: partyRole, playback: partyPlayback ?? null });
  partyContext.current = { media: partyMedia ?? null, connected: partyConnected, role: partyRole, playback: partyPlayback ?? null };
  const partyListeners = useRef(new Set<(intent: PartyPlayerIntent) => void>());
  const partyBlocks = useRef(new Set<PartyPlayerBlockReason>());
  const partyMode = useRef<'playing' | 'paused' | 'frozen'>(initial.playing ? 'playing' : 'paused');
  const partyFreezeReason = useRef<PartyPlayerSnapshot['freezeReason']>(undefined);
  const partyHostFrozen = useRef(false);
  const remoteApplyDepth = useRef(0);
  const remoteSuppressedUntil = useRef(0);
  const bufferingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const animation = Animated.timing(settingsMotion, { toValue: settings ? 1 : 0, duration: 160, useNativeDriver: true });
    animation.start();
    return () => animation.stop();
  }, [settings, settingsMotion]);

  function resetIntroSeek() {
    introSeekTarget.current = null;
    if (alive.current) setIntroSeeking(false);
  }

  useEffect(() => { resetIntroSeek(); }, [intro?.startSeconds, intro?.endSeconds]);

  function observe(): Snapshot {
    try {
      if (!replacing.current && !adActive.current) snapshot.current = { positionSeconds: player.currentTime,
        ...(player.duration > 0 ? { durationSeconds: player.duration } : {}), playing: player.playing };
    } catch { /* The hook may already have released the native object during cleanup. */ }
    return snapshot.current;
  }

  function clearBufferingTimer() {
    if (bufferingTimer.current === null) return;
    clearTimeout(bufferingTimer.current);
    bufferingTimer.current = null;
  }

  function clearSourceDeadline() {
    if (sourceDeadline.current !== null) clearTimeout(sourceDeadline.current);
    sourceDeadline.current = null;
  }

  function watchSourceDeadline() {
    if (sourceDeadline.current !== null || playbackFailure.current) return;
    const id = generation.current;
    // A deadline reports failure only. It never declares readiness or retries a source.
    sourceDeadline.current = setTimeout(() => {
      sourceDeadline.current = null;
      if (alive.current && id === generation.current && (replacing.current || player.status === 'loading' || player.status === 'idle')) {
        playbackError('The stream did not become ready. Check your connection and retry.');
      }
    }, SOURCE_READY_TIMEOUT_MS);
  }

  function completeSourceLoad() {
    const restore = pending.current;
    if (!restore || !restore.metadataLoaded || !restore.ready || restore.generation !== generation.current
      || nativeUrl.current !== restore.url || playbackFailure.current || !alive.current) return;
    try {
      const resumePlaying = restore.snapshot.playing && AppState.currentState === 'active';
      const positionSeconds = Math.max(0, Math.min(restore.duration > 0 ? restore.duration : Infinity, restore.snapshot.positionSeconds));
      player.currentTime = positionSeconds;
      player.playbackRate = requestedRate.current;
      snapshot.current = { positionSeconds, playing: resumePlaying, ...(restore.duration > 0 ? { durationSeconds: restore.duration } : {}) };
      setPosition(positionSeconds);
      setPlaying(resumePlaying);
      readySource.current = { generation: restore.generation, url: restore.url };
      pending.current = null;
      replacing.current = false;
      observed.current = true;
      setLoading(false);
      clearSourceDeadline();
      if (resumePlaying) player.play();
      else player.pause();
      applyTracks();
      clearPartyBlock('source-change');
    } catch { playbackError(); }
  }

  function partySnapshot(): PartyPlayerSnapshot | null {
    const media = partyContext.current.media;
    if (!media) return null;
    let ready = false;
    let playbackRate = requestedRate.current;
    let playingNow = snapshot.current.playing;
    try {
      ready = observed.current && !replacing.current && !adActive.current && player.status === 'readyToPlay';
      playbackRate = Number.isFinite(player.playbackRate) ? player.playbackRate : requestedRate.current;
      playingNow = player.playing;
    } catch { /* A released player is reported as not ready. */ }
    const blockReasons = [...partyBlocks.current];
    if (!ready && !blockReasons.includes('not-ready')) blockReasons.push('not-ready');
    const content = observe();
    return { media, positionSeconds: content.positionSeconds,
      ...(content.durationSeconds ? { durationSeconds: content.durationSeconds } : {}),
      playing: playingNow, mode: partyMode.current,
      ...(partyMode.current === 'frozen' && partyFreezeReason.current
        ? { freezeReason: partyFreezeReason.current } : {}),
      playbackRate, basePlaybackRate: requestedRate.current, ready, blockReasons,
      pictureInPicture: pictureInPicturePending.current || pictureInPictureActive.current };
  }

  function emitPartyIntent(kind: PartyPlayerIntent['kind'], freezeReason?: 'source-change' | 'ad-break' | 'background') {
    if (remoteApplyDepth.current > 0 || Date.now() < remoteSuppressedUntil.current
      || !partyContext.current.connected || !partyContext.current.media) return;
    const value = partySnapshot();
    if (!value) return;
    const intent: PartyPlayerIntent = kind === 'freeze'
      ? { kind: 'freeze', freezeReason: freezeReason!, snapshot: value }
      : { kind, snapshot: value };
    for (const listener of partyListeners.current) listener(intent);
  }

  function addPartyBlock(reason: Exclude<PartyPlayerBlockReason, 'not-ready'>,
    freezeReason: 'source-change' | 'ad-break' | 'background') {
    if (partyBlocks.current.has(reason)) return;
    partyBlocks.current.add(reason);
    partyMode.current = 'frozen';
    partyFreezeReason.current = freezeReason;
    if (partyContext.current.connected && partyContext.current.role === 'host') partyHostFrozen.current = true;
    emitPartyIntent('freeze', freezeReason);
  }

  function clearPartyBlock(reason: Exclude<PartyPlayerBlockReason, 'not-ready'>) {
    partyBlocks.current.delete(reason);
    if (partyBlocks.current.size > 0) return;
    if (partyContext.current.connected && partyContext.current.role === 'host' && partyHostFrozen.current) {
      try { player.pause(); } catch { /* Player may be released during cleanup. */ }
      snapshot.current = { ...snapshot.current, playing: false };
      if (alive.current) setPlaying(false);
      partyMode.current = 'frozen';
      return;
    }
    if (!partyContext.current.connected) {
      partyMode.current = snapshot.current.playing ? 'playing' : 'paused';
      partyFreezeReason.current = undefined;
    }
  }

  function applyPartyTarget(target: Parameters<PartyPlayerPort['apply']>[0]) {
    if (!partyContext.current.media || partyBlocks.current.size > 0) return;
    remoteApplyDepth.current += 1;
    remoteSuppressedUntil.current = Date.now() + 1_000;
    try {
      const baseRate = target.playback.playbackRate;
      requestedRate.current = baseRate;
      setRate(baseRate);
      player.playbackRate = target.playbackRate;
      if (target.seek && Number.isFinite(target.positionSeconds)) {
        const targetPosition = Math.max(0, Math.min(player.duration > 0 ? player.duration : Infinity, target.positionSeconds));
        player.currentTime = targetPosition;
        snapshot.current = { ...snapshot.current, positionSeconds: targetPosition };
        setPosition(targetPosition);
      }
      partyMode.current = target.mode;
      partyFreezeReason.current = target.mode === 'frozen' ? target.freezeReason : undefined;
      partyHostFrozen.current = false;
      const shouldPlay = target.mode === 'playing';
      snapshot.current = { ...snapshot.current, playing: shouldPlay };
      setPlaying(shouldPlay);
      if (shouldPlay) player.play();
      else player.pause();
      flush(snapshot.current);
    } finally { remoteApplyDepth.current -= 1; }
  }

  useEffect(() => {
    if (!registerPartyPlayerPort || !partyMedia) return;
    const port: PartyPlayerPort = {
      read: partySnapshot,
      apply: applyPartyTarget,
      subscribe: (listener) => { partyListeners.current.add(listener); return () => partyListeners.current.delete(listener); },
    };
    registerPartyPlayerPort(port);
    return () => {
      partyListeners.current.clear();
      registerPartyPlayerPort(null);
    };
  }, [player, registerPartyPlayerPort, partyMedia?.kind, partyMedia?.mediaId,
    partyMedia?.kind === 'episode' ? partyMedia.episodeId : undefined,
    partyMedia?.kind === 'episode' ? partyMedia.seasonNumber : undefined,
    partyMedia?.kind === 'episode' ? partyMedia.episodeNumber : undefined]);

  useEffect(() => {
    if (!partyConnected || partyRole !== 'member') {
      try { player.playbackRate = requestedRate.current; } catch { /* Player may be released during navigation. */ }
    }
    if (!partyConnected && !partyBlocks.current.size) {
      partyHostFrozen.current = false;
      partyFreezeReason.current = undefined;
      try { partyMode.current = player.playing ? 'playing' : 'paused'; } catch { partyMode.current = 'paused'; }
    }
  }, [partyConnected, partyRole, player]);

  function flush(value?: Snapshot) {
    if (!observed.current) return;
    callbacks.current.onCheckpoint(value ?? observe());
    lastFlush.current = Date.now();
  }

  function completeFullscreenTransition() {
    if (!fullscreenTransitioning.current) return;
    fullscreenTransitioning.current = false;
    if (alive.current) setFullscreenTransitioningState(false);
  }

  function changeFullscreen(next: boolean) {
    if (fullscreen === next || fullscreenTransitioning.current || pictureInPicturePending.current || pictureInPictureActive.current) return;
    fullscreenTransitioning.current = true;
    setFullscreenTransitioningState(true);
    setSettings(false);
    setFullscreen(next);
  }

  function clearPictureInPictureTimeout() {
    if (pictureInPictureTimeout.current === null) return;
    clearTimeout(pictureInPictureTimeout.current);
    pictureInPictureTimeout.current = null;
  }

  function failPictureInPicture(token: object, message: string) {
    if (pictureInPictureSession.current?.token !== token || pictureInPictureActive.current) return;
    clearPictureInPictureTimeout();
    pictureInPicturePending.current = false;
    pictureInPictureSession.current = null;
    if (AppState.currentState !== 'active') {
      addPartyBlock('background', 'background');
      const saved = observe();
      try { player.pause(); } catch { /* Navigation may have released the native player. */ }
      snapshot.current = { ...saved, playing: false };
      flush(snapshot.current);
    }
    if (alive.current) { setPictureInPictureBusy(false); setPlaying(snapshot.current.playing); setNotice(message); }
  }

  function restorePictureInPictureContent() {
    const saved = pictureInPictureRestore.current;
    if (!saved) return;
    pictureInPictureRestore.current = null;
    if (saved.generation !== generation.current || replacing.current || adActive.current) return;
    try {
      player.playbackRate = saved.rate;
      snapshot.current = saved.snapshot;
      setPosition(saved.snapshot.positionSeconds);
      setPlaying(saved.snapshot.playing);
      if (saved.snapshot.playing) player.play();
      else player.pause();
      flush(saved.snapshot);
    } catch { /* Navigation may have released the native player. */ }
  }

  function restoreAdContent() {
    const saved = adResume.current;
    if (!saved) return;
    const foreground = alive.current && AppState.currentState === 'active';
    snapshot.current = { ...saved.snapshot, playing: saved.resume.playing && foreground };
    try { saved.resume.restore(foreground); } catch { /* Navigation may have released the native player. */ }
    if (alive.current) { setPosition(saved.resume.positionSeconds); setPlaying(snapshot.current.playing); flush(snapshot.current); }
    if (foreground || !alive.current || !saved.resume.playing) adResume.current = null;
  }

  function finishAd() {
    if (!adActive.current) return;
    adRequest.current?.abort(); adRequest.current = null;
    adSchedule.current?.finish();
    // Keep content listeners frozen until the exact pre-break state has been restored.
    restoreAdContent();
    adActive.current = false;
    clearPartyBlock('ad-break');
    if (alive.current) {
      setAd(null); setAdBusy(false);
      try {
        if (player.status === 'error') playbackError();
        else if ((player.status === 'loading' || player.status === 'idle') && AppState.currentState === 'active') watchSourceDeadline();
      } catch { playbackError(); }
    }
  }
  finishAdRef.current = finishAd;

  async function beginAd() {
    const policy = policyRef.current;
    if (pictureInPicturePending.current || pictureInPictureActive.current) {
      adSchedule.current?.resetObservation(); return;
    }
    if (adActive.current || replacing.current || !advertisingConsent.current || !validNativeAdPolicy(policy)
      || !player.playing || player.status !== 'readyToPlay' || AppState.currentState !== 'active') {
      adSchedule.current?.finish(); return;
    }
    const saved = { ...observe() };
    addPartyBlock('ad-break', 'ad-break');
    adActive.current = true;
    setAdBusy(true); setSettings(false); lastTap.current = null;
    const controller = new AbortController(); adRequest.current = controller;
    try {
      const resume = createNativeAdResume(player);
      adResume.current = { snapshot: { ...saved, positionSeconds: resume.positionSeconds, playing: resume.playing }, resume };
      snapshot.current = adResume.current.snapshot;
      const creative = await fetchVastCreative(true, controller.signal);
      if (!alive.current || controller.signal.aborted || adRequest.current !== controller) return;
      if (!creative || !advertisingConsent.current || AppState.currentState !== 'active') { finishAdRef.current(); return; }
      setAd({ creative, policy, volume: player.volume, muted: player.muted });
    } catch { if (adRequest.current === controller) finishAdRef.current(); }
  }

  function chooseAdConsent(allowed: boolean) {
    consentVersion.current += 1;
    advertisingConsent.current = allowed;
    setAdConsent(allowed);
    adSchedule.current?.resetObservation();
    if (!allowed) finishAdRef.current();
    consentWrites.current = consentWrites.current.catch(() => {}).then(() => AsyncStorage.setItem(AD_CONSENT_KEY, String(allowed)))
      .catch(() => { if (alive.current) setNotice('Advertising choice applies for this playback; privacy storage is unavailable.'); });
  }

  function chooseDisplayMode(next: DisplayMode) {
    displayModeVersion.current += 1;
    setDisplayMode(next);
    displayModeWrites.current = displayModeWrites.current.catch(() => {}).then(() => AsyncStorage.setItem(DISPLAY_MODE_KEY, next))
      .catch(() => { if (alive.current) setNotice('Display mode applies for this playback; preference storage is unavailable.'); });
  }

  useEffect(() => {
    let cancelled = false;
    const version = displayModeVersion.current;
    void AsyncStorage.getItem(DISPLAY_MODE_KEY).then((stored) => {
      const saved = parseDisplayMode(stored);
      if (!cancelled && saved && version === displayModeVersion.current) setDisplayMode(saved);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const version = consentVersion.current;
    void AsyncStorage.getItem(AD_CONSENT_KEY).then((stored) => {
      if (cancelled || version !== consentVersion.current) return;
      advertisingConsent.current = stored === 'true'; setAdConsent(stored === 'true');
      adSchedule.current?.resetObservation();
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    finishAdRef.current();
    adSchedule.current = validNativeAdPolicy(adPolicy) ? createNativeAdSchedule(adPolicy) : null;
  }, [adPolicy?.enabled, adPolicy?.firstBreakSeconds, adPolicy?.intervalSeconds, adPolicy?.maxBreaks, adPolicy?.allowSkip, adPolicy?.skipAfterSeconds]);

  function applyTracks() {
    if (!alive.current || replacing.current || adActive.current) return;
    const prefs = desired.current;
    try {
      const audio = player.availableAudioTracks.find((t) => trackKey(t) === prefs.audio);
      if (audio) player.audioTrack = audio;
      setTrackNotice(prefs.audio && !audio
        ? 'The selected language track is not available yet. Your audio stream choice is unchanged.' : '');
      const sidecar = prefs.subtitle.startsWith('sidecar:')
        || selectedRef.current?.subtitles.some((t) => !!t.url && trackKey(t) === prefs.subtitle);
      player.subtitleTrack = prefs.subtitle === 'off' || sidecar ? null
        : player.availableSubtitleTracks.find((t) => trackKey(t) === prefs.subtitle) ?? null;
    } catch {
      setTrackNotice('The selected metadata track could not be applied. Your audio stream choice is unchanged.');
    }
  }

  function playbackError(message = 'This stream could not be played. Retry or select another source in Settings.') {
    if (!alive.current || playbackFailure.current || adActive.current) return;
    const pin = audioSelectionRef.current;
    const option = pin?.sourceId === sourceRef.current.id ? pin.option : null;
    snapshot.current = pending.current?.snapshot ?? snapshot.current;
    replacing.current = true;
    playbackFailure.current = true;
    readySource.current = null;
    clearSourceDeadline();
    addPartyBlock('source-change', 'source-change');
    try { player.pause(); } catch { /* The native object may be released during navigation. */ }
    setPlaybackFailed(true);
    setPlaying(false);
    setLoading(false);
    setChrome(true);
    setNotice(option ? `Audio stream ${option.number} could not be played. It remains selected. Retry it, select another number, or choose Audio Auto.`
      : desired.current.quality !== 'auto' ? `${message} Your selected quality is unchanged.` : message);
    flush(snapshot.current);
    callbacks.current.onError?.(option?.stream);
  }

  function retryPlayback() {
    if (!alive.current || !playbackFailure.current || adActive.current || pictureInPicturePending.current || pictureInPictureActive.current) return;
    playbackFailure.current = false;
    setNotice('');
    setLoading(true);
    setPlaybackFailed(false);
    setReplacementAttempt((n) => n + 1);
  }

  function changeEpisode(direction: 'previous' | 'next') {
    const current = episodeControls.current;
    if (!alive.current || !current || current.blocked || current.loading || !current[direction] || partyContext.current.connected
      || replacing.current || playbackFailure.current || adActive.current || pictureInPicturePending.current || pictureInPictureActive.current
      || AppState.currentState !== 'active') return;
    flush();
    current[direction]!.onPress();
  }

  function contentEnded() {
    if (!alive.current || !readySource.current || readySource.current.generation !== generation.current
      || readySource.current.url !== nativeUrl.current || replacing.current || playbackFailure.current || adActive.current) return;
    // The native terminal event must also belong to content at its actual end, never a stale replaced source or a seek/time sample.
    if (!(player.duration > 0) || !Number.isFinite(player.currentTime) || player.currentTime < player.duration - 0.5
      || endedGeneration.current === generation.current) return;
    endedGeneration.current = generation.current;
    snapshot.current = { positionSeconds: player.currentTime, durationSeconds: player.duration, playing: false };
    setPosition(player.currentTime);
    setPlaying(false);
    setChrome(true);
    flush(snapshot.current);
    if (pendingAutoNext.current ?? episodeControls.current?.autoNext) changeEpisode('next');
  }

  function togglePlayback() {
    if (!alive.current || followerControlsLocked() || replacing.current || playbackFailure.current || adActive.current
      || pictureInPicturePending.current || pictureInPictureActive.current || partyBlocks.current.size > 0
      || AppState.currentState !== 'active' || player.status !== 'readyToPlay') return;
    if (player.playing) {
      const paused = observe(); player.pause(); snapshot.current = { ...paused, playing: false };
      partyMode.current = 'paused'; partyFreezeReason.current = undefined; partyHostFrozen.current = false;
      setPlaying(false); flush(snapshot.current); emitPartyIntent('pause');
    } else {
      if (endedGeneration.current === generation.current) { player.currentTime = 0; snapshot.current.positionSeconds = 0; endedGeneration.current = null; }
      partyMode.current = 'playing'; partyFreezeReason.current = undefined; partyHostFrozen.current = false;
      snapshot.current = { ...snapshot.current, playing: true }; setPlaying(true); player.play(); emitPartyIntent('play');
    }
  }

  // The same VideoView stays mounted in normal/custom-fullscreen and through internal replacements.
  useEffect(() => {
    if (!fullscreen) return;
    return acquireOrientation(ScreenOrientation.OrientationLock.LANDSCAPE, () => {
      completeFullscreenTransition();
      if (alive.current) setNotice('Rotation lock is unavailable on this device.');
    });
  }, [fullscreen]);

  useEffect(() => {
    if (fullscreenTransitioning.current && (!fullscreen || width >= height)) completeFullscreenTransition();
  }, [fullscreen, width, height]);

  useEffect(() => {
    if (!fullscreen && !settings) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (settings) setSettings(false);
      else changeFullscreen(false);
      return true;
    });
    return () => subscription.remove();
  }, [fullscreen, settings]);

  useEffect(() => {
    alive.current = true;
    const subscriptions = [
      player.addListener('timeUpdate', ({ currentTime }) => {
        if (replacing.current || adActive.current || !Number.isFinite(currentTime) || currentTime < 0) return;
        if (introSeekTarget.current !== null && currentTime >= introSeekTarget.current) resetIntroSeek();
        snapshot.current = { positionSeconds: currentTime, playing: player.playing,
          ...(player.duration > 0 ? { durationSeconds: player.duration } : {}) };
        setPosition(currentTime);
        if (Date.now() - lastFlush.current >= 5000) flush();
        if (!pictureInPicturePending.current && !pictureInPictureActive.current && advertisingConsent.current
          && adSchedule.current?.sample({ positionSeconds: currentTime, nowMs: Date.now(),
          playing: player.playing, ready: player.status === 'readyToPlay', foreground: AppState.currentState === 'active', playbackRate: player.playbackRate })) void beginAd();
      }),
      player.addListener('playingChange', ({ isPlaying }) => {
        adSchedule.current?.resetObservation();
        if (replacing.current || adActive.current) return;
        setPlaying(isPlaying);
        snapshot.current.playing = isPlaying;
        if (!partyBlocks.current.size && !partyHostFrozen.current
          && remoteApplyDepth.current === 0 && Date.now() >= remoteSuppressedUntil.current
          && partyMode.current !== 'frozen') {
          partyMode.current = isPlaying ? 'playing' : 'paused';
          partyFreezeReason.current = undefined;
        }
        if (!isPlaying) flush();
      }),
      player.addListener('sourceChange', ({ source: changedSource }) => {
        nativeUrl.current = nativeSourceUrl(changedSource);
      }),
      player.addListener('statusChange', ({ status }) => {
        adSchedule.current?.resetObservation();
        if (playbackFailure.current || (pending.current && nativeUrl.current && nativeUrl.current !== pending.current.url)) return;
        setLoading(replacing.current || status === 'loading' || status === 'idle');
        if (status === 'readyToPlay') {
          if (pending.current && nativeUrl.current === pending.current.url) { pending.current.ready = true; completeSourceLoad(); }
          if (!replacing.current) clearSourceDeadline();
          clearBufferingTimer();
          clearPartyBlock('buffering');
        } else if (status === 'loading' || status === 'idle') {
          if (pending.current) pending.current.ready = false;
          watchSourceDeadline();
        }
        if (status === 'loading' && observed.current && !replacing.current && !adActive.current
          && (snapshot.current.playing || partyMode.current === 'playing') && bufferingTimer.current === null) {
          bufferingTimer.current = setTimeout(() => {
            bufferingTimer.current = null;
            try {
              if (alive.current && observed.current && !replacing.current && !adActive.current
                && player.status === 'loading') addPartyBlock('buffering', 'source-change');
            } catch { /* Released players cannot remain buffered. */ }
          }, 750);
        } else if (status === 'error') {
          clearBufferingTimer();
          addPartyBlock('source-change', 'source-change');
        }
        if (status === 'error') playbackError();
      }),
      player.addListener('sourceLoad', (event) => {
        adSchedule.current?.resetObservation();
        const restore = pending.current;
        const loadedUrl = nativeSourceUrl(event.videoSource);
        if (!restore || restore.generation !== generation.current || loadedUrl !== restore.url || playbackFailure.current) return;
        nativeUrl.current = loadedUrl;
        restore.duration = Number.isFinite(event.duration) && event.duration > 0 ? event.duration : 0;
        restore.metadataLoaded = true;
        restore.ready = restore.ready || player.status === 'readyToPlay';
        setDuration(restore.duration);
        setAudioTracks(Array.isArray(event.availableAudioTracks) ? event.availableAudioTracks : []);
        setSubtitleTracks(Array.isArray(event.availableSubtitleTracks) ? event.availableSubtitleTracks : []);
        completeSourceLoad();
      }),
      player.addListener('availableAudioTracksChange', ({ availableAudioTracks }) => {
        if (!replacing.current && !playbackFailure.current) { setAudioTracks(availableAudioTracks); applyTracks(); }
      }),
      player.addListener('availableSubtitleTracksChange', ({ availableSubtitleTracks }) => {
        if (!replacing.current && !playbackFailure.current) { setSubtitleTracks(availableSubtitleTracks); applyTracks(); }
      }),
      player.addListener('videoTrackChange', ({ videoTrack }) => {
        setVideoResolution(videoTrack ? `${videoTrack.size.width} x ${videoTrack.size.height}` : '');
      }),
      player.addListener('playToEnd', contentEnded),
    ];
    const app = AppState.addEventListener('change', (state) => {
      adSchedule.current?.resetObservation();
      if (state !== 'active') {
        if (!pictureInPicturePending.current && !pictureInPictureActive.current) {
          addPartyBlock('background', 'background');
        }
        finishAdRef.current(); flush();
        if (!pictureInPicturePending.current && !pictureInPictureActive.current) {
          player.pause(); snapshot.current.playing = false; setPlaying(false); flush(snapshot.current);
        }
      }
      else {
        if (adResume.current) restoreAdContent();
        else restorePictureInPictureContent();
        clearPartyBlock('background');
      }
    });
    return () => {
      flush();
      alive.current = false;
      clearBufferingTimer();
      clearSourceDeadline();
      clearPictureInPictureTimeout();
      pictureInPicturePending.current = false;
      pictureInPictureActive.current = false;
      pictureInPictureSession.current = null;
      pictureInPictureRestore.current = null;
      resetIntroSeek();
      finishAdRef.current();
      adResume.current = null;
      generation.current += 1;
      subscriptions.forEach((s) => s.remove());
      app.remove();
    };
  }, [player]);

  useEffect(() => {
    const controller = new AbortController();
    setCatalog((current) => current?.sourceId === source.id ? current : { sourceId: source.id, streams: [] });
    setCatalogNotice(source.streamCatalogUrl ? 'Discovering stream options...' : '');
    if (source.streamCatalogUrl) void fetchStreamCatalog(source.streamCatalogUrl, controller.signal).then((catalog) => {
      if (controller.signal.aborted) return;
      setCatalog({ sourceId: source.id, streams: catalog.streams });
      const pin = audioSelectionRef.current;
      if (pin?.sourceId === source.id) {
        const present = catalog.streams.some((s) => s.id === pin.option.stream.id && s.url === pin.option.stream.url);
        setCatalogNotice(present ? '' : `Audio stream ${pin.option.number} is not in the refreshed catalog. It remains pinned until you select another number or Audio Auto.`);
        return;
      }
      // Metadata may populate Settings, but never interrupts the attached source or rewrites user pins.
      setCatalogNotice(catalog.streams.length ? '' : 'Stream metadata is unavailable. Auto playback remains available.');
    }).catch(() => { if (!controller.signal.aborted) setCatalogNotice('Stream options could not be loaded. Playback continues.'); });
    return () => controller.abort();
  }, [source.id, source.streamCatalogUrl]);

  useEffect(() => {
    const controller = new AbortController();
    setSidecars([]);
    if (subtitleCatalogUrl) void fetchSubtitleCatalog(subtitleCatalogUrl, controller.signal)
      .then((tracks) => { if (!controller.signal.aborted) setSidecars(tracks); })
      .catch(() => { if (!controller.signal.aborted) setNotice('External subtitle options are unavailable.'); });
    return () => controller.abort();
  }, [subtitleCatalogUrl]);

  const stream = selectedStream;
  const url = streamPlaybackUrl(stream, preferences, source.url);
  const qualityConflict = !url && preferences.quality !== 'auto';
  useEffect(() => {
    resetIntroSeek();
    finishAdRef.current(); adResume.current = null;
    adSchedule.current?.resetObservation();
    const id = ++generation.current;
    const saved = observe();
    addPartyBlock('source-change', 'source-change');
    flush(snapshot.current);
    replacing.current = true;
    pending.current = null;
    readySource.current = null;
    endedGeneration.current = null;
    nativeUrl.current = null;
    clearSourceDeadline();
    setAudioTracks([]);
    setSubtitleTracks([]);
    if (playbackFailure.current) setNotice('');
    playbackFailure.current = false;
    setPlaybackFailed(false);
    if (!url) {
      setLoading(false);
      try { player.pause(); } catch { /* A released player cannot load a conflicting selection. */ }
      return;
    }
    setLoading(true);
    pending.current = { generation: id, url, snapshot: saved, metadataLoaded: false, ready: false, duration: 0 };
    watchSourceDeadline();
    // Start now, independently of catalogs and earlier stalled replacements. Native events gate readiness.
    try {
      void player.replaceAsync({ uri: url, contentType: source.kind === 'hls' ? 'hls' : source.kind === 'dash' ? 'dash' : 'progressive' })
        .catch(() => { if (alive.current && id === generation.current) playbackError(); });
    } catch { if (alive.current && id === generation.current) playbackError(); }
    return clearSourceDeadline;
  }, [player, url, source.kind, replacementAttempt]);

  function startPictureInPicture() {
    let ready = false;
    try { ready = observed.current && player.status === 'readyToPlay'; } catch { /* Released players are not PiP candidates. */ }
    if (!alive.current || !url || !pictureInPictureSupported || !ready || !videoView.current || AppState.currentState !== 'active'
      || replacing.current || adActive.current || fullscreenTransitioning.current
      || pictureInPicturePending.current || pictureInPictureActive.current) return;
    const saved = { ...observe() };
    const token = {};
    const playerRate = Number.isFinite(player.playbackRate) ? player.playbackRate : requestedRate.current;
    pictureInPictureSession.current = { token, generation: generation.current, url, snapshot: saved, rate: playerRate };
    pictureInPicturePending.current = true;
    setPictureInPictureBusy(true);
    setSettings(false);
    adSchedule.current?.resetObservation();
    flush(saved);
    pictureInPictureTimeout.current = setTimeout(() => {
      failPictureInPicture(token, 'Picture in picture could not be started.');
    }, PICTURE_IN_PICTURE_START_TIMEOUT_MS);
    try {
      void Promise.resolve(videoView.current.startPictureInPicture())
        .catch(() => failPictureInPicture(token, 'Picture in picture is unavailable for this playback.'));
    } catch {
      failPictureInPicture(token, 'Picture in picture is unavailable for this playback.');
    }
  }

  function onPictureInPictureStart() {
    if (!alive.current || !url) return;
    clearPictureInPictureTimeout();
    pictureInPicturePending.current = false;
    pictureInPictureActive.current = true;
    adSchedule.current?.resetObservation();
    const session = pictureInPictureSession.current ?? {
      token: {}, generation: generation.current, url, snapshot: { ...observe() }, rate: player.playbackRate,
    };
    pictureInPictureSession.current = session;
    if (session.generation === generation.current && session.url === url && !replacing.current && !adActive.current) {
      try {
        const currentTime = Number.isFinite(player.currentTime) && player.currentTime >= 0
          ? player.currentTime : session.snapshot.positionSeconds;
        player.playbackRate = session.rate;
        snapshot.current = { ...session.snapshot, positionSeconds: currentTime,
          ...(player.duration > 0 ? { durationSeconds: player.duration } : {}) };
        if (session.snapshot.playing && !player.playing) player.play();
        else if (!session.snapshot.playing && player.playing) player.pause();
        setPosition(currentTime);
        setPlaying(session.snapshot.playing);
        flush(snapshot.current);
      } catch { /* Native PiP owns the already-attached player if JS is briefly suspended. */ }
    }
    if (alive.current) { setPictureInPictureBusy(false); setPictureInPictureState(true); setSettings(false); }
  }

  function onPictureInPictureStop() {
    if (!alive.current) return;
    clearPictureInPictureTimeout();
    pictureInPicturePending.current = false;
    pictureInPictureActive.current = false;
    adSchedule.current?.resetObservation();
    const session = pictureInPictureSession.current;
    const saved = observe();
    const playerRate = Number.isFinite(player.playbackRate) ? player.playbackRate : session?.rate ?? requestedRate.current;
    if (AppState.currentState !== 'active') {
      addPartyBlock('background', 'background');
      pictureInPictureRestore.current = {
        generation: session?.generation ?? generation.current,
        snapshot: saved,
        rate: playerRate,
      };
      try { player.pause(); } catch { /* Navigation may have released the native player. */ }
      snapshot.current = { ...saved, playing: false };
      setPlaying(false);
      flush(snapshot.current);
    } else {
      pictureInPictureRestore.current = null;
      flush(saved);
    }
    pictureInPictureSession.current = null;
    if (alive.current) { setPictureInPictureBusy(false); setPictureInPictureState(false); }
  }

  useEffect(() => { if (!replacing.current) applyTracks(); }, [player, preferences.audio, preferences.subtitle, selectedStream]);

  const sidecar = preferences.subtitle.startsWith('sidecar:')
    ? sidecars.find((t) => `sidecar:${t.id}` === preferences.subtitle)
    : stream?.subtitles.find((t) => trackKey(t) === preferences.subtitle && t.url);
  useEffect(() => {
    const controller = new AbortController();
    setCues([]);
    if (sidecar?.url) {
      const safe = sameOriginPlaybackUrl(sidecar.url);
      if (safe) void withPlaybackDeadline(async (signal) => {
        const response = await fetch(safe, { signal, credentials: 'omit', redirect: 'error' });
        if (!response.ok || Number(response.headers.get('content-length')) > 2 * 1024 * 1024) throw new Error('Unavailable subtitle.');
        const parsed = parseVtt(await response.text());
        if (!signal.aborted && !controller.signal.aborted) { setCues(parsed); if (!parsed.length) setNotice('No readable VTT cues were found.'); }
      }, 8000, controller.signal).catch(() => { if (!controller.signal.aborted) setNotice('Selected subtitles could not be loaded.'); });
    }
    return () => controller.abort();
  }, [sidecar?.url]);

  function followerControlsLocked() {
    return partyContext.current.connected && partyContext.current.role === 'member';
  }

  function seek(next: number) {
    if (followerControlsLocked() || replacing.current || adActive.current || pictureInPicturePending.current
      || pictureInPictureActive.current || !Number.isFinite(next)) return false;
    if (introSeekTarget.current !== null && next !== introSeekTarget.current) resetIntroSeek();
    adSchedule.current?.resetObservation();
    const target = Math.max(0, Math.min(player.duration > 0 ? player.duration : Infinity, next));
    if (target < player.duration - 0.5) endedGeneration.current = null;
    player.currentTime = target;
    snapshot.current = { ...snapshot.current, positionSeconds: target };
    setPosition(target);
    flush(snapshot.current);
    emitPartyIntent('seek');
    return true;
  }

  function skipIntro() {
    const marker = introRef.current;
    try {
      if (!alive.current || !observed.current || !canSkipIntro(marker, player.currentTime, player.duration,
        followerControlsLocked() || replacing.current || adActive.current
        || introSeekTarget.current !== null || player.status !== 'readyToPlay')) return;
      // Lock synchronously: repeated taps can arrive before React removes the button or native seek completes.
      introSeekTarget.current = marker.endSeconds;
      setIntroSeeking(true);
      if (!seek(marker.endSeconds)) resetIntroSeek();
    } catch { resetIntroSeek(); }
  }

  function change(field: keyof Preferences, value: string) {
    if (!alive.current || adActive.current || pictureInPicturePending.current || pictureInPictureActive.current) return;
    const next = { ...desired.current, [field]: value };
    if (field !== 'quality') {
      desired.current = next;
      setPreferences(next);
      return;
    }
    const pin = audioSelectionRef.current;
    const pinned = pin?.sourceId === source.id ? pin.option.stream : null;
    const chosen = chooseStream(streams, next, field, selectedRef.current?.id, pinned);
    desired.current = pinned ? next : chosen ? compatiblePreferences(chosen, next) : next;
    setPreferences(desired.current);
    if (chosen) {
      selectedRef.current = chosen;
      setSelection({ sourceId: source.id, stream: chosen });
    }
  }

  function changeAudioStream(option: AudioStreamOption | null) {
    if (!alive.current || adActive.current || pictureInPicturePending.current || pictureInPictureActive.current) return;
    const pin = option ? { sourceId: source.id, option } : null;
    audioSelectionRef.current = pin;
    setAudioSelection(pin);
    const chosen = option?.stream ?? chooseStream(streams, desired.current, 'quality', selectedRef.current?.id) ?? null;
    if (chosen) {
      desired.current = compatiblePreferences(chosen, desired.current);
      setPreferences(desired.current);
    }
    selectedRef.current = chosen;
    setSelection(chosen ? { sourceId: source.id, stream: chosen } : null);
    setNotice('');
    if (playbackFailure.current) setReplacementAttempt((n) => n + 1);
  }

  function touchEnd(event: GestureResponderEvent) {
    if (adActive.current || pictureInPicturePending.current || pictureInPictureActive.current) return;
    const start = touchStart.current;
    const { pageX: x, pageY: y, locationX } = event.nativeEvent;
    touchStart.current = null;
    if (!start || Math.hypot(start.x - x, start.y - y) > 16) { lastTap.current = null; return; }
    if (locationX > width / 3 && locationX < width * 2 / 3) { setChrome((value) => !value); lastTap.current = null; return; }
    if (followerControlsLocked()) { lastTap.current = null; return; }
    const tap: Tap = { x, y, time: Date.now(), side: locationX <= width / 3 ? 'left' : 'right' };
    if (doubleTap(lastTap.current, tap)) {
      const delta = tap.side === 'left' ? -10 : 10;
      seek(observe().positionSeconds + delta);
      setNotice(delta < 0 ? 'Back 10 seconds' : 'Forward 10 seconds');
      lastTap.current = null;
    } else lastTap.current = tap;
  }

  const qualities = new Map<string, string>();
  const audio = new Map<string, string>();
  const subtitles = new Map<string, string>();
  for (const s of pinnedAudio && !streams.some((s) => s.id === pinnedAudio.stream.id && s.url === pinnedAudio.stream.url)
    ? [...streams, pinnedAudio.stream] : streams) {
    let vidnest = false;
    try { vidnest = new URL(s.url).pathname === '/api/vidnest'; } catch { /* Invalid optional metadata is ignored. */ }
    if (vidnest) for (const q of s.qualities) if (!q.auto) {
      const h = qualityHeight(q);
      qualities.set(qualityKey(q), h === 2160 ? '4K' : h ? `${h}p` : q.label);
    }
  }
  if (preferences.quality !== 'auto' && !qualities.has(preferences.quality)) {
    const height = /^quality:(\d+)$/.exec(preferences.quality)?.[1];
    qualities.set(preferences.quality, height === '2160' ? '4K' : height ? `${height}p` : 'Selected quality');
  }
  // Language choices are actual alternate tracks on the attached native source, not audio from other complete videos.
  for (const t of selectedStream?.subtitles ?? []) subtitles.set(trackKey(t), t.label || t.language);
  for (const t of audioTracks) if (t.label || t.language) audio.set(trackKey(t), t.label || t.language);
  for (const t of subtitleTracks) subtitles.set(trackKey(t), t.label || t.language);
  for (const t of sidecars) subtitles.set(`sidecar:${t.id}`, t.label);
  const partyFollowerLocked = partyConnected && partyRole === 'member' && !!partyMedia;
  const audioOptions = audioStreamOptions(source.streamCatalogUrl ? streams : source.kind === 'embed' ? [] : [{
    id: source.id, url: source.url, qualities: [], audioTracks: [], subtitles: [],
  }]);
  const text = subtitleText(cues, position, offset);
  const presentationBottom = chrome ? controlsHeight + 12 : insets.bottom + 28;
  const hasIntroRoom = height - presentationBottom - (text ? captionHeight + 12 : 0) - 44
    >= (chrome ? headerHeight + 76 : insets.top + 56) + 12;
  let introVisible = false;
  if (alive.current && observed.current && hasIntroRoom && !settings) {
    try {
      introVisible = canSkipIntro(intro, player.currentTime, player.duration,
        partyFollowerLocked || source.kind === 'embed' || replacing.current || loading || adBusy
        || adActive.current || introSeeking || player.status !== 'readyToPlay');
    } catch { /* Released/unfinished players cannot prove a safe intro target. */ }
  }
  const displayContentFit = displayModeContentFit(displayMode);
  let pictureInPictureReady = false;
  try { pictureInPictureReady = observed.current && player.status === 'readyToPlay'; } catch { /* Released players are not PiP candidates. */ }
  const pictureInPictureDisabled = pictureInPictureBusy || pictureInPictureState || fullscreenTransitioningState
    || replacing.current || loading || adBusy || !url || !pictureInPictureReady || AppState.currentState !== 'active';
  const partyFrozen = partyConnected && (partyPlayback?.mode === 'frozen' || partyMode.current === 'frozen');
  const controlsDisabled = partyFollowerLocked || loading || playbackFailed || replacing.current || adBusy || pictureInPictureBusy || pictureInPictureState;
  const episodesDisabled = controlsDisabled || partyConnected || !!episodes?.blocked || !!episodes?.loading;
  const autoNextUnavailableReason = !episodes ? '' : episodes.blocked || partyConnected
    ? 'Leave Watch Party to enable Auto Next.' : episodes.loading ? 'Loading verified episodes...'
      : !episodes.next ? episodes.notice || 'No verified next episode is available.'
        : controlsDisabled ? 'Auto Next is unavailable until playback is ready.' : '';
  const autoNextDisabled = Boolean(autoNextUnavailableReason);
  const openSection = (section: NonNullable<typeof settingsSection>) => setSettingsSection((current) => current === section ? null : section);

  return <View style={styles.root}>
    <StatusBar hidden={fullscreen} style="light" />
    <VideoView ref={videoView} player={player} style={StyleSheet.absoluteFill}
      contentFit={displayContentFit} nativeControls={false} fullscreenOptions={{ enable: false }} surfaceType="textureView"
      allowsPictureInPicture={pictureInPictureSupported} startsPictureInPictureAutomatically={false}
      onPictureInPictureStart={onPictureInPictureStart} onPictureInPictureStop={onPictureInPictureStop} />
    <View style={StyleSheet.absoluteFill} onTouchStart={(e) => { touchStart.current = { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY }; }}
      onTouchEnd={touchEnd} onTouchCancel={() => { touchStart.current = null; lastTap.current = null; }} />
    {(introVisible || text) && !adBusy ? <View pointerEvents="box-none" style={[styles.presentation, { bottom: presentationBottom,
      left: Math.max(insets.left + 16, width * 0.05), right: Math.max(insets.right + 16, width * 0.05) }]}>
      {introVisible ? <View style={styles.introAction}><Action label="Skip intro" onPress={skipIntro} /></View> : null}
      {text ? <View pointerEvents="none" onLayout={(event) => setCaptionHeight(event.nativeEvent.layout.height)} style={styles.subtitles}>
        <Text style={styles.subtitleText}>{text}</Text>
      </View> : null}
    </View> : null}
    {loading && !adBusy ? <View pointerEvents="none" style={styles.centerPanel} accessibilityLiveRegion="polite">
      <ActivityIndicator size="large" color="#fff" /><Text style={styles.centerTitle}>{observed.current ? 'Buffering...' : 'Loading video...'}</Text>
    </View> : null}
    {(playbackFailed || qualityConflict) && !settings && !adBusy ? <View style={[styles.centerPanel, styles.errorPanel]} accessibilityLiveRegion="polite">
      <Text style={styles.centerTitle}>{qualityConflict ? 'Selected quality is unavailable' : 'Stream unavailable'}</Text>
      <Text style={styles.errorDetail}>{qualityConflict
        ? `${pinnedAudio ? `Audio stream ${pinnedAudio.number}` : 'This stream'} cannot provide the selected quality. Your quality and audio choices are unchanged.` : notice}</Text>
      <Action label={qualityConflict ? 'Change quality' : 'Retry'} onPress={qualityConflict ? () => { setSettingsSection('quality'); setSettings(true); } : retryPlayback} />
    </View> : null}
    {chrome && !settings && !loading && !playbackFailed && !qualityConflict && !adBusy ? <View style={[styles.transport,
      { top: (headerHeight + height - controlsHeight) / 2, left: insets.left + 16, right: insets.right + 16 }]}>
      <Action label="Back 10 seconds" displayLabel="-10 s" disabled={controlsDisabled} onPress={() => seek(observe().positionSeconds - 10)} />
      <Action label={playing ? 'Pause' : 'Play'} prominent disabled={controlsDisabled} onPress={togglePlayback} />
      <Action label="Forward 10 seconds" displayLabel="+10 s" disabled={controlsDisabled} onPress={() => seek(observe().positionSeconds + 10)} />
    </View> : null}
    {chrome ? <View pointerEvents={settings ? 'none' : 'box-none'} importantForAccessibility={settings ? 'no-hide-descendants' : 'auto'}
      onLayout={(event) => setHeaderHeight(event.nativeEvent.layout.height)} style={[styles.header,
        { paddingTop: insets.top + 12, paddingLeft: insets.left + 16, paddingRight: insets.right + 16 }]}>{header}</View> : null}
    {!chrome ? <View style={[styles.reveal, { top: insets.top + 12 }]}><Action label="Show controls" onPress={() => setChrome(true)} /></View> : null}
    {settings ? <Animated.View accessibilityViewIsModal style={[styles.settings, {
      bottom: insets.bottom + 12, left: Math.max(insets.left + 12, (width - 560) / 2), right: Math.max(insets.right + 12, (width - 560) / 2),
      maxHeight: height - insets.top - insets.bottom - 24, opacity: settingsMotion,
      transform: [{ translateY: settingsMotion.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) }],
    }]}>
      <View style={styles.settingsTop}><Text style={styles.centerTitle}>Playback settings</Text><Action label="Close settings" onPress={() => setSettings(false)} /></View>
      <ScrollView style={{ maxHeight: Math.max(88, height - insets.top - insets.bottom - 92) }} contentContainerStyle={styles.settingsContent}
        accessibilityLabel="Playback settings" keyboardShouldPersistTaps="handled">
      {playbackFailed || qualityConflict ? <View style={styles.settingBody}>
        <Text accessibilityLiveRegion="polite" style={styles.detail}>{qualityConflict
          ? `${pinnedAudio ? `Audio stream ${pinnedAudio.number}` : 'This stream'} cannot provide the selected quality. Your quality and audio choices are unchanged.` : notice}</Text>
        {playbackFailed ? <Action label="Retry" onPress={retryPlayback} /> : null}
      </View> : null}
      <SettingsHeading label="Quality" summary={preferences.quality === 'auto' ? 'Auto' : qualities.get(preferences.quality) ?? 'Selected quality'}
        expanded={settingsSection === 'quality'} onPress={() => openSection('quality')} />
      {settingsSection === 'quality' ? <View style={styles.settingBody}>
      <View style={styles.row}><Action label="Auto" selected={preferences.quality === 'auto'} onPress={() => change('quality', 'auto')} />
        {[...qualities].map(([id, label]) => <Action key={id} label={label} selected={preferences.quality === id} onPress={() => change('quality', id)} />)}</View>
      <Text style={styles.detail}>Auto adapts to bandwidth when the stream offers multiple renditions. A manual quality is never reduced automatically.</Text>
      <Text style={styles.detail}>{videoResolution ? `Playing ${videoResolution}` : 'Waiting for native video details'}{catalogNotice ? `\n${catalogNotice}` : ''}</Text>
      {qualityConflict ? <Text accessibilityLiveRegion="polite" style={styles.detail}>
        {pinnedAudio ? `Audio stream ${pinnedAudio.number}` : 'This stream'} cannot provide the selected quality. Select a compatible quality or Quality Auto. Your audio stream choice is unchanged.
      </Text> : null}
      </View> : null}
      <SettingsHeading label="Audio" summary={pinnedAudio ? `Stream ${pinnedAudio.number}` : 'Auto'} expanded={settingsSection === 'audio'} onPress={() => openSection('audio')} />
      {settingsSection === 'audio' ? <View style={styles.settingBody}>
      <Text style={styles.detail}>Select different audio streams to find your preferred audio.</Text>
      <Text style={styles.detail}>Numbers switch the complete video and audio stream. They do not combine 4K video with audio from another stream.</Text>
      <View style={styles.row} accessibilityLabel="Audio streams">
        <Action label="Auto" accessibilityLabel="Audio Auto" selected={!pinnedAudio} onPress={() => changeAudioStream(null)} />
        {audioOptions.map((option) => <Action key={`${option.stream.id}:${option.stream.url}`} label={option.label}
          accessibilityLabel={`Audio stream ${option.number}`} selected={pinnedAudio?.stream.id === option.stream.id && pinnedAudio.stream.url === option.stream.url}
          onPress={() => changeAudioStream(option)} />)}
      </View>
      {pinnedAudio ? <Text style={styles.detail}>Audio stream {pinnedAudio.number} selected. Automatic stream selection is off.</Text> : null}
      {catalogNotice ? <Text accessibilityLiveRegion="polite" style={styles.detail}>{catalogNotice}</Text> : null}
      {!audioOptions.length ? <Text style={styles.detail}>No direct audio streams reported yet.</Text> : null}
      {playbackFailed ? <Action label={pinnedAudio ? 'Retry selected audio stream' : 'Retry'} onPress={retryPlayback} /> : null}
      <Text style={styles.detail}>Alternate audio tracks on this video</Text>
      <View style={styles.row}>{[...audio].map(([id, label]) => <Action key={id} label={`Audio: ${label}`} selected={preferences.audio === id}
        onPress={() => change('audio', id)} />)}</View>
      {!audio.size ? <Text style={styles.detail}>No selectable language tracks reported by this source.</Text> : null}
      {trackNotice ? <Text accessibilityLiveRegion="polite" style={styles.detail}>{trackNotice}</Text> : null}
      </View> : null}
      <SettingsHeading label="Subtitles" summary={preferences.subtitle === 'off' ? 'Off' : subtitles.get(preferences.subtitle) ?? 'Selected track'}
        expanded={settingsSection === 'subtitles'} onPress={() => openSection('subtitles')} />
      {settingsSection === 'subtitles' ? <View style={styles.settingBody}>
      <View style={styles.row}><Action label="Subtitles off" selected={preferences.subtitle === 'off'} onPress={() => change('subtitle', 'off')} />
        {[...subtitles].map(([id, label]) => <Action key={id} label={`Subtitles: ${label}`} selected={preferences.subtitle === id} onPress={() => change('subtitle', id)} />)}</View>
      <Text style={styles.detail}>{sidecar ? `Subtitle offset ${offset.toFixed(2)}s (positive delays)` : 'Timing adjustment is available for VTT sidecars only. Native HLS captions use their encoded timing.'}</Text>
      <View style={styles.row}><Action label="Advance subtitles by 0.25 seconds" disabled={!sidecar} onPress={() => setOffset((n) => Math.max(-10, n - 0.25))} />
        <Action label="Delay subtitles by 0.25 seconds" disabled={!sidecar} onPress={() => setOffset((n) => Math.min(10, n + 0.25))} />
        <Action label="Reset subtitle timing" disabled={!sidecar} onPress={() => setOffset(0)} /></View>
      </View> : null}
      <SettingsHeading label="Speed" summary={`${rate}x`} expanded={settingsSection === 'speed'} onPress={() => openSection('speed')} />
      {settingsSection === 'speed' ? <View style={styles.settingBody}>
      <View style={styles.row}>{[0.5, 0.75, 1, 1.25, 1.5, 2].map((speed) => <Action key={speed} label={`${speed}x`} selected={rate === speed}
        disabled={partyFollowerLocked} onPress={() => { if (followerControlsLocked()
          || pictureInPicturePending.current || pictureInPictureActive.current) return;
          adSchedule.current?.resetObservation(); requestedRate.current = speed; player.playbackRate = speed; setRate(speed);
           emitPartyIntent('rate'); }} />)}</View>
      </View> : null}
      <SettingsHeading label="Display" summary={displayMode === 'fit' ? 'Fit' : displayMode === 'fill' ? 'Fill' : 'Zoom'}
        expanded={settingsSection === 'display'} onPress={() => openSection('display')} />
      {settingsSection === 'display' ? <View style={styles.settingBody}>
      <View style={styles.row}><Action label="Fit" selected={displayMode === 'fit'} onPress={() => chooseDisplayMode('fit')} />
        <Action label="Fill" selected={displayMode === 'fill'} onPress={() => chooseDisplayMode('fill')} />
        <Action label="Zoom" selected={displayMode === 'zoom'} onPress={() => chooseDisplayMode('zoom')} /></View>
      <Text style={styles.detail}>Fit shows the whole frame. Fill stretches it. Zoom crops while keeping its aspect ratio.</Text>
      <Text style={styles.detail}>Playback source</Text>
      {footer}
      <Text style={styles.detail}>Advertising privacy</Text>
      <Text style={styles.detail}>Video advertising is off unless you opt in here. VAST beacon delivery is disabled on Android. This choice is separate from permission to load a streaming source.</Text>
      <View style={styles.row}><Action label="Allow video advertising" selected={adConsent} onPress={() => chooseAdConsent(true)} />
        <Action label="Decline video advertising" selected={!adConsent} onPress={() => chooseAdConsent(false)} /></View>
      <Text style={styles.detail}>Google Cast is unsupported in this build. No native Cast module is installed.</Text>
      </View> : null}
      </ScrollView>
    </Animated.View> : null}
    {chrome ? <View importantForAccessibility={settings ? 'no-hide-descendants' : 'auto'} pointerEvents={settings ? 'none' : 'auto'}
      onLayout={(event) => setControlsHeight(event.nativeEvent.layout.height)} style={[styles.controls,
        { paddingBottom: insets.bottom + 12, paddingLeft: insets.left + 16, paddingRight: insets.right + 16 }]}>
      {!!notice && !playbackFailed && !qualityConflict && <Text accessibilityLiveRegion="polite" style={styles.detail}>{notice}</Text>}
      {partyFollowerLocked ? <Text accessibilityLiveRegion="polite" style={styles.partyStatus}>Host controls playback</Text>
        : partyFrozen ? <Text accessibilityLiveRegion="polite" style={styles.partyStatus}>Party frozen / press Play to resume</Text> : null}
      <View style={styles.timelineLabels}><Text style={styles.detail}>{timeLabel(position)}</Text><Text style={styles.detail}>{duration > 0 ? timeLabel(duration) : '--:--'}</Text></View>
      <Pressable accessibilityRole="adjustable" accessibilityLabel="Playback position" disabled={controlsDisabled || duration <= 0}
        accessibilityState={{ disabled: controlsDisabled || duration <= 0 }} onLayout={(event) => { timelineWidth.current = event.nativeEvent.layout.width; }}
        accessibilityValue={{ min: 0, max: Math.round(duration), now: Math.round(position), text: timeLabel(position) }}
        accessibilityActions={[{ name: 'increment', label: 'Forward 10 seconds' }, { name: 'decrement', label: 'Back 10 seconds' }]}
        onAccessibilityAction={(e) => seek(position + (e.nativeEvent.actionName === 'increment' ? 10 : -10))}
        onPress={(e) => seek(e.nativeEvent.locationX / Math.max(1, timelineWidth.current) * duration)} style={styles.scrubber}>
        <View style={styles.track}><View style={[styles.progress, { width: `${duration > 0 ? Math.min(100, position / duration * 100) : 0}%` }]} /></View>
      </Pressable>
      <View style={styles.toolbar}>
        <Action label="Settings" selected={settings} disabled={pictureInPictureBusy || pictureInPictureState} onPress={() => setSettings((value) => !value)} />
        {pictureInPictureSupported ? <Action label="Picture in picture" selected={pictureInPictureState}
          disabled={pictureInPictureDisabled} onPress={startPictureInPicture} /> : null}
        <Action label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'} disabled={fullscreenTransitioningState || pictureInPictureBusy || pictureInPictureState}
          onPress={() => changeFullscreen(!fullscreen)} />
      </View>
      {episodes ? <View style={styles.row} accessibilityLabel="Episode controls">
        <Action label="Previous" accessibilityLabel={`Previous episode${episodes.previous ? `, ${episodes.previous.label}` : ''}`}
          disabled={episodesDisabled || !episodes.previous} onPress={() => changeEpisode('previous')} />
        <Action label="Next" accessibilityLabel={`Next episode${episodes.next ? `, ${episodes.next.label}` : ''}`}
          disabled={episodesDisabled || !episodes.next} onPress={() => changeEpisode('next')} />
        <Action label={`Auto Next: ${autoNextDisabled ? 'Unavailable' : episodes.autoNext ? 'On' : 'Off'}`} toggle
          selected={!autoNextDisabled && episodes.autoNext} disabled={autoNextDisabled}
          onPress={() => {
            const current = episodeControls.current;
            if (!alive.current || !current || current.blocked || current.loading || !current.next || partyContext.current.connected
              || replacing.current || playbackFailure.current || adActive.current || pictureInPicturePending.current || pictureInPictureActive.current
              || AppState.currentState !== 'active' || player.status !== 'readyToPlay') return;
            const enabled = !(pendingAutoNext.current ?? current.autoNext);
            pendingAutoNext.current = enabled;
            current.onAutoNextChange(enabled);
          }} />
      </View> : null}
      {autoNextUnavailableReason ? <Text accessibilityLiveRegion="polite" style={styles.detail}>{autoNextUnavailableReason}
        {episodes?.autoNext ? ' Your saved Auto Next preference is unchanged.' : ''}</Text> : null}
      {episodes?.notice ? <Text style={styles.detail} numberOfLines={2}>{episodes.notice}</Text> : null}
      {episodes?.onRetry ? <Action label="Retry episode information" onPress={episodes.onRetry} /> : null}
    </View> : null}
    {adBusy && !ad ? <View style={styles.adLoading} accessibilityLabel="Loading advertisement"><Text style={styles.detail}>Loading advertisement...</Text></View> : null}
    {ad ? <NativeVastAd creative={ad.creative} policy={ad.policy} volume={ad.volume} muted={ad.muted} onDone={() => finishAdRef.current()} /> : null}
  </View>;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000', overflow: 'hidden' },
  header: { position: 'absolute', top: 0, left: 0, right: 0, paddingHorizontal: 16, backgroundColor: 'rgba(0,0,0,0.35)' },
  controls: { position: 'absolute', bottom: 0, left: 0, right: 0, paddingHorizontal: 16, gap: 4, backgroundColor: 'rgba(0,0,0,0.72)' },
  transport: { position: 'absolute', flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 20, transform: [{ translateY: -38 }] },
  playButton: { minWidth: 76, minHeight: 76, borderRadius: 38, alignItems: 'center', backgroundColor: colors.primary },
  playText: { fontSize: 18, fontWeight: '700' },
  centerPanel: { position: 'absolute', top: '35%', alignSelf: 'center', maxWidth: '88%', alignItems: 'center', gap: 12 },
  errorPanel: { backgroundColor: 'rgba(8,9,12,0.94)', padding: 16, borderRadius: 14 },
  centerTitle: { color: '#fff', fontSize: 17, fontWeight: '700' },
  errorDetail: { color: '#ddd', fontSize: 13, textAlign: 'center', maxWidth: 360 },
  toolbar: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  timelineLabels: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: -8 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  button: { minHeight: 44, minWidth: 44, paddingHorizontal: 12, paddingVertical: 12, borderRadius: 10, backgroundColor: '#252630', justifyContent: 'center' },
  selected: { backgroundColor: colors.primary },
  buttonText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  label: { color: '#fff', fontSize: 15, fontWeight: '600' },
  detail: { color: '#ddd', fontSize: 12 },
  partyStatus: { color: colors.warning, fontSize: 12, fontWeight: '700' },
  settings: { position: 'absolute', backgroundColor: '#14151c', borderRadius: 16, borderWidth: 1, borderColor: '#444', zIndex: 4, overflow: 'hidden' },
  settingsTop: { minHeight: 56, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, gap: 8 },
  settingsHeading: { minHeight: 48, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12, borderTopWidth: 1, borderTopColor: '#30313b' },
  settingSummary: { color: '#ccc', fontSize: 13, flexShrink: 1 },
  settingsContent: { paddingHorizontal: 16, paddingBottom: 16 },
  settingBody: { gap: 10, paddingBottom: 12 },
  scrubber: { height: 44, justifyContent: 'center' },
  track: { height: 4, backgroundColor: '#666', borderRadius: 2, overflow: 'hidden' },
  progress: { height: 4, backgroundColor: colors.primary },
  presentation: { position: 'absolute', alignItems: 'center', gap: 12 },
  introAction: { alignSelf: 'flex-end' },
  subtitles: { alignItems: 'center', maxWidth: '100%' },
  subtitleText: { color: '#fff', backgroundColor: 'rgba(0,0,0,0.8)', fontSize: 20, textAlign: 'center', padding: 8 },
  reveal: { position: 'absolute', right: 16 },
  adLoading: { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, zIndex: 30, backgroundColor: '#06070a', justifyContent: 'center', alignItems: 'center' },
});
