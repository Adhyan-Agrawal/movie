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
    context: vi.fn(), episodes: vi.fn(), replace: vi.fn(), guestWatch: vi.fn(), guestPosition: vi.fn(),
    route: { params: { titleId: 'show', type: 'tv', slug: 'show', name: 'Show', tmdbId: '123', season: 1, episode: 1 } } as any,
    partyServiceAvailable: false,
    party: { state: { phase: 'idle', participants: [], self: null, room: null, playback: null },
      registerPlayerPort: vi.fn(), notifySourceChange: vi.fn() },
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
  Platform: { OS: 'android', Version: 35 },
  Pressable: 'Pressable', ScrollView: 'ScrollView', Text: 'Text', View: 'View', useWindowDimensions: () => mock.dimensions,
  ActivityIndicator: 'ActivityIndicator', Animated: { View: 'AnimatedView', Value: class { interpolate() { return 0; } },
    timing: () => ({ start: vi.fn(), stop: vi.fn() }) },
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
vi.mock('../../mobile/src/watch-party/WatchPartySheet', () => ({ default: 'WatchPartySheet' }));
vi.mock('../../mobile/src/watch-party/useWatchPartySession', () => ({ useWatchPartySession: () => mock.party }));
vi.mock('../../mobile/src/watch-party/config', () => ({
  get WATCH_PARTY_SERVICE_AVAILABLE() { return mock.partyServiceAvailable; },
}));
vi.mock('../../mobile/src/player/policy', async (original) => ({ ...await original<typeof import('../../mobile/src/player/policy')>(),
  createNativeAdSchedule: () => ({ sample: () => mock.adDue, resetObservation: mock.resetObservation, finish: vi.fn() }),
}));
vi.mock('../../mobile/src/lib/api', () => ({
  fetchIntroCatalog: mock.intro, resolvePlaybackDetails: mock.bridge, fetchVastCreative: mock.vast,
  fetchSubtitleCatalog: mock.subtitles, fetchStreamCatalog: mock.streams,
  fetchEpisodeNavigation: mock.episodes, PLAYBACK_CONTEXT_TIMEOUT_MS: 1500,
  sameOriginPlaybackUrl: (url: unknown) => typeof url === 'string' ? new URL(url, 'https://hulkofyt.eu.org').href : null,
  getPlaybackContext: mock.context,
  withPlaybackDeadline: async (operation: (signal: AbortSignal) => unknown, timeoutMs: number, signal?: AbortSignal) => {
    const controller = new AbortController(); const abort = () => controller.abort();
    signal?.addEventListener('abort', abort);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([Promise.resolve().then(() => operation(controller.signal)), new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('timed out')); }, timeoutMs);
      })]);
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  },
  recordPlaybackSession: vi.fn(), reportProgress: vi.fn(),
}));
vi.mock('../../mobile/src/lib/guest', () => ({ getGuestResume: async () => null, recordGuestWatch: mock.guestWatch, updateGuestPosition: mock.guestPosition }));
vi.mock('../../mobile/src/components/ui', () => ({ Button: 'Button' }));
vi.mock('../../mobile/node_modules/@react-navigation/native', () => ({ useRoute: () => mock.route,
  useNavigation: () => ({ canGoBack: () => true, goBack: vi.fn(), navigate: vi.fn(), replace: mock.replace }),
}));

// Avoid pulling native JSX into the web TypeScript project's different React type universe.
const nativePath = '../../mobile/src/player/NativePlayer';
const screenPath = '../../mobile/src/screens/PlayerScreen';
const { default: NativePlayer, canSkipIntro } = await import(nativePath);
const { default: PlayerScreen, AUTO_NEXT_KEY } = await import(screenPath);
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
const rawAction = (label: string) => nodes().find((node) => node.props?.label === label);
function action(label: string) {
  const group = /^[\d.]+x$/.test(label) ? 'Speed' : label.startsWith('Subtitles:') ? 'Subtitles' : null;
  if (group) {
    const heading = nodes().find((node) => node.props?.label === group && typeof node.props.expanded === 'boolean');
    if (heading && !heading.props.expanded) { heading.props.onPress(); render(); }
  }
  return rawAction(label);
}
const nativeSurface = () => nodes().find((node) => node.type === NativePlayer);
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
  mock.streams.mockReset().mockResolvedValue({ streams: [] }); mock.subtitles.mockReset().mockResolvedValue([]); mock.intro.mockResolvedValue(null);
  mock.vast.mockResolvedValue(null); mock.bridge.mockResolvedValue({ sources: [source], introCatalogUrl: introUrl });
  mock.context.mockResolvedValue({ viewerKey: 'guest', resume: null }); mock.episodes.mockResolvedValue({ previous: null, next: null });
  mock.partyServiceAvailable = false;
  mock.party.state = { phase: 'idle', participants: [], self: null, room: null, playback: null };
  mock.route = { params: { titleId: 'show', type: 'tv', slug: 'show', name: 'Show', tmdbId: '123', season: 1, episode: 1 } };
  mock.fetch.mockResolvedValue(new Response('WEBVTT\n\n00:00:00.000 --> 00:01:00.000\nCaption\n'));
  vi.stubGlobal('fetch', mock.fetch);
});
afterEach(() => {
  mock.effects.forEach((effect) => effect.cleanup?.());
  vi.useRealTimers(); vi.unstubAllGlobals();
});

describe('Android public startup and verified episode screen contract', () => {
  const url = (episode = 1, tmdbId = '123') => `https://hulkofyt.eu.org/api/episode-navigation?type=tv&tmdbId=${tmdbId}&season=1&episode=${episode}`;
  const target = (seasonNumber: number, episodeNumber: number) => ({ seasonNumber, episodeNumber, name: `Episode ${episodeNumber}`,
    href: `/watch/tv/show?season=${seasonNumber}&episode=${episodeNumber}` });
  it('starts the bridge before optional identity settles, bounds that wait, and does not write guest data for unavailable identity', async () => {
    mock.context.mockReturnValue(new Promise(() => {}));
    await mountScreen(); expect(mock.bridge).toHaveBeenCalledOnce(); expect(nativeSurface()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1501); await settle();
    expect(nativeSurface()).toBeDefined();
    nativeSurface().props.onCheckpoint({ positionSeconds: 25, durationSeconds: 180, playing: true });
    await settle();
    expect(mock.guestWatch).not.toHaveBeenCalled(); expect(mock.guestPosition).not.toHaveBeenCalled();
    expect(mock.setItem.mock.calls.some(([key]) => String(key).includes(':checkpoint:guest:'))).toBe(false);
  });
  it('keeps VAST policy disabled for unavailable identity even if the public response claims resolved free entitlements', async () => {
    const policy = { enabled: true, firstBreakSeconds: 60, intervalSeconds: 60, maxBreaks: 1, allowSkip: true, skipAfterSeconds: 5 };
    mock.context.mockResolvedValue({ viewerKey: 'unavailable', resume: null });
    mock.bridge.mockResolvedValue({ sources: [source], entitlements: { resolved: true, adFree: false }, adPolicy: policy });
    await mountScreen(); expect(nativeSurface().props.adPolicy).toBeUndefined();
  });
  it('does not delay video for neighbors and never uses guessed nextSeason/nextEpisode route hints', async () => {
    mock.route.params = { ...mock.route.params, nextSeason: 9, nextEpisode: 99, nextEpisodeName: 'Unverified' };
    await mountScreen();
    expect(nativeSurface().props.episodes).toMatchObject({ previous: null, next: null, autoNext: false });
    expect(mock.episodes).not.toHaveBeenCalled();
    const lookup = deferred<any>(); mock.episodes.mockReturnValue(lookup.promise);
    mock.bridge.mockResolvedValue({ sources: [source], episodeNavigationUrl: url() });
    mock.route.params = { ...mock.route.params, episode: 2 }; mock.bridge.mockResolvedValue({ sources: [source], episodeNavigationUrl: url(2) });
    render(); await settle();
    expect(nativeSurface()).toBeDefined(); expect(nativeSurface().props.episodes.loading).toBe(true);
    lookup.resolve({ previous: target(1, 1), next: target(2, 1) }); await settle();
    const next = nativeSurface().props.episodes.next;
    next.onPress(); next.onPress();
    expect(mock.replace).toHaveBeenCalledExactlyOnceWith('Player', expect.objectContaining({ season: 2, episode: 1, episodeName: 'Episode 1', slug: 'show' }));
    expect(mock.replace.mock.calls[0]![1]).not.toHaveProperty('episodeId');
  });
  it('defaults Auto Next OFF, restores only a real true preference, and lets a user action win a late preference read', async () => {
    const stored = deferred<string | null>();
    mock.getItem.mockImplementation((key: string) => key === AUTO_NEXT_KEY ? stored.promise : Promise.resolve(null));
    mock.bridge.mockResolvedValue({ sources: [source], episodeNavigationUrl: url() });
    mock.episodes.mockResolvedValue({ previous: null, next: target(1, 2) });
    await mountScreen(); expect(nativeSurface().props.episodes.autoNext).toBe(false);
    nativeSurface().props.episodes.onAutoNextChange(true); render(); await settle();
    expect(mock.setItem).toHaveBeenCalledWith(AUTO_NEXT_KEY, 'true');
    stored.resolve('false'); await settle(); expect(nativeSurface().props.episodes.autoNext).toBe(true);
    nativeSurface().props.episodes.onAutoNextChange(false); render(); await settle();
    expect(mock.setItem).toHaveBeenLastCalledWith(AUTO_NEXT_KEY, 'false');
  });
  it.each(['missing', 'empty', 'loading', 'error'])('ignores Auto Next changes with %s episode neighbors', async (status) => {
    if (status !== 'missing') mock.bridge.mockResolvedValue({ sources: [source], episodeNavigationUrl: url() });
    if (status === 'loading') mock.episodes.mockReturnValue(new Promise(() => {}));
    if (status === 'error') mock.episodes.mockRejectedValue(new Error('unavailable'));
    await mountScreen();
    expect(mock.episodes).toHaveBeenCalledTimes(status === 'missing' ? 0 : 1);
    expect(nativeSurface().props.episodes.next).toBeNull();
    expect(nativeSurface().props.episodes.loading).toBe(status === 'loading');
    if (status === 'error') expect(nativeSurface().props.episodes.onRetry).toEqual(expect.any(Function));
    nativeSurface().props.episodes.onAutoNextChange(true); render(); await settle();
    expect(nativeSurface().props.episodes.autoNext).toBe(false);
    expect(mock.setItem).not.toHaveBeenCalled();
  });
  it.each(['true', 'false', 'not-a-boolean'])('restores persisted Auto Next %s safely', async (stored) => {
    mock.getItem.mockImplementation(async (key: string) => key === AUTO_NEXT_KEY ? stored : null);
    await mountScreen(); expect(nativeSurface().props.episodes.autoNext).toBe(stored === 'true');
  });
  it.each(['host', 'member', 'connecting'])('disables manual episode changes and Auto Next changes for party %s without local desync', async (role) => {
    mock.partyServiceAvailable = true;
    mock.bridge.mockResolvedValue({ sources: [source], episodeNavigationUrl: url() });
    mock.episodes.mockResolvedValue({ previous: null, next: target(1, 2) });
    await mountScreen(); const retained = nativeSurface().props.episodes.next;
    mock.party.state = { phase: role === 'connecting' ? 'connecting' : 'connected', participants: [], self: { id: 'self' },
      room: role === 'connecting' ? null : { hostId: role === 'host' ? 'self' : 'other' }, playback: null } as any;
    render();
    expect(nativeSurface().props.episodes.blocked).toBe(true);
    retained.onPress(); nativeSurface().props.episodes.onAutoNextChange(true); render(); await settle();
    expect(mock.replace).not.toHaveBeenCalled(); expect(nativeSurface().props.episodes.autoNext).toBe(false);
    expect(mock.setItem).not.toHaveBeenCalled();
  });
  it('keeps local episode controls usable when the party service is disabled despite a stale party session', async () => {
    mock.partyServiceAvailable = false;
    mock.bridge.mockResolvedValue({ sources: [source], episodeNavigationUrl: url() });
    mock.episodes.mockResolvedValue({ previous: null, next: target(1, 2) });
    mock.party.state = { phase: 'connected', participants: [], self: { id: 'self' }, room: { hostId: 'self' }, playback: null } as any;
    await mountScreen(); const episodes = nativeSurface().props.episodes;
    expect(episodes.blocked).toBe(false); expect(nativeSurface().props.partyConnected).toBe(false);
    episodes.onAutoNextChange(true); render(); await settle();
    expect(nativeSurface().props.episodes.autoNext).toBe(true);
    expect(mock.setItem).toHaveBeenCalledWith(AUTO_NEXT_KEY, 'true');
    episodes.next.onPress();
    expect(mock.replace).toHaveBeenCalledExactlyOnceWith('Player', expect.objectContaining({ season: 1, episode: 2 }));
  });
  it('does not apply stale episode metadata after the media identity changes', async () => {
    const old = deferred<any>(); const next = deferred<any>();
    mock.bridge.mockResolvedValue({ sources: [source], episodeNavigationUrl: url() });
    mock.episodes.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    await mountScreen(); const signal = mock.episodes.mock.calls[0]![1];
    mock.route.params = { ...mock.route.params, episode: 2 };
    mock.bridge.mockResolvedValue({ sources: [source], episodeNavigationUrl: url(2) });
    render(false); expect(nativeSurface()).toBeUndefined();
    while (mock.jobs.length) mock.jobs.shift()!(); await settle(); expect(signal.aborted).toBe(true);
    next.resolve({ previous: target(1, 1), next: target(1, 3) }); await settle();
    expect(nativeSurface().props.episodes.next.label).toBe('S1 E3');
    old.resolve({ previous: null, next: target(1, 2) }); await settle();
    expect(nativeSurface().props.episodes.next.label).toBe('S1 E3');
  });
  it('retries unavailable neighbors explicitly without re-resolving or remounting video', async () => {
    mock.bridge.mockResolvedValue({ sources: [source], episodeNavigationUrl: url() });
    mock.episodes.mockRejectedValueOnce(new Error('unavailable')).mockResolvedValue({ previous: null, next: target(1, 2) });
    await mountScreen(); const key = nativeSurface().key;
    expect(nativeSurface().props.episodes.next).toBeNull();
    nativeSurface().props.episodes.onRetry(); render(); await settle();
    expect(nativeSurface().key).toBe(key); expect(mock.bridge).toHaveBeenCalledOnce(); expect(mock.episodes).toHaveBeenCalledTimes(2);
    expect(nativeSurface().props.episodes.next.label).toBe('S1 E2');
  });
  it('rejects an episode lookup for another series and omits all controls for movies', async () => {
    mock.bridge.mockResolvedValue({ sources: [source], episodeNavigationUrl: url(1, '999') });
    await mountScreen(); expect(mock.episodes).not.toHaveBeenCalled(); expect(nativeSurface().props.episodes.next).toBeNull();
    mock.route.params = { ...mock.route.params, type: 'movie', season: undefined, episode: undefined };
    render(); await settle(); expect(nativeSurface().props.episodes).toBeUndefined(); expect(mock.episodes).not.toHaveBeenCalled();
  });
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
    const footer = nodes().find((node) => node.props?.style?.[0]?.backgroundColor === 'rgba(0,0,0,0.72)');
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
    await mountScreen(); expect(nativeSurface().type).toBe(NativePlayer); expect(nativeSurface().props.intro).toBeNull();
    expect(mock.intro).toHaveBeenCalledExactlyOnceWith(introUrl, expect.any(AbortSignal));
    lookup.resolve(null); await settle(); expect(nativeSurface().type).toBe(NativePlayer); expect(nativeSurface().props.intro).toBeNull();
  });

  it.each([introUrl, 'https://hulkofyt.eu.org/api/intro?episode=2'])('resets immediately on episode change and ignores old results for URL %s', async (nextUrl) => {
    const old = deferred<IntroMarker | null>(); const next = deferred<IntroMarker | null>();
    mock.intro.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    await mountScreen(); const oldSignal = mock.intro.mock.calls[0]![1];
    mock.route = { params: { ...mock.route.params, episode: 2 } };
    mock.bridge.mockResolvedValue({ sources: [source], introCatalogUrl: nextUrl });
    render(false); expect(nativeSurface()).toBeUndefined();
    while (mock.jobs.length) mock.jobs.shift()!(); await settle();
    expect(oldSignal.aborted).toBe(true);
    next.resolve({ startSeconds: 10, endSeconds: 30 }); await settle();
    expect(nativeSurface().props.intro).toEqual({ startSeconds: 10, endSeconds: 30 });
    old.resolve(marker); await settle(); expect(nativeSurface().props.intro).toEqual({ startSeconds: 10, endSeconds: 30 });
  });

  it('resets an already shown marker synchronously for a new episode', async () => {
    mock.intro.mockResolvedValue(marker); await mountScreen(); expect(nativeSurface().props.intro).toEqual(marker);
    mock.route = { params: { ...mock.route.params, episode: 2 } };
    render(false); expect(nativeSurface()).toBeUndefined();
  });

  it('rejects a stale old URL response after retrying the same episode', async () => {
    const old = deferred<IntroMarker | null>(); const next = deferred<IntroMarker | null>();
    mock.intro.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    mock.bridge.mockResolvedValue({ sources: [{ ...source, kind: 'embed' }], introCatalogUrl: introUrl });
    await mountScreen(); nodes().find((node) => node.type === 'WebView').props.onError(); render(); action('Retry').props.onPress();
    mock.bridge.mockResolvedValue({ sources: [source], introCatalogUrl: `${introUrl}&retry=1` });
    render(); await settle(); next.resolve({ startSeconds: 2, endSeconds: 20 }); await settle();
    expect(nativeSurface().props.intro).toEqual({ startSeconds: 2, endSeconds: 20 });
    old.resolve(marker); await settle(); expect(nativeSurface().props.intro).toEqual({ startSeconds: 2, endSeconds: 20 });
  });

  it('delegates all direct stream errors to the same NativePlayer instead of remounting into Auto', async () => {
    mock.intro.mockResolvedValue(marker); await mountScreen();
    const native = nativeSurface();
    expect(native.props.onError).toBeUndefined(); render(); await settle();
    expect(nativeSurface().type).toBe(NativePlayer);
    expect(nativeSurface().key).toBe(native.key);
    expect(nativeSurface().props).toMatchObject({ source, intro: marker, registerPartyPlayerPort: mock.party.registerPlayerPort });
    expect(nodes().filter((node) => node.type === 'WatchPartySheet')).toHaveLength(1);
    expect(action('Retry')).toBeUndefined();
    expect(nativeSurface()).toBeDefined();
  });
});

describe('Android direct catalogue capability lifecycle', () => {
  const metadataUrl = 'https://hulkofyt.eu.org/api/vidnest?type=movie&tmdbId=123&metadata=1';
  const managed = { ...source, url: 'https://hulkofyt.eu.org/api/vidnest?type=movie&tmdbId=123&stream=auto', streamCatalogUrl: metadataUrl };
  const cap = (id: string, token: string, expiresAt = Date.now() + 120_000) => ({ id,
    url: `https://hulkofyt.eu.org/api/vidnest?token=${token}`, expiresAt, startupLatencyMs: Number(id),
    qualities: [{ id: 'auto', label: 'Auto', auto: true }, { id: '720', label: '720p', height: 720 }, { id: '1080', label: '1080p', height: 1080 }],
    audioTracks: [], subtitles: [] });
  function readyCurrent() {
    const uri = mock.player.replaceAsync.mock.calls.at(-1)?.[0]?.uri;
    expect(uri).toBeDefined();
    mock.player.status = 'readyToPlay';
    emit('sourceLoad', { videoSource: { uri }, duration: mock.player.duration, availableAudioTracks: [], availableSubtitleTracks: [] });
    emit('statusChange', { status: 'readyToPlay' }); render();
  }
  function selectNumber(number: number) {
    openGroup('Audio');
    const choice = nodes().find((node) => node.props.accessibilityLabel === `Audio stream ${number}`);
    expect(choice).toBeDefined(); choice.props.onPress(); render();
  }
  function openGroup(group: string) {
    if (!nodes().some((node) => node.props.label === 'Quality' && typeof node.props.expanded === 'boolean')) {
      action('Settings').props.onPress(); render();
    }
    const heading = nodes().find((node) => node.props.label === group && typeof node.props.expanded === 'boolean');
    expect(heading).toBeDefined();
    if (!heading.props.expanded) { heading.props.onPress(); render(); }
  }
  function setRate() { openGroup('Speed'); action('1.25x').props.onPress(); render(); }
  function hasNumericPin() {
    return nodes().some((node) => node.props.label === 'Audio' && node.props.summary === 'Stream 2');
  }
  it('waits for one catalogue and never starts the parallel unsigned resolver URL', async () => {
    const pending = deferred<any>(); mock.streams.mockReturnValue(pending.promise);
    await mountNative({ source: managed });
    expect(mock.streams).toHaveBeenCalledExactlyOnceWith(metadataUrl, expect.any(AbortSignal));
    expect(mock.player.replaceAsync).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000); render();
    expect(props.onError).not.toHaveBeenCalled(); expect(mock.player.replaceAsync).not.toHaveBeenCalled();
    pending.resolve({ streams: [cap('0', 'first')] }); await settle(); readyCurrent();
    expect(mock.player.replaceAsync).toHaveBeenCalledExactlyOnceWith({ uri: cap('0', 'first').url, contentType: 'hls' });
  });
  it('uses cached capabilities for quality and audio choices while preserving native position and rate', async () => {
    const one = cap('0', 'one'), two = cap('1', 'two');
    mock.streams.mockResolvedValue({ streams: [one, two] });
    await mountNative({ source: managed, initial: { positionSeconds: 42.25, playing: true } }); readyCurrent();
    setRate(); openGroup('Quality'); action('720p').props.onPress(); render(); await settle(); readyCurrent();
    expect(mock.player.replaceAsync).toHaveBeenLastCalledWith({ uri: `${one.url}&rendition=720`, contentType: 'hls' });
    setRate(); selectNumber(2); await settle(); readyCurrent();
    expect(mock.player.replaceAsync).toHaveBeenLastCalledWith({ uri: `${two.url}&rendition=720`, contentType: 'hls' });
    expect(mock.streams).toHaveBeenCalledOnce(); expect(mock.player.currentTime).toBe(42.25);
    expect(mock.player.playbackRate).toBe(1.25); expect(mock.player.playing).toBe(true);
    expect(nodes().filter((node) => node.type === 'VideoView')).toHaveLength(1);
  });
  it('renews once on an expired selection and preserves a numeric pin across reordered metadata', async () => {
    const deadline = Date.now() + 1000;
    mock.streams.mockResolvedValueOnce({ expiresAt: deadline, streams: [cap('0', 'one', deadline), cap('1', 'two', deadline)] });
    const renewal = deferred<any>(); mock.streams.mockReturnValueOnce(renewal.promise);
    await mountNative({ source: managed, initial: { positionSeconds: 47.5, playing: false } }); readyCurrent();
    setRate(); selectNumber(2); await settle(); readyCurrent();
    const replacements = mock.player.replaceAsync.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1001); render();
    expect(mock.streams).toHaveBeenCalledOnce();
    openGroup('Quality');
    action('1080p').props.onPress(); action('1080p').props.onPress(); render(); await settle();
    expect(mock.streams).toHaveBeenCalledTimes(2); expect(mock.player.replaceAsync).toHaveBeenCalledTimes(replacements);
    renewal.resolve({ streams: [cap('1', 'renewed-two'), cap('0', 'renewed-one')] }); await settle(); readyCurrent();
    expect(mock.player.replaceAsync).toHaveBeenLastCalledWith({ uri: `${cap('1', 'renewed-two').url}&rendition=1080`, contentType: 'hls' });
    expect(mock.player.currentTime).toBe(47.5); expect(mock.player.playing).toBe(false); expect(mock.player.playbackRate).toBe(1.25);
    expect(hasNumericPin()).toBe(true);
  });
  it('Retry renews metadata once instead of replaying the old failed capability', async () => {
    mock.streams.mockResolvedValueOnce({ streams: [cap('0', 'old')] });
    const renewed = deferred<any>(); mock.streams.mockReturnValueOnce(renewed.promise);
    await mountNative({ source: managed }); readyCurrent();
    emit('statusChange', { status: 'error' }); render();
    const retry = rawAction('Retry'); expect(retry).toBeDefined();
    retry.props.onPress(); retry.props.onPress(); render(); await settle();
    expect(mock.streams).toHaveBeenCalledTimes(2); expect(mock.player.replaceAsync).toHaveBeenCalledOnce();
    renewed.resolve({ streams: [cap('0', 'new')] }); await settle(); readyCurrent();
    expect(mock.player.replaceAsync).toHaveBeenLastCalledWith({ uri: cap('0', 'new').url, contentType: 'hls' });
    expect(mock.player.replaceAsync).toHaveBeenCalledTimes(2);
  });
  it('does not silently fall back to Auto when a renewed numeric pin disappears', async () => {
    mock.streams.mockResolvedValueOnce({ streams: [cap('0', 'one'), cap('1', 'two')] });
    mock.streams.mockResolvedValueOnce({ streams: [cap('0', 'new-one')] });
    await mountNative({ source: managed }); readyCurrent(); selectNumber(2); await settle(); readyCurrent();
    emit('statusChange', { status: 'error' }); render();
    rawAction('Retry').props.onPress(); render(); await settle();
    expect(mock.streams).toHaveBeenCalledTimes(2); expect(mock.player.replaceAsync).toHaveBeenCalledTimes(2);
    expect(rawAction('Retry')).toBeDefined();
    expect(hasNumericPin()).toBe(true);
    openGroup('Audio');
    nodes().find((node) => node.props.accessibilityLabel === 'Audio Auto').props.onPress(); render(); await settle(); readyCurrent();
    expect(mock.streams).toHaveBeenCalledTimes(2);
    expect(mock.player.replaceAsync).toHaveBeenLastCalledWith({ uri: cap('0', 'new-one').url, contentType: 'hls' });
    expect(hasNumericPin()).toBe(false);
  });
  it('reattaches a still-valid capability when a Retry metadata response is served from server cache', async () => {
    const stream = cap('0', 'same'); mock.streams.mockResolvedValue({ streams: [stream] });
    await mountNative({ source: managed }); readyCurrent();
    emit('statusChange', { status: 'error' }); render(); rawAction('Retry').props.onPress(); render(); await settle(); readyCurrent();
    expect(mock.streams).toHaveBeenCalledTimes(2);
    expect(mock.player.replaceAsync).toHaveBeenNthCalledWith(1, { uri: stream.url, contentType: 'hls' });
    expect(mock.player.replaceAsync).toHaveBeenNthCalledWith(2, { uri: stream.url, contentType: 'hls' });
  });
  it('aborts and ignores a late result when the catalogue identity changes under the same source ID', async () => {
    const old = deferred<any>(); mock.streams.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ streams: [cap('0', 'new-media')] });
    await mountNative({ source: managed }); const oldSignal = mock.streams.mock.calls[0]![1];
    props = { ...props, source: { ...managed, streamCatalogUrl: `${metadataUrl}&episode=2` } }; render(); await settle(); readyCurrent();
    expect(oldSignal.aborted).toBe(true); expect(mock.streams).toHaveBeenCalledTimes(2);
    old.resolve({ streams: [cap('0', 'old-media')] }); await settle();
    expect(mock.player.replaceAsync).toHaveBeenCalledExactlyOnceWith({ uri: cap('0', 'new-media').url, contentType: 'hls' });
  });
  it('fails closed on empty metadata without starting the unsigned source', async () => {
    mock.streams.mockResolvedValue({ streams: [] }); await mountNative({ source: managed });
    expect(mock.player.replaceAsync).not.toHaveBeenCalled(); expect(props.onError).toHaveBeenCalledOnce();
    expect(rawAction('Retry')).toBeDefined();
  });
  it('cancels a pending catalogue on unmount and never starts its late capability', async () => {
    const pending = deferred<any>(); mock.streams.mockReturnValue(pending.promise);
    await mountNative({ source: managed }); const signal = mock.streams.mock.calls[0]![1];
    mock.effects.forEach((effect) => effect.cleanup?.());
    pending.resolve({ streams: [cap('0', 'late')] }); await settle();
    expect(signal.aborted).toBe(true); expect(mock.player.replaceAsync).not.toHaveBeenCalled();
  });
});
