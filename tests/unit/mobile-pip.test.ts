import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DirectStream } from '../../mobile/src/lib/types';
import { SOURCE_READY_TIMEOUT_MS } from '../../mobile/src/player/capabilities';

// JS hook/event coverage only. Android's native PiP window still requires a rebuilt device binary.
const mock = vi.hoisted(() => {
  const listeners = new Map<string, Set<(event: any) => void>>();
  const appListeners = new Set<(state: string) => void>();
  const player = {
    currentTime: 0, duration: 180, playing: false, status: 'readyToPlay', playbackRate: 1.25,
    volume: 1, muted: false, availableAudioTracks: [] as any[], availableSubtitleTracks: [] as any[],
    audioTrack: null as any, subtitleTrack: null as any, timeUpdateEventInterval: 0, staysActiveInBackground: false,
    play: vi.fn(), pause: vi.fn(), replaceAsync: vi.fn(),
    addListener: vi.fn((event: string, callback: (value: any) => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(callback);
      return { remove: () => listeners.get(event)?.delete(callback) };
    }),
  };
  return {
    player, listeners, appListeners, states: [] as any[], refs: [] as any[],
    effects: [] as Array<{ deps?: unknown[]; cleanup?: () => void }>, jobs: [] as Array<() => void>,
    stateIndex: 0, refIndex: 0, effectIndex: 0, dirty: false, initialized: false,
    dimensions: { width: 400, height: 800 }, insets: { top: 24, bottom: 16, left: 0, right: 0 },
    storage: new Map<string, string>(), getItem: vi.fn(), setItem: vi.fn(),
    pipSupported: true, startPictureInPicture: vi.fn(), stopPictureInPicture: vi.fn(),
    app: { currentState: 'active', addEventListener: vi.fn((_event: string, callback: (state: string) => void) => {
      appListeners.add(callback); return { remove: () => appListeners.delete(callback) };
    }) },
    streams: vi.fn(), subtitles: vi.fn(), vast: vi.fn(), adDue: false, sampleAd: vi.fn(), resetObservation: vi.fn(),
    orientation: vi.fn(), animation: vi.fn(),
  };
});

vi.mock('../../mobile/node_modules/react', async (original) => ({ ...await original<typeof import('react')>(),
  useState: (initial: unknown) => {
    const index = mock.stateIndex++;
    if (!(index in mock.states)) mock.states[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
    return [mock.states[index], (next: any) => {
      const value = typeof next === 'function' ? next(mock.states[index]) : next;
      if (!Object.is(value, mock.states[index])) { mock.states[index] = value; mock.dirty = true; }
    }];
  },
  useRef: (initial: unknown) => {
    const index = mock.refIndex++;
    return mock.refs[index] ??= { current: initial };
  },
  useEffect: (effect: () => void | (() => void), deps?: unknown[]) => {
    const index = mock.effectIndex++;
    const prior = mock.effects[index];
    if (!prior || !deps || !prior.deps || deps.length !== prior.deps.length
      || deps.some((value, i) => !Object.is(value, prior.deps![i]))) {
      const slot = { deps, cleanup: prior?.cleanup }; mock.effects[index] = slot;
      mock.jobs.push(() => { slot.cleanup?.(); slot.cleanup = effect() || undefined; });
    }
  },
}));
vi.mock('../../mobile/node_modules/react-native', () => ({ AppState: mock.app,
  BackHandler: { addEventListener: () => ({ remove: vi.fn() }) },
  Platform: { OS: 'android', Version: 35 },
  Pressable: 'Pressable', ScrollView: 'ScrollView', Text: 'Text', View: 'View',
  ActivityIndicator: 'ActivityIndicator', Animated: { View: 'AnimatedView', Value: class { interpolate() { return 0; } }, timing: mock.animation },
  useWindowDimensions: () => mock.dimensions,
  StyleSheet: { create: (value: unknown) => value, absoluteFill: { position: 'absolute' } },
}));
vi.mock('../../mobile/node_modules/react-native-safe-area-context', () => ({ useSafeAreaInsets: () => mock.insets }));
vi.mock('../../mobile/node_modules/expo-status-bar', () => ({ StatusBar: 'StatusBar' }));
vi.mock('../../mobile/node_modules/expo-screen-orientation', () => ({ OrientationLock: { DEFAULT: 0, LANDSCAPE: 5 } }));
vi.mock('../../mobile/src/player/orientation', () => ({ acquireOrientation: mock.orientation }));
vi.mock('../../mobile/node_modules/@react-native-async-storage/async-storage', () => ({ default: {
  getItem: mock.getItem, setItem: mock.setItem,
} }));
vi.mock('../../mobile/node_modules/expo-video', () => ({
  VideoView: 'VideoView',
  isPictureInPictureSupported: () => mock.pipSupported,
  useVideoPlayer: (_source: unknown, setup: (player: typeof mock.player) => void) => {
    if (!mock.initialized) { mock.initialized = true; setup(mock.player); }
    return mock.player;
  },
}));
vi.mock('../../mobile/src/player/VastAdBreak', () => ({ default: 'NativeVastAd' }));
vi.mock('../../mobile/src/player/policy', async (original) => ({ ...await original<typeof import('../../mobile/src/player/policy')>(),
  createNativeAdSchedule: () => ({ sample: mock.sampleAd, resetObservation: mock.resetObservation, finish: vi.fn() }),
}));
vi.mock('../../mobile/src/lib/api', () => ({
  fetchVastCreative: mock.vast, fetchSubtitleCatalog: mock.subtitles, fetchStreamCatalog: mock.streams,
  withPlaybackDeadline: async (operation: (signal: AbortSignal) => unknown) => operation(new AbortController().signal),
  sameOriginPlaybackUrl: (url: string) => new URL(url, 'https://movies.example').href,
}));

const nativePath = '../../mobile/src/player/NativePlayer';
const {
  default: NativePlayer, DISPLAY_MODE_KEY, displayModeContentFit, parseDisplayMode,
} = await import(nativePath);

const source = { id: 'direct', label: 'Direct', kind: 'hls', consentRequired: false,
  url: 'https://movies.example/api/vidnest?token=content' } as const;
let props: any;
let tree: any;

function nodes(value: any = tree): any[] {
  function walk(node: any): any[] {
    if (Array.isArray(node)) return node.flatMap(walk);
    return node && typeof node === 'object' ? [node, ...walk(node.props?.children)] : [];
  }
  return walk(value);
}
const rawAction = (label: string) => nodes().find((node) => node.props?.label === label);
function openGroup(label: string) {
  const heading = nodes().find((node) => node.props?.label === label && typeof node.props.expanded === 'boolean');
  if (heading && !heading.props.expanded) { heading.props.onPress(); render(); }
}
// Drive real settings headings before selecting a choice in the compact sheet.
function action(label: string) {
  if (/^[\d.]+x$/.test(label)) openGroup('Speed');
  else if (/^\d+p$|^4K$|^Auto$/.test(label)) openGroup('Quality');
  else if (/^Audio:|^Retry selected audio stream$/.test(label)) openGroup('Audio');
  else if (/^Subtitles:/.test(label)) openGroup('Subtitles');
  else if (['Fit', 'Fill', 'Zoom', 'Allow video advertising', 'Decline video advertising'].includes(label)) openGroup('Display');
  return rawAction(label);
}
const audioStreamAction = (number: number) => { openGroup('Audio'); return nodes().find((node) => node.props?.accessibilityLabel === `Audio stream ${number}`); };
const audioAuto = () => { openGroup('Audio'); return nodes().find((node) => node.props?.accessibilityLabel === 'Audio Auto'); };
const text = () => nodes().filter((node) => node.type === 'Text').map((node) => node.props.children).flat().join(' ');
const video = () => nodes().find((node) => node.type === 'VideoView');

function render(commit = true) {
  mock.stateIndex = 0; mock.refIndex = 0; mock.effectIndex = 0; mock.dirty = false;
  tree = NativePlayer(props);
  const view = video();
  if (view?.props.ref) view.props.ref.current = {
    startPictureInPicture: mock.startPictureInPicture,
    stopPictureInPicture: mock.stopPictureInPicture,
  };
  if (commit) while (mock.jobs.length) mock.jobs.shift()!();
  return tree;
}

async function settle() {
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
    if (mock.dirty) render();
    else if (!mock.jobs.length) {
      await Promise.resolve();
      if (!mock.dirty) break;
    }
  }
}

const emit = (event: string, value: unknown = {}) => mock.listeners.get(event)?.forEach((listener) => listener(value));
function appState(state: string) {
  mock.app.currentState = state;
  mock.appListeners.forEach((listener) => listener(state));
}
async function mount(overrides: any = {}) {
  props = { source, initial: { positionSeconds: 12.5, playing: true }, header: 'Header', footer: 'Footer',
    onCheckpoint: vi.fn(), onError: vi.fn(), ...overrides };
  render(); await settle();
  mock.player.status = 'readyToPlay';
  emit('sourceLoad', { videoSource: { uri: props.source.url }, duration: mock.player.duration,
    availableAudioTracks: [], availableSubtitleTracks: [] });
  emit('statusChange', { status: 'readyToPlay' });
  render(); await settle();
}

beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  mock.states.length = 0; mock.refs.length = 0; mock.effects.length = 0; mock.jobs.length = 0;
  mock.listeners.clear(); mock.appListeners.clear(); mock.storage.clear();
  mock.stateIndex = 0; mock.refIndex = 0; mock.effectIndex = 0; mock.dirty = false; mock.initialized = false;
  mock.pipSupported = true; mock.adDue = false; mock.app.currentState = 'active';
  mock.dimensions = { width: 400, height: 800 }; mock.insets = { top: 24, bottom: 16, left: 0, right: 0 };
  mock.player.currentTime = 0; mock.player.duration = 180; mock.player.playing = false;
  mock.player.availableAudioTracks = []; mock.player.availableSubtitleTracks = [];
  Object.defineProperty(mock.player, 'audioTrack', { configurable: true, writable: true, value: null });
  mock.player.subtitleTrack = null;
  mock.player.status = 'readyToPlay'; mock.player.playbackRate = 1.25;
  mock.player.play.mockImplementation(() => { mock.player.playing = true; });
  mock.player.pause.mockImplementation(() => { mock.player.playing = false; });
  mock.player.replaceAsync.mockResolvedValue(undefined);
  mock.startPictureInPicture.mockResolvedValue(undefined);
  mock.stopPictureInPicture.mockImplementation(() => { throw new Error('Unsupported on Android'); });
  mock.getItem.mockImplementation(async (key: string) => mock.storage.get(key) ?? null);
  mock.setItem.mockImplementation(async (key: string, value: string) => { mock.storage.set(key, value); });
  mock.streams.mockResolvedValue({ streams: [] }); mock.subtitles.mockResolvedValue([]); mock.vast.mockResolvedValue(null);
  mock.sampleAd.mockImplementation(() => mock.adDue);
  mock.orientation.mockReturnValue(vi.fn());
  mock.animation.mockReturnValue({ start: vi.fn(), stop: vi.fn() });
});
afterEach(() => {
  mock.effects.forEach((effect) => effect.cleanup?.());
  vi.useRealTimers();
});

describe('Android source readiness, explicit retry and simple controls', () => {
  async function pending(overrides: any = {}) {
    props = { source, initial: { positionSeconds: 37.125, playing: true }, header: 'Header', footer: 'Footer',
      onCheckpoint: vi.fn(), onError: vi.fn(), ...overrides };
    mock.player.status = 'loading';
    render(); await settle();
  }
  function loaded(url = source.url) {
    emit('sourceChange', { source: { uri: url } });
    emit('sourceLoad', { videoSource: { uri: url }, duration: 180, availableAudioTracks: [], availableSubtitleTracks: [] });
    render();
  }
  it('starts replaceAsync before a stalled catalog and never treats its promise or metadata alone as ready', async () => {
    mock.streams.mockReturnValue(new Promise(() => {}));
    await pending({ source: { ...source, streamCatalogUrl: 'https://movies.example/api/vidnest?metadata=1' } });
    expect(mock.player.replaceAsync).toHaveBeenCalledExactlyOnceWith({ uri: source.url, contentType: 'hls' });
    expect(mock.player.play).not.toHaveBeenCalled(); expect(mock.player.currentTime).toBe(0);
    loaded(); expect(mock.player.play).not.toHaveBeenCalled(); expect(mock.player.currentTime).toBe(0);
    mock.player.status = 'readyToPlay'; emit('statusChange', { status: 'readyToPlay' }); render();
    expect(mock.player.currentTime).toBe(37.125); expect(mock.player.play).toHaveBeenCalledOnce();
    expect(mock.player.replaceAsync).toHaveBeenCalledOnce();
  });
  it('ignores foreign and missing source metadata, and an unattributed ready event', async () => {
    await pending();
    emit('sourceLoad', { videoSource: { uri: `${source.url}&old=1` }, duration: 1, availableAudioTracks: [], availableSubtitleTracks: [] });
    emit('sourceLoad', { videoSource: null, duration: 1, availableAudioTracks: [], availableSubtitleTracks: [] });
    emit('statusChange', { status: 'readyToPlay' }); render();
    expect(mock.player.play).not.toHaveBeenCalled();
    loaded(); expect(mock.player.play).not.toHaveBeenCalled();
    mock.player.status = 'readyToPlay'; emit('statusChange', { status: 'readyToPlay' }); render();
    expect(mock.player.currentTime).toBe(37.125);
  });
  it('times out a stalled native replacement once, retains the same player, and retries only on an explicit action', async () => {
    mock.player.replaceAsync.mockReturnValue(new Promise(() => {}));
    await pending(); const player = video().props.player;
    await vi.advanceTimersByTimeAsync(SOURCE_READY_TIMEOUT_MS + 1); render();
    expect(action('Retry')).toBeDefined(); expect(video().props.player).toBe(player);
    expect(props.onError).toHaveBeenCalledOnce(); expect(mock.player.replaceAsync).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000); render();
    expect(mock.player.replaceAsync).toHaveBeenCalledOnce();
    mock.player.status = 'readyToPlay'; loaded(); expect(mock.player.play).not.toHaveBeenCalled();
    const retry = action('Retry'); retry.props.onPress(); retry.props.onPress(); render(); await settle();
    expect(mock.player.replaceAsync).toHaveBeenCalledTimes(2);
    loaded(); emit('statusChange', { status: 'readyToPlay' }); render();
    expect(mock.player.currentTime).toBe(37.125); expect(video().props.player).toBe(player);
    expect(action('Retry')).toBeUndefined();
  });
  it('does not let a catalog completion interrupt the default adaptive master', async () => {
    let resolve!: (value: unknown) => void;
    mock.streams.mockReturnValue(new Promise((done) => { resolve = done; }));
    await mount({ source: { ...source, streamCatalogUrl: 'https://movies.example/api/vidnest?metadata=1' } });
    resolve({ streams: [{ id: 'fast-fixed-4k', url: 'https://movies.example/api/vidnest?token=other', startupLatencyMs: 0,
      qualities: [{ id: 'q', label: '4K', height: 2160 }], audioTracks: [], subtitles: [] }] });
    await settle();
    expect(mock.player.replaceAsync).toHaveBeenCalledExactlyOnceWith({ uri: source.url, contentType: 'hls' });
  });
  it('presents one settings group at a time, large Play/Pause, a 44px timeline and native opacity/transform-only sheet animation', async () => {
    await mount();
    const pause = rawAction('Pause').type(rawAction('Pause').props);
    expect(pause.props.style[1]).toMatchObject({ minWidth: 76, minHeight: 76 });
    const timeline = nodes().find((node) => node.props?.accessibilityLabel === 'Playback position');
    expect(timeline.props.style.height).toBe(44);
    rawAction('Settings').props.onPress(); render();
    expect(rawAction('Auto')).toBeDefined(); expect(rawAction('Zoom')).toBeUndefined(); expect(rawAction('1.5x')).toBeUndefined();
    for (const name of ['Quality', 'Audio', 'Subtitles', 'Speed', 'Display']) {
      const heading = rawAction(name).type(rawAction(name).props);
      expect(heading.props.accessibilityRole).toBe('button'); expect(heading.props.style.minHeight).toBeGreaterThanOrEqual(44);
    }
    openGroup('Display'); expect(rawAction('Auto')).toBeUndefined(); expect(rawAction('Zoom')).toBeDefined();
    expect(mock.animation).toHaveBeenLastCalledWith(expect.anything(), { toValue: 1, duration: 160, useNativeDriver: true });
    const sheet = nodes().find((node) => node.type === 'AnimatedView');
    expect(sheet.props.style[1]).toHaveProperty('opacity'); expect(sheet.props.style[1].transform).toHaveLength(1);
  });
});

describe('Android verified native episode actions and ended-only Auto Next', () => {
  const controls = (autoNext = false) => ({ previous: { label: 'S1 E1', onPress: vi.fn() }, next: { label: 'S1 E3', onPress: vi.fn() },
    autoNext, onAutoNextChange: vi.fn(), blocked: false, loading: false });
  function ended() { mock.player.currentTime = mock.player.duration; mock.player.playing = false; emit('playToEnd'); render(); }
  it('has no movie controls, but exposes direct TV Previous/Next and a default-off accessible toggle', async () => {
    await mount(); expect(action('Previous')).toBeUndefined(); expect(action('Next')).toBeUndefined();
    const episodes = controls(); props = { ...props, episodes }; render();
    for (const name of ['Previous', 'Next', 'Auto Next: Off']) {
      const button = action(name).type(action(name).props); expect(button.props.style[0]).toMatchObject({ minWidth: 44, minHeight: 44 });
    }
    expect(action('Auto Next: Off').type(action('Auto Next: Off').props).props).toMatchObject({ accessibilityRole: 'switch', accessibilityState: { checked: false } });
    action('Previous').props.onPress(); action('Next').props.onPress();
    expect(episodes.previous.onPress).toHaveBeenCalledOnce(); expect(episodes.next.onPress).toHaveBeenCalledOnce();
    ended(); expect(episodes.next.onPress).toHaveBeenCalledOnce();
  });
  it('advances exactly once on a real native content-ended event, never from a near-end sample or timer', async () => {
    const episodes = controls(true); await mount({ episodes });
    mock.player.currentTime = 179.9; emit('timeUpdate', { currentTime: 179.9 }); render();
    await vi.advanceTimersByTimeAsync(60_000); expect(episodes.next.onPress).not.toHaveBeenCalled();
    ended(); ended(); expect(episodes.next.onPress).toHaveBeenCalledOnce();
  });
  it('honors turning Auto Next off immediately, before the parent preference rerender', async () => {
    const episodes = controls(true); await mount({ episodes });
    action('Auto Next: On').props.onPress();
    expect(episodes.onAutoNextChange).toHaveBeenCalledWith(false);
    ended(); expect(episodes.next.onPress).not.toHaveBeenCalled();
  });
  it('ignores a stale terminal event at the start of content and while another source is replacing', async () => {
    const episodes = controls(true); await mount({ episodes });
    emit('playToEnd'); expect(episodes.next.onPress).not.toHaveBeenCalled();
    props = { ...props, source: { ...source, url: `${source.url}&new=1` } }; render(); await settle();
    ended(); expect(episodes.next.onPress).not.toHaveBeenCalled();
  });
  it.each(['background', 'party-member', 'party-host', 'blocked', 'missing-next'])('does not automatically advance for %s', async (gate) => {
    const episodes = controls(true);
    if (gate === 'blocked') episodes.blocked = true;
    if (gate === 'missing-next') episodes.next = null as any;
    await mount({ episodes, ...(gate.startsWith('party') ? { partyConnected: true, partyRole: gate === 'party-host' ? 'host' : 'member' } : {}) });
    if (gate === 'background') appState('background');
    const next = episodes.next?.onPress;
    ended(); expect(next?.mock.calls.length ?? 0).toBe(0);
    if (gate === 'background') { appState('active'); ended(); expect(next).not.toHaveBeenCalled(); }
  });
  it('gates both a retained episode button and a terminal event while VAST is loading', async () => {
    mock.storage.set('lumora:ads:consent', 'true'); mock.vast.mockReturnValue(new Promise(() => {}));
    const episodes = controls(true); await mount({ episodes, adPolicy: { enabled: true, firstBreakSeconds: 60, intervalSeconds: 60,
      maxBreaks: 1, allowSkip: true, skipAfterSeconds: 5 } });
    const next = action('Next'); mock.adDue = true; mock.player.currentTime = 13; emit('timeUpdate', { currentTime: 13 }); render();
    next.props.onPress(); ended(); expect(episodes.next.onPress).not.toHaveBeenCalled();
  });
  it('keeps an ad alive if content errors behind it, then exposes explicit content Retry after the ad finishes', async () => {
    mock.storage.set('lumora:ads:consent', 'true');
    mock.vast.mockResolvedValue({ id: 'fixture', mediaUrl: 'https://ads.example/ad.mp4', durationSeconds: 10, tracking: {} });
    await mount({ adPolicy: { enabled: true, firstBreakSeconds: 60, intervalSeconds: 60, maxBreaks: 1, allowSkip: false, skipAfterSeconds: 0 } });
    mock.adDue = true; mock.player.currentTime = 30; emit('timeUpdate', { currentTime: 30 }); render(); await settle();
    const ad = nodes().find((node) => node.type === 'NativeVastAd'); expect(ad).toBeDefined();
    mock.player.status = 'error'; emit('statusChange', { status: 'error' }); render();
    expect(nodes().find((node) => node.type === 'NativeVastAd')).toBeDefined(); expect(props.onError).not.toHaveBeenCalled();
    ad.props.onDone(); render(); await settle();
    expect(action('Retry')).toBeDefined(); expect(props.onError).toHaveBeenCalledOnce();
    expect(mock.player.currentTime).toBe(30);
  });
});

describe('Android display mode preferences', () => {
  it('maps Fit/Fill/Zoom exactly and rejects invalid persisted values', () => {
    expect(parseDisplayMode('fit')).toBe('fit');
    expect(parseDisplayMode('fill')).toBe('fill');
    expect(parseDisplayMode('zoom')).toBe('zoom');
    expect(parseDisplayMode('cover')).toBeNull();
    expect(parseDisplayMode(null)).toBeNull();
    expect(DISPLAY_MODE_KEY).toBe('lumora:player:display-mode:v1');
    expect(displayModeContentFit('fit')).toBe('contain');
    expect(displayModeContentFit('fill')).toBe('fill');
    expect(displayModeContentFit('zoom')).toBe('cover');
  });

  it('persists accessible 44px controls and changes only VideoView presentation', async () => {
    mock.storage.set(DISPLAY_MODE_KEY, 'invalid');
    await mount();
    const player = video().props.player;
    expect(video().props.contentFit).toBe('contain');
    expect(mock.player.replaceAsync).toHaveBeenCalledOnce();

    action('Settings').props.onPress(); render();
    const zoomControl = action('Zoom').type(action('Zoom').props);
    expect(zoomControl.props).toMatchObject({ accessibilityRole: 'button', accessibilityLabel: 'Zoom' });
    expect(zoomControl.props.style[0]).toMatchObject({ minHeight: 44, minWidth: 44 });

    action('Fill').props.onPress(); render(); await settle();
    expect(video().props).toMatchObject({ player, contentFit: 'fill', style: { position: 'absolute' } });
    action('Zoom').props.onPress(); render(); await settle();
    expect(video().props).toMatchObject({ player, contentFit: 'cover', style: { position: 'absolute' } });
    expect(mock.player.replaceAsync).toHaveBeenCalledOnce();
    expect(mock.setItem).toHaveBeenLastCalledWith(DISPLAY_MODE_KEY, 'zoom');
  });

  it('restores a valid saved mode without replacing the content source', async () => {
    mock.storage.set(DISPLAY_MODE_KEY, 'zoom');
    await mount();
    expect(video().props.contentFit).toBe('cover');
    expect(video().props.style).toEqual({ position: 'absolute' });
    expect(mock.player.replaceAsync).toHaveBeenCalledExactlyOnceWith({ uri: source.url, contentType: 'hls' });
  });
});

describe('Android expo-video PiP configuration and lifecycle', () => {
  it('enables the installed official config plugin while preserving dynamic app config plugins', () => {
    const appJson = JSON.parse(readFileSync(new URL('../../mobile/app.json', import.meta.url), 'utf8')).expo;
    const expoVideo = ['expo-video', { supportsPictureInPicture: true }];
    expect(appJson.plugins).toContainEqual(expoVideo);
    const appConfig = createRequire(import.meta.url)('../../mobile/app.config.js');
    expect(appConfig({ config: appJson }).plugins).toContainEqual(expoVideo);
    const pluginSource = readFileSync(new URL('../../mobile/node_modules/expo-video/plugin/src/withExpoVideo.ts', import.meta.url), 'utf8');
    expect(pluginSource).toContain("activity.$['android:supportsPictureInPicture'] = 'true'");
  });

  it('does not render a fake control when device support is absent', async () => {
    const androidSource = readFileSync(new URL('../../mobile/node_modules/expo-video/android/src/main/java/expo/modules/video/VideoView.kt', import.meta.url), 'utf8');
    expect(androidSource).toContain('Build.VERSION.SDK_INT >= Build.VERSION_CODES.O');
    expect(androidSource).toContain('android.content.pm.PackageManager.FEATURE_PICTURE_IN_PICTURE');
    mock.pipSupported = false;
    await mount();
    expect(action('Picture in picture')).toBeUndefined();
    expect(video().props).toMatchObject({ allowsPictureInPicture: false, startsPictureInPictureAutomatically: false });
  });

  it('never invokes Android stopPictureInPicture during lifecycle exit or cleanup', async () => {
    const nativeSource = readFileSync(new URL('../../mobile/src/player/NativePlayer.tsx', import.meta.url), 'utf8');
    expect(nativeSource).not.toContain('.stopPictureInPicture(');
    await mount();
    action('Picture in picture').props.onPress();
    video().props.onPictureInPictureStart(); render();
    appState('background');
    video().props.onPictureInPictureStop(); render();
    appState('active'); await settle();
    expect(mock.stopPictureInPicture).not.toHaveBeenCalled();
  });

  it('deduplicates entry and preserves URI, time, rate, play state, and checkpoints across background return', async () => {
    await mount();
    mock.startPictureInPicture.mockClear(); mock.player.play.mockClear(); mock.player.pause.mockClear();
    props.onCheckpoint.mockClear();
    mock.player.currentTime = 42.75; mock.player.playbackRate = 1.25; mock.player.playing = true;
    const pip = action('Picture in picture');
    expect(pip.props.disabled).toBe(false);
    pip.props.onPress(); pip.props.onPress();
    expect(mock.startPictureInPicture).toHaveBeenCalledOnce();
    expect(props.onCheckpoint).toHaveBeenLastCalledWith({ positionSeconds: 42.75, durationSeconds: 180, playing: true });

    appState('background');
    expect(mock.player.pause).not.toHaveBeenCalled();
    // expo-video can briefly auto-pause before the native PiP start callback on some Android paths.
    mock.player.playing = false; emit('playingChange', { isPlaying: false });
    video().props.onPictureInPictureStart(); render(); await settle();
    expect(mock.player.playing).toBe(true);
    expect(mock.player.playbackRate).toBe(1.25);
    expect(mock.player.play).toHaveBeenCalledOnce();

    mock.player.currentTime = 47.5;
    video().props.onPictureInPictureStop(); render();
    expect(mock.player.pause).toHaveBeenCalledOnce();
    expect(props.onCheckpoint).toHaveBeenLastCalledWith({ positionSeconds: 47.5, durationSeconds: 180, playing: false });
    appState('active'); await settle();
    expect(mock.player.currentTime).toBe(47.5);
    expect(mock.player.playbackRate).toBe(1.25);
    expect(mock.player.play).toHaveBeenCalledTimes(2);
    expect(props.onCheckpoint).toHaveBeenLastCalledWith({ positionSeconds: 47.5, durationSeconds: 180, playing: true });
    expect(mock.player.replaceAsync).toHaveBeenCalledExactlyOnceWith({ uri: source.url, contentType: 'hls' });
    expect(action('Picture in picture').props.disabled).toBe(false);
  });

  it('gates entry during source replacement and a custom fullscreen transition', async () => {
    await mount();
    mock.startPictureInPicture.mockClear();
    const oldPip = action('Picture in picture');
    props = { ...props, source: { ...source, id: 'replacement', url: `${source.url}&stream=2` } };
    render(); await settle();
    oldPip.props.onPress();
    expect(mock.startPictureInPicture).not.toHaveBeenCalled();

    emit('sourceLoad', { videoSource: { uri: props.source.url }, duration: 180, availableAudioTracks: [], availableSubtitleTracks: [] });
    emit('statusChange', { status: 'readyToPlay' }); render(); await settle();
    const readyPip = action('Picture in picture');
    action('Fullscreen').props.onPress();
    readyPip.props.onPress();
    expect(mock.startPictureInPicture).not.toHaveBeenCalled();
    render();
    expect(action('Picture in picture').props.disabled).toBe(true);
    mock.dimensions = { width: 800, height: 400 }; render(); await settle();
    expect(action('Picture in picture').props.disabled).toBe(false);
    action('Picture in picture').props.onPress();
    expect(mock.startPictureInPicture).toHaveBeenCalledOnce();
    video().props.onPictureInPictureStart(); render();
  });

  it('gates a retained PiP action while VAST is loading', async () => {
    mock.storage.set('lumora:ads:consent', 'true');
    mock.vast.mockReturnValue(new Promise(() => {}));
    await mount({ adPolicy: { enabled: true, firstBreakSeconds: 60, intervalSeconds: 60, maxBreaks: 1,
      allowSkip: true, skipAfterSeconds: 5 } });
    action('Settings').props.onPress(); render();
    expect(action('Allow video advertising').props.selected).toBe(true);
    action('Close settings').props.onPress(); render();
    mock.startPictureInPicture.mockClear();
    const oldPip = action('Picture in picture');
    mock.adDue = true; mock.player.currentTime = 13.5;
    emit('timeUpdate', { currentTime: 13.5 }); render();
    oldPip.props.onPress();
    expect(mock.sampleAd).toHaveBeenCalled();
    expect(mock.vast).toHaveBeenCalledOnce();
    expect(mock.startPictureInPicture).not.toHaveBeenCalled();
    expect(nodes().some((node) => node.props?.accessibilityLabel === 'Loading advertisement')).toBe(true);
  });

  it('defers VAST sampling while PiP is active and resumes after foreground exit', async () => {
    mock.storage.set('lumora:ads:consent', 'true');
    mock.vast.mockReturnValue(new Promise(() => {}));
    await mount({ adPolicy: { enabled: true, firstBreakSeconds: 60, intervalSeconds: 60, maxBreaks: 1,
      allowSkip: true, skipAfterSeconds: 5 } });
    action('Picture in picture').props.onPress();
    video().props.onPictureInPictureStart(); render();
    mock.sampleAd.mockClear(); mock.vast.mockClear(); mock.adDue = true;
    emit('timeUpdate', { currentTime: 20 });
    expect(mock.sampleAd).not.toHaveBeenCalled();
    expect(mock.vast).not.toHaveBeenCalled();

    video().props.onPictureInPictureStop(); render();
    emit('timeUpdate', { currentTime: 21 });
    expect(mock.sampleAd).toHaveBeenCalledOnce();
    expect(mock.vast).toHaveBeenCalledOnce();
  });
});

describe('Android numbered audio stream choices', () => {
  const catalogUrl = 'https://movies.example/api/vidnest?metadata=1';
  const candidate = (index: number, latency?: number, heights: number[] = [], language?: string): DirectStream => ({
    id: `catalog-${index}`, url: `https://movies.example/api/vidnest?token=snapshot-${index}`,
    ...(latency === undefined ? {} : { startupLatencyMs: latency }),
    qualities: heights.map((height, variant) => ({ id: `${index}-${variant}`, height, label: `${height}p` })),
    audioTracks: language ? [{ id: 'real', label: language, language }] : [], subtitles: [],
  });
  const currentUrl = () => mock.player.replaceAsync.mock.calls.at(-1)![0].uri as string;
  async function loaded(url = currentUrl()) {
    mock.player.status = 'readyToPlay';
    emit('sourceLoad', { videoSource: { uri: url }, duration: 180,
      availableAudioTracks: mock.player.availableAudioTracks, availableSubtitleTracks: mock.player.availableSubtitleTracks });
    emit('statusChange', { status: 'readyToPlay' }); render(); await settle();
  }
  async function catalog(candidates: DirectStream[], overrides: any = {}) {
    mock.streams.mockResolvedValue({ streams: candidates, recommendedStreamId: candidates[0]?.id });
    await mount({ source: { ...source, streamCatalogUrl: catalogUrl }, ...overrides });
    await loaded();
    action('Settings').props.onPress(); render();
  }

  it('keeps initial playback nonblocking and then exposes ALL real streams, including empty metadata, as 1 through 12', async () => {
    let resolve!: (value: unknown) => void;
    mock.streams.mockReturnValue(new Promise((done) => { resolve = done; }));
    await mount({ source: { ...source, streamCatalogUrl: catalogUrl } });
    expect(mock.player.playing).toBe(true);
    expect(mock.player.replaceAsync).toHaveBeenCalledExactlyOnceWith({ uri: source.url, contentType: 'hls' });
    action('Settings').props.onPress(); render();
    openGroup('Audio');
    expect(text()).toContain('Select different audio streams to find your preferred audio.');
    expect(audioStreamAction(1)).toBeUndefined();
    const candidates = Array.from({ length: 12 }, (_, index) => candidate(index, index === 0 ? 10 : undefined));
    resolve({ streams: candidates, recommendedStreamId: candidates[0]!.id }); await settle();
    for (let number = 1; number <= 12; number += 1) {
      const choice = audioStreamAction(number);
      expect(choice.props.label).toBe(String(number));
      const accessible = choice.type(choice.props);
      expect(accessible.props).toMatchObject({ accessibilityRole: 'button', accessibilityLabel: `Audio stream ${number}` });
      expect(accessible.props.style[0]).toMatchObject({ minHeight: 44, minWidth: 44 });
    }
    expect(nodes().filter((node) => /^Audio:/.test(node.props?.label ?? ''))).toEqual([]);
    expect(text()).toContain('Alternate audio tracks on this video');
    expect(audioAuto().props.selected).toBe(true);
  });

  it.each([true, false])('pins an unmeasured metadata-empty stream and restores the same player, exact time, rate, and playing=%s', async (playing) => {
    const candidates = [candidate(0, 1), candidate(1)];
    await catalog(candidates, { initial: { positionSeconds: 42.75, playing } });
    const player = video().props.player;
    action('1.5x').props.onPress(); render();
    mock.player.replaceAsync.mockClear(); props.onCheckpoint.mockClear();
    audioStreamAction(2).props.onPress(); render(); await settle();
    expect(mock.player.replaceAsync).toHaveBeenCalledExactlyOnceWith({ uri: candidates[1]!.url, contentType: 'hls' });
    expect(audioAuto().props.selected).toBe(false);
    mock.player.currentTime = 0; mock.player.playbackRate = 1; mock.player.playing = false;
    await loaded();
    expect(video().props.player).toBe(player);
    expect(mock.player.currentTime).toBe(42.75);
    expect(mock.player.playbackRate).toBe(1.5);
    expect(mock.player.playing).toBe(playing);
    expect(audioStreamAction(2).props.selected).toBe(true);
    expect(action('1.5x').props.selected).toBe(true);
    expect(props.onCheckpoint).toHaveBeenCalledWith({ positionSeconds: 42.75, durationSeconds: 180, playing });
    expect(props.onError).not.toHaveBeenCalled();
  });

  it('preserves compatible manual quality using the PINNED snapshot raw rendition ID and ignores stale source readiness', async () => {
    const candidates = [candidate(0, 1, [720, 1080]), candidate(1, 100, [1080, 720])];
    await catalog(candidates, { initial: { positionSeconds: 33.125, playing: false } });
    action('1.25x').props.onPress(); render();
    action('1080p').props.onPress(); render(); await settle(); await loaded();
    mock.player.replaceAsync.mockClear();
    audioStreamAction(2).props.onPress(); render(); await settle();
    const selected = new URL(currentUrl());
    expect(selected.searchParams.get('token')).toBe('snapshot-1');
    expect(selected.searchParams.get('rendition')).toBe('1-0');
    expect(action('1080p').props.selected).toBe(true);
    emit('sourceLoad', { videoSource: { uri: candidates[0]!.url }, duration: 1, availableAudioTracks: [], availableSubtitleTracks: [] });
    emit('statusChange', { status: 'readyToPlay' });
    emit('availableAudioTracksChange', { availableAudioTracks: [] }); render();
    expect(audioStreamAction(2).props.selected).toBe(true);
    expect(audioAuto().props.selected).toBe(false);
    await loaded();
    expect(mock.player.currentTime).toBe(33.125);
    expect(mock.player.playbackRate).toBe(1.25);
    expect(mock.player.playing).toBe(false);
    expect(mock.player.replaceAsync).toHaveBeenCalledOnce();
  });

  it('reports incompatible quality explicitly, keeps the numeric pin/manual choice, and never loads a master as fallback', async () => {
    const candidates = [candidate(0, 1, [1080]), candidate(1, undefined, [720])];
    await catalog(candidates, { initial: { positionSeconds: 54.25, playing: true } });
    action('1.5x').props.onPress(); render();
    action('1080p').props.onPress(); render(); await settle(); await loaded();
    mock.player.replaceAsync.mockClear();
    audioStreamAction(2).props.onPress(); render(); await settle();
    expect(audioStreamAction(2).props.selected).toBe(true);
    expect(audioAuto().props.selected).toBe(false);
    expect(action('1080p').props.selected).toBe(true);
    expect(text()).toContain('cannot provide the selected quality');
    expect(mock.player.replaceAsync).not.toHaveBeenCalled();
    action('720p').props.onPress(); render(); await settle(); await loaded();
    expect(new URL(currentUrl()).searchParams.get('token')).toBe('snapshot-1');
    expect(new URL(currentUrl()).searchParams.get('rendition')).toBe('1-0');
    expect(mock.player).toMatchObject({ currentTime: 54.25, playbackRate: 1.5, playing: true });
    expect(audioAuto().props.selected).toBe(false);
    expect(action('720p').props.selected).toBe(true);
  });

  it('keeps a manual 4K URI on explicit error/retry and never lowers it when another numbered stream lacks 4K', async () => {
    const candidates = [candidate(0, 10, [720, 2160]), candidate(1, 1, [1080])];
    await catalog(candidates, { initial: { positionSeconds: 37.125, playing: false } });
    action('4K').props.onPress(); render(); await settle(); await loaded();
    const fixed = currentUrl(); expect(new URL(fixed).searchParams.get('rendition')).toBe('0-1');
    mock.player.status = 'error'; emit('statusChange', { status: 'error' }); render(); await settle();
    openGroup('Audio'); action('Retry').props.onPress(); render(); await settle();
    expect(currentUrl()).toBe(fixed); await loaded(); expect(action('4K').props.selected).toBe(true);
    mock.player.replaceAsync.mockClear();
    audioStreamAction(2).props.onPress(); render(); await settle();
    expect(audioStreamAction(2).props.selected).toBe(true); expect(action('4K').props.selected).toBe(true);
    expect(mock.player.replaceAsync).not.toHaveBeenCalled(); expect(text()).toContain('cannot provide the selected quality');
  });

  it('retains the exact real capability when a refreshed catalog recommends another stream or reuses the pinned ID', async () => {
    const candidates = [candidate(0, 1), candidate(1)];
    await catalog(candidates);
    audioStreamAction(2).props.onPress(); render(); await settle(); await loaded();
    mock.player.replaceAsync.mockClear();
    const replacement = { ...candidates[1]!, url: `${candidates[1]!.url}&snapshot=new`, startupLatencyMs: 0 };
    mock.streams.mockResolvedValue({ streams: [replacement, candidates[0]], recommendedStreamId: replacement.id });
    props = { ...props, source: { ...props.source, streamCatalogUrl: `${catalogUrl}&refresh=1` } };
    render(); await settle();
    emit('availableAudioTracksChange', { availableAudioTracks: [] });
    emit('availableSubtitleTracksChange', { availableSubtitleTracks: [] });
    emit('statusChange', { status: 'readyToPlay' }); render(); await settle();
    expect(mock.player.replaceAsync).not.toHaveBeenCalled();
    expect(audioAuto().props.selected).toBe(false);
    expect(text()).toContain('remains pinned');
    audioAuto().props.onPress(); render(); await settle();
    expect(mock.player.replaceAsync).toHaveBeenCalledExactlyOnceWith({ uri: replacement.url, contentType: 'hls' });
    expect(audioAuto().props.selected).toBe(true);
  });

  it('pins synchronously when a catalog recommendation resolves before the numeric action rerenders', async () => {
    const candidates = [candidate(0, 1), candidate(1)];
    await catalog(candidates);
    const retainedChoice = audioStreamAction(2);
    let resolve!: (value: unknown) => void;
    mock.streams.mockReturnValue(new Promise((done) => { resolve = done; }));
    props = { ...props, source: { ...props.source, streamCatalogUrl: `${catalogUrl}&refresh=2` } };
    render(); await settle();
    retainedChoice.props.onPress();
    const recommended = { ...candidate(0, 0), url: `${candidates[0]!.url}&new=1` };
    resolve({ streams: [recommended, candidates[1]], recommendedStreamId: recommended.id });
    await settle();
    expect(currentUrl()).toBe(candidates[1]!.url);
    expect(audioStreamAction(2).props.selected).toBe(true);
    expect(audioAuto().props.selected).toBe(false);
  });

  it('keeps genuine language tracks separate and never unpins when track availability changes or a native setter rejects', async () => {
    const candidates = [candidate(0, 1, [], 'de'), candidate(1, undefined, [], 'en')];
    await catalog(candidates);
    audioStreamAction(2).props.onPress(); render(); await settle(); await loaded();
    expect(action('Audio: de')).toBeUndefined();
    expect(action('Audio: en')).toBeUndefined();
    mock.player.replaceAsync.mockClear();
    const real = { id: 'native-en', label: 'English', language: 'eng' };
    mock.player.availableAudioTracks = [real];
    emit('availableAudioTracksChange', { availableAudioTracks: [real] }); render(); await settle();
    action('Audio: English').props.onPress(); render(); await settle();
    expect(mock.player.audioTrack).toBe(real);
    mock.player.availableAudioTracks = [];
    emit('availableAudioTracksChange', { availableAudioTracks: [] }); render(); await settle();
    expect(text()).toContain('selected language track is not available yet');
    mock.player.availableAudioTracks = [real];
    Object.defineProperty(mock.player, 'audioTrack', { configurable: true, get: () => real,
      set: () => { throw new Error('Track temporarily unavailable'); } });
    emit('availableAudioTracksChange', { availableAudioTracks: [real] }); render(); await settle();
    expect(text()).toContain('metadata track could not be applied');
    expect(audioStreamAction(2).props.selected).toBe(true);
    expect(audioAuto().props.selected).toBe(false);
    expect(mock.player.replaceAsync).not.toHaveBeenCalled();
    expect(props.onError).not.toHaveBeenCalled();
  });

  it.each(['status', 'replace'])('makes a pinned %s error recoverable without Auto, retaining the exact snapshot for explicit retry', async (failure) => {
    const candidates = [candidate(0, 1), candidate(1)];
    await catalog(candidates, { initial: { positionSeconds: 61.875, playing: false } });
    action('1.5x').props.onPress(); render();
    if (failure === 'replace') mock.player.replaceAsync.mockRejectedValueOnce(new Error('Unavailable stream'));
    audioStreamAction(2).props.onPress(); render(); await settle();
    if (failure === 'status') { mock.player.status = 'error'; emit('statusChange', { status: 'error' }); render(); await settle(); }
    expect(props.onError).toHaveBeenLastCalledWith(candidates[1]);
    expect(audioStreamAction(2).props.selected).toBe(true);
    expect(audioAuto().props.selected).toBe(false);
    expect(text()).toContain('It remains selected');
    expect(action('Retry selected audio stream')).toBeDefined();
    mock.player.replaceAsync.mockClear();
    action('Retry selected audio stream').props.onPress(); render(); await settle();
    expect(mock.player.replaceAsync).toHaveBeenCalledExactlyOnceWith({ uri: candidates[1]!.url, contentType: 'hls' });
    await loaded();
    expect(mock.player).toMatchObject({ currentTime: 61.875, playbackRate: 1.5, playing: false });
    expect(audioStreamAction(2).props.selected).toBe(true);
    expect(audioAuto().props.selected).toBe(false);
    expect(action('Retry selected audio stream')).toBeUndefined();
    expect(text()).not.toContain('could not be played');
  });

  it('does not alter the local numbered choice or quality pin when Quality Auto is explicitly chosen', async () => {
    const candidates = [candidate(0, 1, [1080]), candidate(1, undefined, [1080])];
    await catalog(candidates);
    audioStreamAction(2).props.onPress(); render(); await settle(); await loaded();
    action('1080p').props.onPress(); render(); await settle(); await loaded();
    mock.player.replaceAsync.mockClear();
    action('Auto').props.onPress(); render(); await settle(); await loaded();
    expect(mock.player.replaceAsync).toHaveBeenCalledExactlyOnceWith({ uri: candidates[1]!.url, contentType: 'hls' });
    expect(audioStreamAction(2).props.selected).toBe(true);
    expect(audioAuto().props.selected).toBe(false);
  });

  it('guards retained numeric/Auto actions during PiP without replacing or unpinning content', async () => {
    const candidates = [candidate(0, 1), candidate(1)];
    await catalog(candidates);
    audioStreamAction(2).props.onPress(); render(); await settle(); await loaded();
    const retainedChoice = audioStreamAction(1); const retainedAuto = audioAuto();
    mock.player.replaceAsync.mockClear();
    action('Picture in picture').props.onPress();
    retainedChoice.props.onPress(); retainedAuto.props.onPress();
    video().props.onPictureInPictureStart(); render();
    retainedChoice.props.onPress(); retainedAuto.props.onPress();
    expect(mock.player.replaceAsync).not.toHaveBeenCalled();
    video().props.onPictureInPictureStop(); render();
    action('Settings').props.onPress(); render();
    expect(audioStreamAction(2).props.selected).toBe(true);
    expect(audioAuto().props.selected).toBe(false);
  });

  it('preserves WatchParty member transport locks while local audio selection and remote correction retain the pin', async () => {
    const media = { kind: 'movie', mediaId: '00000000-0000-4000-8000-000000000001' };
    const register = vi.fn();
    const playback = { media, mode: 'playing', positionSeconds: 12.5, playbackRate: 1.25,
      revision: 1, anchorServerTimeMs: 1000 };
    await catalog([candidate(0, 1), candidate(1)], { partyMedia: media, partyConnected: true,
      partyRole: 'member', partyPlayback: playback, registerPartyPlayerPort: register });
    action('Close settings').props.onPress(); render();
    expect(action('Back 10 seconds').props.disabled).toBe(true);
    action('Settings').props.onPress(); render();
    expect(action('1.5x').props.disabled).toBe(true);
    const port = register.mock.calls.at(-1)![0];
    audioStreamAction(2).props.onPress(); render(); await settle(); await loaded();
    expect(port.read().ready).toBe(true);
    port.apply({ playback, mode: 'playing', positionSeconds: 55.125, seek: true, playbackRate: 1.26 });
    render(); await settle();
    expect(mock.player).toMatchObject({ currentTime: 55.125, playbackRate: 1.26, playing: true });
    expect(audioStreamAction(2).props.selected).toBe(true);
    expect(audioAuto().props.selected).toBe(false);
    action('Close settings').props.onPress(); render();
    expect(action('Forward 10 seconds').props.disabled).toBe(true);
  });
});
