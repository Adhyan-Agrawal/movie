import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IntroMarker } from '../../mobile/src/lib/types';

// JS hooks/events only: native decoding, touch delivery and hardware layout remain untested here.
const mock = vi.hoisted(() => {
  const listeners = new Map<string, Set<(event: any) => void>>();
  const player = { currentTime: 0, duration: 180, playing: false, status: 'readyToPlay', playbackRate: 1.25,
    volume: 1, muted: false, availableAudioTracks: [], availableSubtitleTracks: [],
    play: vi.fn(), pause: vi.fn(), replaceAsync: vi.fn(), addListener: vi.fn((event: string, callback: (value: any) => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(callback);
      return { remove: () => listeners.get(event)?.delete(callback) };
    }) };
  return { player, listeners, states: [] as any[], refs: [] as any[],
    effects: [] as Array<{ deps?: unknown[]; cleanup?: () => void }>, jobs: [] as Array<() => void>,
    stateIndex: 0, refIndex: 0, effectIndex: 0, dirty: false, initialized: false,
    dimensions: { width: 400, height: 800 }, insets: { top: 24, bottom: 16, left: 0, right: 0 },
    app: { currentState: 'active', addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
    getItem: vi.fn(), setItem: vi.fn(), fetch: vi.fn(), intro: vi.fn(), bridge: vi.fn(), vast: vi.fn(),
    subtitles: vi.fn(), streams: vi.fn(), resetObservation: vi.fn(), adDue: false, orientation: vi.fn(),
    route: { params: { titleId: 'show', type: 'tv', slug: 'show', name: 'Show', tmdbId: '123', season: 1, episode: 1 } } as any,
  };
});

vi.mock('../../mobile/node_modules/react', async (original) => ({ ...await original<typeof import('react')>(),
  useState: (initial: unknown) => {
    const index = mock.stateIndex++;
    if (!(index in mock.states)) mock.states[index] = typeof initial === 'function' ? initial() : initial;
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
    if (!prior || !deps || !prior.deps || deps.some((value, i) => !Object.is(value, prior.deps![i]))) {
      const slot = { deps, cleanup: prior?.cleanup }; mock.effects[index] = slot;
      mock.jobs.push(() => { slot.cleanup?.(); slot.cleanup = effect() || undefined; });
    }
  },
}));
vi.mock('../../mobile/node_modules/react-native', () => ({ AppState: mock.app,
  BackHandler: { addEventListener: () => ({ remove: vi.fn() }) },
  Pressable: 'Pressable', ScrollView: 'ScrollView', Text: 'Text', View: 'View', useWindowDimensions: () => mock.dimensions,
  StyleSheet: { create: (value: unknown) => value, absoluteFill: {} },
}));
vi.mock('../../mobile/node_modules/react-native-safe-area-context', () => ({ useSafeAreaInsets: () => mock.insets }));
vi.mock('../../mobile/node_modules/expo-status-bar', () => ({ StatusBar: 'StatusBar' }));
vi.mock('../../mobile/node_modules/react-native-webview', () => ({ WebView: 'WebView' }));
vi.mock('../../mobile/node_modules/expo-screen-orientation', () => ({ OrientationLock: { DEFAULT: 0, LANDSCAPE: 5 } }));
vi.mock('../../mobile/src/player/orientation', () => ({ acquireOrientation: mock.orientation }));
vi.mock('../../mobile/node_modules/@react-native-async-storage/async-storage', () => ({ default: { getItem: mock.getItem, setItem: mock.setItem } }));
vi.mock('../../mobile/node_modules/expo-video', () => ({ VideoView: 'VideoView', useVideoPlayer: (_source: unknown, setup: (player: typeof mock.player) => void) => {
  if (!mock.initialized) { mock.initialized = true; setup(mock.player); }
  return mock.player;
} }));
vi.mock('../../mobile/src/player/VastAdBreak', () => ({ default: 'NativeVastAd' }));
vi.mock('../../mobile/src/player/policy', async (original) => ({ ...await original<typeof import('../../mobile/src/player/policy')>(),
  createNativeAdSchedule: () => ({ sample: () => mock.adDue, resetObservation: mock.resetObservation, finish: vi.fn() }),
}));
vi.mock('../../mobile/src/lib/api', () => ({
  fetchIntroCatalog: mock.intro, resolvePlaybackDetails: mock.bridge, fetchVastCreative: mock.vast,
  fetchSubtitleCatalog: mock.subtitles, fetchStreamCatalog: mock.streams,
  sameOriginPlaybackUrl: (url: string) => new URL(url, 'https://hulkofyt.eu.org').href,
  getPlaybackContext: async () => ({ viewerKey: 'guest', resume: null }), listSeasons: async () => [],
  recordPlaybackSession: vi.fn(), reportProgress: vi.fn(),
}));
vi.mock('../../mobile/src/lib/guest', () => ({ getGuestResume: async () => null, recordGuestWatch: vi.fn(), updateGuestPosition: vi.fn() }));
vi.mock('../../mobile/src/components/ui', () => ({ Button: 'Button' }));
vi.mock('../../mobile/node_modules/@react-navigation/native', () => ({ useRoute: () => mock.route,
  useNavigation: () => ({ canGoBack: () => true, goBack: vi.fn(), navigate: vi.fn(), replace: vi.fn() }),
}));

// Avoid pulling native JSX into the web TypeScript project's different React type universe.
const nativePath = '../../mobile/src/player/NativePlayer';
const screenPath = '../../mobile/src/screens/PlayerScreen';
const { default: NativePlayer, canSkipIntro } = await import(nativePath);
const { default: PlayerScreen } = await import(screenPath);
import { mediaKey, readCheckpoint, writeCheckpoint } from '../../mobile/src/player/checkpoint';

const source = { id: 'direct', label: 'Direct', kind: 'hls', consentRequired: false, url: 'https://hulkofyt.eu.org/api/vidnest?token=fixture' };
const marker = { startSeconds: 0, endSeconds: 55.125 };
const introUrl = 'https://hulkofyt.eu.org/api/intro?episode=1';
const emit = (event: string, value: unknown) => mock.listeners.get(event)?.forEach((listener) => listener(value));
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; };
let component: any;
let props: any;
let tree: any;

function render(commit = true) {
  mock.stateIndex = 0; mock.refIndex = 0; mock.effectIndex = 0; mock.dirty = false;
  tree = component(props);
  if (commit) while (mock.jobs.length) mock.jobs.shift()!();
  return tree;
}
async function settle() {
  await vi.advanceTimersByTimeAsync(0);
  for (let i = 0; mock.dirty && i < 10; i++) { render(); await vi.advanceTimersByTimeAsync(0); }
}
function nodes(value: any = tree): any[] {
  function walk(node: any): any[] {
    if (Array.isArray(node)) return node.flatMap(walk);
    return node && typeof node === 'object' ? [node, ...walk(node.props?.children)] : [];
  }
  return walk(value);
}
const action = (label: string) => nodes().find((node) => node.props?.label === label);
function tick(position: number) { mock.player.currentTime = position; emit('timeUpdate', { currentTime: position }); render(); }
async function mountNative(overrides: any = {}) {
  component = NativePlayer;
  props = { source, intro: marker, initial: { positionSeconds: 0, playing: true }, header: 'Header', footer: 'Footer',
    onCheckpoint: vi.fn(), onError: vi.fn(), ...overrides };
  render(); await settle();
  mock.player.status = 'readyToPlay';
  emit('sourceLoad', { videoSource: { uri: source.url }, duration: mock.player.duration, availableAudioTracks: [], availableSubtitleTracks: [] });
  emit('statusChange', { status: 'readyToPlay' }); render();
}
async function mountScreen() { component = PlayerScreen; props = undefined; render(); await settle(); }

beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  mock.states.length = 0; mock.refs.length = 0; mock.effects.length = 0; mock.jobs.length = 0;
  mock.listeners.clear(); mock.initialized = false; mock.adDue = false; mock.app.currentState = 'active';
  Object.defineProperty(mock.player, 'currentTime', { configurable: true, writable: true, value: 0 });
  mock.player.duration = 180; mock.player.playing = false; mock.player.status = 'readyToPlay'; mock.player.playbackRate = 1.25;
  mock.dimensions = { width: 400, height: 800 }; mock.insets = { top: 24, bottom: 16, left: 0, right: 0 };
  mock.player.play.mockImplementation(() => { mock.player.playing = true; });
  mock.player.pause.mockImplementation(() => { mock.player.playing = false; });
  mock.player.replaceAsync.mockResolvedValue(undefined);
  mock.getItem.mockResolvedValue(null); mock.setItem.mockResolvedValue(undefined); mock.orientation.mockReturnValue(vi.fn());
  mock.streams.mockResolvedValue({ streams: [] }); mock.subtitles.mockResolvedValue([]); mock.intro.mockResolvedValue(null);
  mock.vast.mockResolvedValue(null); mock.bridge.mockResolvedValue({ sources: [source], introCatalogUrl: introUrl });
  mock.route = { params: { titleId: 'show', type: 'tv', slug: 'show', name: 'Show', tmdbId: '123', season: 1, episode: 1 } };
  mock.fetch.mockResolvedValue(new Response('WEBVTT\n\n00:00:00.000 --> 00:01:00.000\nCaption\n'));
  vi.stubGlobal('fetch', mock.fetch);
});
afterEach(() => {
  mock.effects.forEach((effect) => effect.cleanup?.());
  vi.useRealTimers(); vi.unstubAllGlobals();
});

describe('Android intro interval predicate', () => {
  it.each([[-0.01, false], [0, true], [0.25, true], [40, true], [55.124, true], [55.125, false], [80, false]])
  ('uses inclusive start/exclusive end at position %s', (position, visible) => {
    expect(canSkipIntro(marker, position, 180)).toBe(visible);
  });
  it.each([0, -1, NaN, Infinity, 55])('requires a finite known duration that proves the target valid: %s', (duration) => {
    expect(canSkipIntro(marker, 0, duration)).toBe(false);
  });
  it('accepts an exact-duration endpoint and ignores missing or invalid markers/position', () => {
    expect(canSkipIntro(marker, 1, marker.endSeconds)).toBe(true);
    expect(canSkipIntro(null, 1, 180)).toBe(false);
    expect(canSkipIntro({ startSeconds: 1, endSeconds: 1 }, 1, 180)).toBe(false);
    expect(canSkipIntro(marker, NaN, 180)).toBe(false);
    expect(canSkipIntro(marker, 1, 180, true)).toBe(false);
  });
});

describe('Android Skip intro content player action', () => {
  it('accepts late intro metadata without replacing the content player/source or changing play state', async () => {
    await mountNative({ intro: null }); expect(action('Skip intro')).toBeUndefined();
    const player = nodes().find((node) => node.type === 'VideoView').props.player;
    const playing = mock.player.playing; const rate = mock.player.playbackRate;
    props = { ...props, intro: marker }; render();
    expect(action('Skip intro')).toBeDefined();
    expect(nodes().find((node) => node.type === 'VideoView').props.player).toBe(player);
    expect(mock.player.replaceAsync).toHaveBeenCalledExactlyOnceWith({ uri: source.url, contentType: 'hls' });
    expect(mock.player.playing).toBe(playing); expect(mock.player.playbackRate).toBe(rate);
  });

  it('uses live content position, re-shows on rewind/resume, and allows paused playback', async () => {
    await mountNative({ intro: { startSeconds: 10, endSeconds: 55.125 }, initial: { positionSeconds: 30, playing: false } });
    expect(action('Skip intro')).toBeDefined();
    expect(mock.player.playing).toBe(false);
    tick(9.999); expect(action('Skip intro')).toBeUndefined();
    tick(10); expect(action('Skip intro')).toBeDefined();
    tick(55.125); expect(action('Skip intro')).toBeUndefined();
    tick(20); expect(action('Skip intro')).toBeDefined();
  });

  it('seeks once to the fractional endpoint and immediately checkpoints exact episode content state without replacing the URI', async () => {
    const key = mediaKey({ titleId: 'intro-show', type: 'tv', season: 2, episode: 3 });
    const onCheckpoint = vi.fn((snapshot) => writeCheckpoint('guest', key, snapshot.positionSeconds, snapshot.durationSeconds, snapshot.playing));
    await mountNative({ initial: { positionSeconds: 5.25, playing: false }, onCheckpoint,
      adPolicy: { enabled: true, firstBreakSeconds: 60, intervalSeconds: 60, maxBreaks: 1, allowSkip: true, skipAfterSeconds: 5 } });
    action('Settings').props.onPress(); render(); action('1.25x').props.onPress(); render();
    action('Close settings').props.onPress(); render();
    const skip = action('Skip intro'); const resets = mock.resetObservation.mock.calls.length;
    skip.props.onPress(); skip.props.onPress();
    expect(mock.player.currentTime).toBe(marker.endSeconds);
    expect(mock.player.playing).toBe(false); expect(mock.player.playbackRate).toBe(1.25);
    expect(mock.player.replaceAsync).toHaveBeenCalledExactlyOnceWith({ uri: source.url, contentType: 'hls' });
    expect(onCheckpoint).toHaveBeenCalledExactlyOnceWith({ positionSeconds: marker.endSeconds, durationSeconds: 180, playing: false });
    expect((await readCheckpoint('guest', key))?.positionSeconds).toBe(marker.endSeconds);
    expect(await readCheckpoint('guest', mediaKey({ titleId: 'intro-show', type: 'tv', season: 2, episode: 4 }))).toBeNull();
    expect(mock.resetObservation.mock.calls.length).toBe(resets + 1);
    render(); expect(action('Skip intro')).toBeUndefined();
    tick(marker.endSeconds); expect(action('Skip intro')).toBeUndefined();
    tick(10); expect(action('Skip intro')).toBeDefined();
  });

  it('locks repeated taps until native position acknowledges the seek, then re-shows on rewind', async () => {
    await mountNative();
    const assign = vi.fn();
    let nativePosition = 0;
    Object.defineProperty(mock.player, 'currentTime', { configurable: true, get: () => nativePosition, set: assign });
    const skip = action('Skip intro'); skip.props.onPress(); skip.props.onPress();
    expect(assign).toHaveBeenCalledExactlyOnceWith(marker.endSeconds);
    render(); expect(action('Skip intro')).toBeUndefined();
    await vi.advanceTimersByTimeAsync(5000); render();
    expect(action('Skip intro')).toBeUndefined(); skip.props.onPress(); expect(assign).toHaveBeenCalledOnce();
    nativePosition = marker.endSeconds; emit('timeUpdate', { currentTime: nativePosition }); render();
    expect(action('Skip intro')).toBeUndefined();
    nativePosition = 10; emit('timeUpdate', { currentTime: nativePosition }); render();
    expect(action('Skip intro')).toBeDefined();
  });

  it('never uses saved checkpoint duration as proof, nor shows or acts during source replacement', async () => {
    mock.player.duration = 0;
    await mountNative({ initial: { positionSeconds: 0, durationSeconds: 180, playing: true } });
    expect(action('Skip intro')).toBeUndefined();
    mock.player.duration = 180; tick(1);
    const oldSkip = action('Skip intro'); expect(oldSkip).toBeDefined();
    props = { ...props, source: { ...source, url: `${source.url}&fallback=1` } }; render();
    const position = mock.player.currentTime;
    oldSkip.props.onPress(); expect(mock.player.currentTime).toBe(position);
    render(); expect(action('Skip intro')).toBeUndefined();
  });

  it('hides and guards a retained button during both VAST loading and active advertising', async () => {
    mock.getItem.mockResolvedValue('true');
    const ad = deferred<any>(); mock.vast.mockReturnValue(ad.promise);
    await mountNative({ intro: { startSeconds: 0, endSeconds: 120 }, adPolicy: {
      enabled: true, firstBreakSeconds: 60, intervalSeconds: 60, maxBreaks: 1, allowSkip: true, skipAfterSeconds: 5,
    } });
    const oldSkip = action('Skip intro'); mock.adDue = true; tick(1); await settle();
    expect(mock.vast).toHaveBeenCalledOnce(); expect(action('Skip intro')).toBeUndefined();
    oldSkip.props.onPress(); expect(mock.player.currentTime).toBe(1);
    ad.resolve({ id: 'ad', mediaUrl: 'https://ads.example/ad.mp4', durationSeconds: 30, skipAfterSeconds: 5, tracking: {} });
    await settle(); expect(nodes().some((node) => node.type === 'NativeVastAd')).toBe(true);
    expect(action('Skip intro')).toBeUndefined(); oldSkip.props.onPress(); expect(mock.player.currentTime).toBe(1);
    nodes().find((node) => node.type === 'NativeVastAd').props.onDone(); render();
    expect(action('Skip intro')).toBeDefined();
  });

  it('keeps the accessible 44px action when chrome is hidden and retains one fullscreen VideoView', async () => {
    await mountNative(); action('Fullscreen').props.onPress(); render();
    expect(mock.orientation).toHaveBeenLastCalledWith(5, expect.any(Function));
    mock.insets = { top: 0, bottom: 12, left: 30, right: 30 }; mock.dimensions = { width: 1000, height: 600 };
    render();
    const plane = nodes().find((node) => node.props?.onTouchEnd);
    plane.props.onTouchStart({ nativeEvent: { pageX: 500, pageY: 250 } });
    plane.props.onTouchEnd({ nativeEvent: { pageX: 500, pageY: 250, locationX: 500 } }); render();
    const skip = action('Skip intro'); expect(skip).toBeDefined();
    const accessible = skip.type(skip.props);
    expect(accessible.props).toMatchObject({ accessibilityRole: 'button', accessibilityLabel: 'Skip intro' });
    expect(accessible.props.style[0]).toMatchObject({ minHeight: 44, minWidth: 44 });
    expect(nodes().filter((node) => node.type === 'VideoView')).toHaveLength(1);
    expect(action('Show controls')).toBeDefined();
    const layer = nodes().find((node) => Array.isArray(node.props?.style) && node.props.style[0]?.gap === 12 && node.props.style[0]?.position === 'absolute');
    expect(layer.props.style[1]).toMatchObject({ bottom: 40, left: 50, right: 50 });
  });

  it('keeps the skip row separate from VTT captions and above the measured footer', async () => {
    mock.subtitles.mockResolvedValue([{ id: 'en', label: 'English', language: 'en', url: '/api/subtitles?token=fixture' }]);
    await mountNative({ subtitleCatalogUrl: '/api/subtitles?catalog=fixture' }); await settle();
    action('Settings').props.onPress(); render(); action('Subtitles: English').props.onPress(); render(); await settle();
    action('Close settings').props.onPress(); render();
    const layer = nodes().find((node) => node.props?.children?.[0]?.props?.style?.alignSelf === 'flex-end');
    expect(layer.props.children[0].props.children.props.label).toBe('Skip intro');
    expect(layer.props.children[1].props.children.props.children).toBe('Caption');
    expect(layer.props.style[1].bottom).toBe(202);
    const footer = nodes().find((node) => node.props?.style?.[0]?.backgroundColor === 'rgba(0,0,0,0.78)');
    footer.props.onLayout({ nativeEvent: { layout: { height: 240 } } }); render();
    const updated = nodes().find((node) => node.props?.children?.[0]?.props?.style?.alignSelf === 'flex-end');
    expect(updated.props.style[1].bottom).toBe(252);
  });

  it('ignores a retained button after marker reset or component cleanup', async () => {
    await mountNative(); const oldSkip = action('Skip intro');
    props = { ...props, intro: null }; render(); oldSkip.props.onPress();
    expect(mock.player.currentTime).toBe(0); expect(action('Skip intro')).toBeUndefined();
    mock.effects.forEach((effect) => effect.cleanup?.()); oldSkip.props.onPress();
    expect(mock.player.currentTime).toBe(0);
  });
});

describe('Android lazy intro lookup episode/URL lifecycle', () => {
  it('shows a ready local source without waiting for intro metadata; null leaves playback intact', async () => {
    const lookup = deferred<IntroMarker | null>(); mock.intro.mockReturnValue(lookup.promise);
    await mountScreen(); expect(tree.type).toBe(NativePlayer); expect(tree.props.intro).toBeNull();
    expect(mock.intro).toHaveBeenCalledExactlyOnceWith(introUrl, expect.any(AbortSignal));
    lookup.resolve(null); await settle(); expect(tree.type).toBe(NativePlayer); expect(tree.props.intro).toBeNull();
  });

  it.each([introUrl, 'https://hulkofyt.eu.org/api/intro?episode=2'])('resets immediately on episode change and ignores old results for URL %s', async (nextUrl) => {
    const old = deferred<IntroMarker | null>(); const next = deferred<IntroMarker | null>();
    mock.intro.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    await mountScreen(); const oldSignal = mock.intro.mock.calls[0]![1];
    mock.route = { params: { ...mock.route.params, episode: 2 } };
    mock.bridge.mockResolvedValue({ sources: [source], introCatalogUrl: nextUrl });
    render(false); expect(tree.props.intro).toBeNull();
    while (mock.jobs.length) mock.jobs.shift()!(); await settle();
    expect(oldSignal.aborted).toBe(true);
    next.resolve({ startSeconds: 10, endSeconds: 30 }); await settle();
    expect(tree.props.intro).toEqual({ startSeconds: 10, endSeconds: 30 });
    old.resolve(marker); await settle(); expect(tree.props.intro).toEqual({ startSeconds: 10, endSeconds: 30 });
  });

  it('resets an already shown marker synchronously for a new episode', async () => {
    mock.intro.mockResolvedValue(marker); await mountScreen(); expect(tree.props.intro).toEqual(marker);
    mock.route = { params: { ...mock.route.params, episode: 2 } };
    render(false); expect(tree.props.intro).toBeNull();
  });

  it('rejects a stale old URL response after retrying the same episode', async () => {
    const old = deferred<IntroMarker | null>(); const next = deferred<IntroMarker | null>();
    mock.intro.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    await mountScreen(); tree.props.onError(); render(); action('Retry').props.onPress();
    mock.bridge.mockResolvedValue({ sources: [source], introCatalogUrl: `${introUrl}&retry=1` });
    render(); await settle(); next.resolve({ startSeconds: 2, endSeconds: 20 }); await settle();
    expect(tree.props.intro).toEqual({ startSeconds: 2, endSeconds: 20 });
    old.resolve(marker); await settle(); expect(tree.props.intro).toEqual({ startSeconds: 2, endSeconds: 20 });
  });
});
