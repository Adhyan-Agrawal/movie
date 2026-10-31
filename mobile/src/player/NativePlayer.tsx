import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AppState, BackHandler, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions, type GestureResponderEvent } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useVideoPlayer, VideoView, type AudioTrack, type SubtitleTrack } from 'expo-video';
import * as ScreenOrientation from 'expo-screen-orientation';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { fetchStreamCatalog, fetchSubtitleCatalog, fetchVastCreative, sameOriginPlaybackUrl } from '../lib/api';
import type { DirectStream, IntroMarker, NativeAdPolicy, NativeVastCreative, PlaybackSource, Subtitle } from '../lib/types';
import { colors } from '../theme';
import { chooseStream, compatiblePreferences, DEFAULT_PREFERENCES, qualityHeight, qualityKey, renditionUrl, trackKey, type Preferences } from './options';
import { doubleTap, parseVtt, subtitleText, type Cue, type Tap } from './subtitles';
import { acquireOrientation } from './orientation';
import NativeVastAd from './VastAdBreak';
import { createNativeAdResume, createNativeAdSchedule, validNativeAdPolicy } from './policy';

export interface Snapshot { positionSeconds: number; durationSeconds?: number; playing: boolean }
const AD_CONSENT_KEY = 'lumora:ads:consent';

export function canSkipIntro(intro: IntroMarker | null | undefined, positionSeconds: number, durationSeconds: number, blocked = false): intro is IntroMarker {
  return !blocked && !!intro && Number.isFinite(intro.startSeconds) && Number.isFinite(intro.endSeconds)
    && intro.startSeconds >= 0 && intro.endSeconds > intro.startSeconds
    && Number.isFinite(positionSeconds) && positionSeconds >= intro.startSeconds && positionSeconds < intro.endSeconds
    && Number.isFinite(durationSeconds) && durationSeconds > 0 && intro.endSeconds <= durationSeconds;
}

function Action({ label, onPress, selected, disabled }: { label: string; onPress: () => void; selected?: boolean; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected, disabled }}
    disabled={disabled} onPress={onPress} style={[styles.button, selected && styles.selected, disabled && { opacity: 0.45 }]}>
    <Text style={styles.buttonText}>{label}</Text>
  </Pressable>;
}

function timeLabel(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
}

export default function NativePlayer({ source, initial, subtitleCatalogUrl, intro, adPolicy, upNext, onCheckpoint, onError, header, footer }: {
  source: PlaybackSource;
  initial: Snapshot;
  subtitleCatalogUrl?: string;
  intro?: IntroMarker | null;
  adPolicy?: NativeAdPolicy;
  upNext?: { label: string; onPress: () => void };
  onCheckpoint: (snapshot: Snapshot) => void;
  onError: () => void;
  header: ReactNode;
  footer: ReactNode;
}) {
  const player = useVideoPlayer(null, (p) => { p.timeUpdateEventInterval = 0.25; p.staysActiveInBackground = false; });
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const [fullscreen, setFullscreen] = useState(false);
  const [settings, setSettings] = useState(false);
  const [chrome, setChrome] = useState(true);
  const [position, setPosition] = useState(initial.positionSeconds);
  const [duration, setDuration] = useState(initial.durationSeconds ?? 0);
  const [playing, setPlaying] = useState(initial.playing);
  const [loading, setLoading] = useState(true);
  const [rate, setRate] = useState(1);
  const [streams, setStreams] = useState<DirectStream[]>([]);
  const [selectedStream, setSelectedStream] = useState<DirectStream | null>(null);
  const [preferences, setPreferences] = useState<Preferences>(DEFAULT_PREFERENCES);
  const [audioTracks, setAudioTracks] = useState<AudioTrack[]>([]);
  const [subtitleTracks, setSubtitleTracks] = useState<SubtitleTrack[]>([]);
  const [sidecars, setSidecars] = useState<Subtitle[]>([]);
  const [cues, setCues] = useState<Cue[]>([]);
  const [offset, setOffset] = useState(0);
  const [notice, setNotice] = useState('');
  const [catalogNotice, setCatalogNotice] = useState('');
  const [videoResolution, setVideoResolution] = useState('');
  const [controlsHeight, setControlsHeight] = useState(190);
  const [headerHeight, setHeaderHeight] = useState(96);
  const [captionHeight, setCaptionHeight] = useState(48);
  const [introSeeking, setIntroSeeking] = useState(false);
  const [adConsent, setAdConsent] = useState(false);
  const [adBusy, setAdBusy] = useState(false);
  const [ad, setAd] = useState<{ creative: NativeVastCreative; policy: NativeAdPolicy; volume: number; muted: boolean } | null>(null);
  const snapshot = useRef<Snapshot>(initial);
  const callbacks = useRef({ onCheckpoint, onError });
  callbacks.current = { onCheckpoint, onError };
  const desired = useRef(preferences);
  desired.current = preferences;
  const selectedRef = useRef(selectedStream);
  selectedRef.current = selectedStream;
  const replacing = useRef(true);
  const observed = useRef(false);
  const alive = useRef(true);
  const generation = useRef(0);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const pending = useRef<{ generation: number; url: string; snapshot: Snapshot } | null>(null);
  const lastFlush = useRef(0);
  const requestedRate = useRef(rate);
  requestedRate.current = rate;
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const lastTap = useRef<Tap | null>(null);
  const advertisingConsent = useRef(false);
  const consentVersion = useRef(0);
  const consentWrites = useRef<Promise<void>>(Promise.resolve());
  const adActive = useRef(false);
  const adRequest = useRef<AbortController | null>(null);
  const adSchedule = useRef<ReturnType<typeof createNativeAdSchedule> | null>(null);
  const adResume = useRef<{ resume: ReturnType<typeof createNativeAdResume>; snapshot: Snapshot } | null>(null);
  const finishAdRef = useRef<() => void>(() => {});
  const policyRef = useRef(adPolicy); policyRef.current = adPolicy;
  const introRef = useRef(intro); introRef.current = intro;
  const introSeekTarget = useRef<number | null>(null);

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

  function flush(value?: Snapshot) {
    if (!observed.current) return;
    callbacks.current.onCheckpoint(value ?? observe());
    lastFlush.current = Date.now();
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
    if (alive.current) { setAd(null); setAdBusy(false); }
  }
  finishAdRef.current = finishAd;

  async function beginAd() {
    const policy = policyRef.current;
    if (adActive.current || replacing.current || !advertisingConsent.current || !validNativeAdPolicy(policy)
      || !player.playing || player.status !== 'readyToPlay' || AppState.currentState !== 'active') {
      adSchedule.current?.finish(); return;
    }
    const saved = observe();
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
    const prefs = desired.current;
    const audio = player.availableAudioTracks.find((t) => trackKey(t) === prefs.audio);
    if (audio) player.audioTrack = audio;
    const sidecar = prefs.subtitle.startsWith('sidecar:')
      || selectedRef.current?.subtitles.some((t) => !!t.url && trackKey(t) === prefs.subtitle);
    player.subtitleTrack = prefs.subtitle === 'off' || sidecar ? null
      : player.availableSubtitleTracks.find((t) => trackKey(t) === prefs.subtitle) ?? null;
  }

  // The same VideoView stays mounted in normal/custom-fullscreen and through internal replacements.
  useEffect(() => {
    if (!fullscreen) return;
    return acquireOrientation(ScreenOrientation.OrientationLock.LANDSCAPE, () => {
      if (alive.current) setNotice('Rotation lock is unavailable on this device.');
    });
  }, [fullscreen]);

  useEffect(() => {
    if (!fullscreen) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => { setFullscreen(false); return true; });
    return () => subscription.remove();
  }, [fullscreen]);

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
        if (advertisingConsent.current && adSchedule.current?.sample({ positionSeconds: currentTime, nowMs: Date.now(),
          playing: player.playing, ready: player.status === 'readyToPlay', foreground: AppState.currentState === 'active', playbackRate: player.playbackRate })) void beginAd();
      }),
      player.addListener('playingChange', ({ isPlaying }) => {
        adSchedule.current?.resetObservation();
        if (replacing.current || adActive.current) return;
        setPlaying(isPlaying);
        snapshot.current.playing = isPlaying;
        if (!isPlaying) flush();
      }),
      player.addListener('statusChange', ({ status }) => {
        adSchedule.current?.resetObservation();
        setLoading(status === 'loading' || status === 'idle');
        if (status === 'error') callbacks.current.onError();
      }),
      player.addListener('sourceLoad', (event) => {
        adSchedule.current?.resetObservation();
        const loadedUrl = typeof event.videoSource === 'object' && event.videoSource ? event.videoSource.uri : event.videoSource;
        if (pending.current && loadedUrl && loadedUrl !== pending.current.url) return;
        setDuration(event.duration);
        setAudioTracks(event.availableAudioTracks);
        setSubtitleTracks(event.availableSubtitleTracks);
        const restore = pending.current;
        if (restore && restore.generation === generation.current) {
          const resumePlaying = restore.snapshot.playing && AppState.currentState === 'active';
          player.currentTime = restore.snapshot.positionSeconds;
          player.playbackRate = requestedRate.current;
          snapshot.current = { ...restore.snapshot, playing: resumePlaying, ...(event.duration > 0 ? { durationSeconds: event.duration } : {}) };
          setPosition(restore.snapshot.positionSeconds);
          setPlaying(resumePlaying);
          pending.current = null;
          replacing.current = false;
          observed.current = true;
          if (resumePlaying) player.play();
          else player.pause();
        }
        applyTracks();
      }),
      player.addListener('availableAudioTracksChange', ({ availableAudioTracks }) => { setAudioTracks(availableAudioTracks); applyTracks(); }),
      player.addListener('availableSubtitleTracksChange', ({ availableSubtitleTracks }) => { setSubtitleTracks(availableSubtitleTracks); applyTracks(); }),
      player.addListener('videoTrackChange', ({ videoTrack }) => {
        setVideoResolution(videoTrack ? `${videoTrack.size.width} x ${videoTrack.size.height}` : '');
      }),
      player.addListener('playToEnd', () => flush()),
    ];
    const app = AppState.addEventListener('change', (state) => {
      adSchedule.current?.resetObservation();
      if (state !== 'active') { finishAdRef.current(); flush(); player.pause(); snapshot.current.playing = false; flush(snapshot.current); }
      else if (adResume.current) restoreAdContent();
    });
    return () => {
      flush();
      alive.current = false;
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
    setStreams([]);
    setSelectedStream(null);
    setCatalogNotice(source.streamCatalogUrl ? 'Discovering stream options...' : '');
    if (source.streamCatalogUrl) void fetchStreamCatalog(source.streamCatalogUrl, controller.signal).then((catalog) => {
      if (controller.signal.aborted) return;
      setStreams(catalog.streams);
      const fastest = chooseStream(catalog.streams, desired.current, 'quality');
      if (fastest) {
        setPreferences(compatiblePreferences(fastest, desired.current));
        setSelectedStream(fastest);
      }
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
  const quality = stream?.qualities.find((q) => qualityKey(q) === preferences.quality);
  const url = renditionUrl(stream?.url ?? source.url, preferences.quality === 'auto' ? undefined : quality);
  useEffect(() => {
    resetIntroSeek();
    finishAdRef.current(); adResume.current = null;
    adSchedule.current?.resetObservation();
    const id = ++generation.current;
    const saved = observe();
    flush(snapshot.current);
    replacing.current = true;
    setLoading(true);
    queue.current = queue.current.catch(() => {}).then(async () => {
      if (!alive.current || id !== generation.current) return;
      pending.current = { generation: id, url, snapshot: saved };
      try {
        await player.replaceAsync({ uri: url, contentType: source.kind === 'hls' ? 'hls' : source.kind === 'dash' ? 'dash' : 'progressive' });
      } catch {
        if (alive.current && id === generation.current) callbacks.current.onError();
      }
    });
  }, [player, url, source.kind]);

  useEffect(() => { if (!replacing.current) applyTracks(); }, [player, preferences.audio, preferences.subtitle, selectedStream]);

  const sidecar = preferences.subtitle.startsWith('sidecar:')
    ? sidecars.find((t) => `sidecar:${t.id}` === preferences.subtitle)
    : stream?.subtitles.find((t) => trackKey(t) === preferences.subtitle && t.url);
  useEffect(() => {
    const controller = new AbortController();
    setCues([]);
    if (sidecar?.url) {
      const safe = sameOriginPlaybackUrl(sidecar.url);
      if (safe) void fetch(safe, { signal: controller.signal }).then(async (response) => {
        if (!response.ok || Number(response.headers.get('content-length')) > 2 * 1024 * 1024) throw new Error('Unavailable subtitle.');
        const parsed = parseVtt(await response.text());
        if (!controller.signal.aborted) { setCues(parsed); if (!parsed.length) setNotice('No readable VTT cues were found.'); }
      }).catch(() => { if (!controller.signal.aborted) setNotice('Selected subtitles could not be loaded.'); });
    }
    return () => controller.abort();
  }, [sidecar?.url]);

  function seek(next: number) {
    if (replacing.current || adActive.current || !Number.isFinite(next)) return false;
    if (introSeekTarget.current !== null && next !== introSeekTarget.current) resetIntroSeek();
    adSchedule.current?.resetObservation();
    const target = Math.max(0, Math.min(player.duration > 0 ? player.duration : Infinity, next));
    player.currentTime = target;
    snapshot.current = { ...snapshot.current, positionSeconds: target };
    setPosition(target);
    flush(snapshot.current);
    return true;
  }

  function skipIntro() {
    const marker = introRef.current;
    try {
      if (!alive.current || !observed.current || !canSkipIntro(marker, player.currentTime, player.duration,
        replacing.current || adActive.current || introSeekTarget.current !== null || player.status !== 'readyToPlay')) return;
      // Lock synchronously: repeated taps can arrive before React removes the button or native seek completes.
      introSeekTarget.current = marker.endSeconds;
      setIntroSeeking(true);
      if (!seek(marker.endSeconds)) resetIntroSeek();
    } catch { resetIntroSeek(); }
  }

  function change(field: keyof Preferences, value: string) {
    if (adActive.current) return;
    const next = { ...preferences, [field]: value };
    const chosen = chooseStream(streams, next, field, stream?.id);
    setPreferences(chosen ? compatiblePreferences(chosen, next) : next);
    if (chosen) setSelectedStream(chosen);
  }

  function touchEnd(event: GestureResponderEvent) {
    if (adActive.current) return;
    const start = touchStart.current;
    const { pageX: x, pageY: y, locationX } = event.nativeEvent;
    touchStart.current = null;
    if (!start || Math.hypot(start.x - x, start.y - y) > 16) { lastTap.current = null; return; }
    if (locationX > width / 3 && locationX < width * 2 / 3) { setChrome((value) => !value); lastTap.current = null; return; }
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
  for (const s of streams) {
    if (new URL(s.url).pathname === '/api/vidnest') for (const q of s.qualities) if (!q.auto) {
      const h = qualityHeight(q);
      qualities.set(qualityKey(q), h === 2160 ? '4K' : h ? `${h}p` : q.label);
    }
    for (const t of s.audioTracks) audio.set(trackKey(t), t.label || t.language);
    for (const t of s.subtitles) subtitles.set(trackKey(t), t.label || t.language);
  }
  for (const t of audioTracks) audio.set(trackKey(t), t.label || t.language);
  for (const t of subtitleTracks) subtitles.set(trackKey(t), t.label || t.language);
  for (const t of sidecars) subtitles.set(`sidecar:${t.id}`, t.label);
  const text = subtitleText(cues, position, offset);
  const presentationBottom = chrome ? controlsHeight + 12 : insets.bottom + 28;
  const hasIntroRoom = height - presentationBottom - (text ? captionHeight + 12 : 0) - 44
    >= (chrome ? headerHeight : insets.top + 56) + 12;
  let introVisible = false;
  if (alive.current && observed.current && hasIntroRoom && !settings) {
    try {
      introVisible = canSkipIntro(intro, player.currentTime, player.duration,
        source.kind === 'embed' || replacing.current || loading || adBusy || adActive.current || introSeeking || player.status !== 'readyToPlay');
    } catch { /* Released/unfinished players cannot prove a safe intro target. */ }
  }

  return <View style={styles.root}>
    <StatusBar hidden={fullscreen} style="light" />
    <VideoView player={player} style={StyleSheet.absoluteFill} contentFit="contain" nativeControls={false}
      fullscreenOptions={{ enable: false }} surfaceType="textureView" />
    <View style={StyleSheet.absoluteFill} onTouchStart={(e) => { touchStart.current = { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY }; }}
      onTouchEnd={touchEnd} onTouchCancel={() => { touchStart.current = null; lastTap.current = null; }} />
    {(introVisible || text) && !adBusy ? <View pointerEvents="box-none" style={[styles.presentation, { bottom: presentationBottom,
      left: Math.max(insets.left + 16, width * 0.05), right: Math.max(insets.right + 16, width * 0.05) }]}>
      {introVisible ? <View style={styles.introAction}><Action label="Skip intro" onPress={skipIntro} /></View> : null}
      {text ? <View pointerEvents="none" onLayout={(event) => setCaptionHeight(event.nativeEvent.layout.height)} style={styles.subtitles}>
        <Text style={styles.subtitleText}>{text}</Text>
      </View> : null}
    </View> : null}
    {loading ? <Text pointerEvents="none" style={styles.loading}>Buffering...</Text> : null}
    {chrome ? <View pointerEvents="box-none" onLayout={(event) => setHeaderHeight(event.nativeEvent.layout.height)} style={[styles.header, { paddingTop: insets.top + 12 }]}>{header}
      {upNext && duration > 0 && position >= duration * 0.9 && duration - position <= 90 ? <Action label={upNext.label} onPress={upNext.onPress} /> : null}
    </View> : null}
    {!chrome ? <View style={[styles.reveal, { top: insets.top + 12 }]}><Action label="Show controls" onPress={() => setChrome(true)} /></View> : null}
    {settings ? <ScrollView style={[styles.settings, { top: insets.top + 66, maxHeight: height * 0.5 }]}
      contentContainerStyle={styles.settingsContent} accessibilityLabel="Playback settings">
      <Action label="Close settings" onPress={() => setSettings(false)} />
      <Text style={styles.label}>Quality</Text>
      <View style={styles.row}><Action label="Auto" selected={preferences.quality === 'auto'} onPress={() => change('quality', 'auto')} />
        {[...qualities].map(([id, label]) => <Action key={id} label={label} selected={preferences.quality === id} onPress={() => change('quality', id)} />)}</View>
      <Text style={styles.detail}>{videoResolution ? `Playing ${videoResolution}` : 'Adaptive playback'}{catalogNotice ? `\n${catalogNotice}` : ''}</Text>
      <Text style={styles.label}>Audio</Text>
      <View style={styles.row}>{[...audio].map(([id, label]) => <Action key={id} label={`Audio: ${label}`} selected={preferences.audio === id}
        onPress={() => change('audio', id)} />)}</View>
      {!audio.size ? <Text style={styles.detail}>No selectable audio tracks reported by this source.</Text> : null}
      <Text style={styles.label}>Subtitles</Text>
      <View style={styles.row}><Action label="Subtitles off" selected={preferences.subtitle === 'off'} onPress={() => change('subtitle', 'off')} />
        {[...subtitles].map(([id, label]) => <Action key={id} label={`Subtitles: ${label}`} selected={preferences.subtitle === id} onPress={() => change('subtitle', id)} />)}</View>
      <Text style={styles.detail}>{sidecar ? `Subtitle offset ${offset.toFixed(2)}s (positive delays)` : 'Timing adjustment is available for VTT sidecars only. Native HLS captions use their encoded timing.'}</Text>
      <View style={styles.row}><Action label="Advance subtitles by 0.25 seconds" disabled={!sidecar} onPress={() => setOffset((n) => Math.max(-10, n - 0.25))} />
        <Action label="Delay subtitles by 0.25 seconds" disabled={!sidecar} onPress={() => setOffset((n) => Math.min(10, n + 0.25))} />
        <Action label="Reset subtitle timing" disabled={!sidecar} onPress={() => setOffset(0)} /></View>
      <Text style={styles.label}>Speed</Text>
      <View style={styles.row}>{[0.5, 0.75, 1, 1.25, 1.5, 2].map((speed) => <Action key={speed} label={`${speed}x`} selected={rate === speed}
        onPress={() => { adSchedule.current?.resetObservation(); player.playbackRate = speed; setRate(speed); }} />)}</View>
      <Text style={styles.label}>Advertising privacy</Text>
      <Text style={styles.detail}>Video advertising is off unless you opt in here. VAST beacon delivery is disabled on Android. This choice is separate from permission to load a streaming source.</Text>
      <View style={styles.row}><Action label="Allow video advertising" selected={adConsent} onPress={() => chooseAdConsent(true)} />
        <Action label="Decline video advertising" selected={!adConsent} onPress={() => chooseAdConsent(false)} /></View>
      <Text style={styles.detail}>Google Cast is unsupported in this build. No native Cast module is installed.</Text>
    </ScrollView> : null}
    {chrome ? <View onLayout={(event) => setControlsHeight(event.nativeEvent.layout.height)} style={[styles.controls, { paddingBottom: insets.bottom + 12 }]}>
      {!!notice && <Text accessibilityLiveRegion="polite" style={styles.detail}>{notice}</Text>}
      <Text style={styles.detail}>{timeLabel(position)} / {duration > 0 ? timeLabel(duration) : '--:--'}</Text>
      <Pressable accessibilityRole="adjustable" accessibilityLabel="Playback position" disabled={duration <= 0 || loading || adBusy}
        accessibilityValue={{ min: 0, max: Math.round(duration), now: Math.round(position), text: timeLabel(position) }}
        accessibilityActions={[{ name: 'increment', label: 'Forward 10 seconds' }, { name: 'decrement', label: 'Back 10 seconds' }]}
        onAccessibilityAction={(e) => seek(position + (e.nativeEvent.actionName === 'increment' ? 10 : -10))}
        onPress={(e) => seek(e.nativeEvent.locationX / Math.max(1, width - 32) * duration)} style={styles.scrubber}>
        <View style={[styles.progress, { width: `${duration > 0 ? Math.min(100, position / duration * 100) : 0}%` }]} />
      </Pressable>
      <View style={styles.row}>
        <Action label="Back 10 seconds" disabled={loading || adBusy} onPress={() => seek(observe().positionSeconds - 10)} />
        <Action label={playing ? 'Pause' : 'Play'} disabled={loading || adBusy} onPress={() => { if (adActive.current) return; if (player.playing) { const paused = observe(); player.pause(); snapshot.current = { ...paused, playing: false }; flush(snapshot.current); } else player.play(); }} />
        <Action label="Forward 10 seconds" disabled={loading || adBusy} onPress={() => seek(observe().positionSeconds + 10)} />
        <Action label="Settings" selected={settings} onPress={() => setSettings((value) => !value)} />
        <Action label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'} onPress={() => setFullscreen((value) => !value)} />
      </View>
      {footer}
    </View> : null}
    {adBusy && !ad ? <View style={styles.adLoading} accessibilityLabel="Loading advertisement"><Text style={styles.detail}>Loading advertisement...</Text></View> : null}
    {ad ? <NativeVastAd creative={ad.creative} policy={ad.policy} volume={ad.volume} muted={ad.muted} onDone={() => finishAdRef.current()} /> : null}
  </View>;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  header: { position: 'absolute', top: 0, left: 0, right: 0, paddingHorizontal: 16 },
  controls: { position: 'absolute', bottom: 0, left: 0, right: 0, paddingHorizontal: 16, gap: 8, backgroundColor: 'rgba(0,0,0,0.78)' },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  button: { minHeight: 44, minWidth: 44, paddingHorizontal: 12, paddingVertical: 12, borderRadius: 10, backgroundColor: '#252630', justifyContent: 'center' },
  selected: { backgroundColor: colors.primary },
  buttonText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  label: { color: '#fff', fontSize: 16, fontWeight: '600', marginTop: 8 },
  detail: { color: '#ddd', fontSize: 12 },
  settings: { position: 'absolute', left: 16, right: 16, backgroundColor: '#14151c', borderRadius: 12, borderWidth: 1, borderColor: '#444', zIndex: 4 },
  settingsContent: { padding: 16, gap: 10 },
  scrubber: { height: 44, justifyContent: 'center', backgroundColor: '#363740', borderRadius: 8, overflow: 'hidden' },
  progress: { height: 6, backgroundColor: colors.primary },
  loading: { position: 'absolute', top: '42%', alignSelf: 'center', color: '#fff', backgroundColor: '#111', padding: 12 },
  presentation: { position: 'absolute', alignItems: 'center', gap: 12 },
  introAction: { alignSelf: 'flex-end' },
  subtitles: { alignItems: 'center', maxWidth: '100%' },
  subtitleText: { color: '#fff', backgroundColor: 'rgba(0,0,0,0.8)', fontSize: 20, textAlign: 'center', padding: 8 },
  reveal: { position: 'absolute', right: 16 },
  adLoading: { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, zIndex: 30, backgroundColor: '#06070a', justifyContent: 'center', alignItems: 'center' },
});
