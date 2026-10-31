import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Exercise JS lifecycle/events only. These mocks do not claim native decoding or hardware coverage.
const mock = vi.hoisted(() => {
  const listeners = new Map<string, Set<(value: any) => void>>();
  const appListeners = new Set<(state: string) => void>();
  const player = { currentTime: 0, playing: false, status: 'readyToPlay', volume: 1, muted: false,
    loop: false, staysActiveInBackground: false, timeUpdateEventInterval: 0,
    play: vi.fn(), pause: vi.fn(), replaceAsync: vi.fn(),
    addListener: vi.fn((event: string, callback: (value: any) => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(callback);
      return { remove: () => listeners.get(event)?.delete(callback) };
    }) };
  return { player, listeners, appListeners, effects: [] as Array<() => void | (() => void)>, fetch: vi.fn(),
    app: { currentState: 'active', addEventListener: (_event: string, callback: (state: string) => void) => {
      appListeners.add(callback); return { remove: () => appListeners.delete(callback) };
    } }, createPlayer: vi.fn(), openURL: vi.fn() };
});
vi.mock('../../mobile/node_modules/react', async (original) => ({ ...await original<typeof import('react')>(),
  useEffect: (effect: () => void | (() => void)) => { mock.effects.push(effect); },
  useRef: (value: unknown) => ({ current: value }), useState: (value: unknown) => [value, vi.fn()],
}));
vi.mock('../../mobile/node_modules/react-native', () => ({ AppState: mock.app, Linking: { openURL: mock.openURL },
  Pressable: 'Pressable', Text: 'Text', View: 'View', StyleSheet: { create: (value: unknown) => value, absoluteFill: {} },
}));
vi.mock('../../mobile/node_modules/react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, left: 0, bottom: 0, right: 0 }) }));
vi.mock('../../mobile/node_modules/expo-video', () => ({ VideoView: 'VideoView', useVideoPlayer: (source: unknown, setup: (player: typeof mock.player) => void) => {
  mock.createPlayer(source); setup(mock.player); return mock.player;
} }));

// Native TSX is typechecked by mobile tsc, not the web project's different React types.
const componentPath = '../../mobile/src/player/VastAdBreak';
const { default: NativeVastAd } = await import(componentPath);

const policy = { enabled: true, firstBreakSeconds: 60, intervalSeconds: 60, maxBreaks: 2, allowSkip: true, skipAfterSeconds: 8 };
const creative = { id: 'fixture', mediaUrl: 'https://ads.example.com/ad.mp4', durationSeconds: 60, skipAfterSeconds: 5,
  tracking: Object.fromEntries(['impression', 'start', 'firstQuartile', 'midpoint', 'thirdQuartile', 'complete', 'skip', 'error'].map((event) => [event, [`https://ads.example.com/${event}`]])),
  clickThrough: 'https://ads.example.com/details', clickTracking: ['https://ads.example.com/click'] };
let cleanup: void | (() => void);

beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  mock.listeners.clear(); mock.appListeners.clear(); mock.effects.length = 0;
  mock.player.currentTime = 0; mock.player.playing = false; mock.player.status = 'readyToPlay'; mock.app.currentState = 'active';
  mock.player.replaceAsync.mockResolvedValue(undefined);
  mock.openURL.mockResolvedValue(undefined);
  mock.fetch.mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', mock.fetch);
});
afterEach(() => { cleanup?.(); cleanup = undefined; vi.useRealTimers(); vi.unstubAllGlobals(); });
const emit = (event: string, value: unknown = {}) => { mock.listeners.get(event)?.forEach((listener) => listener(value)); };
const playing = () => { mock.player.playing = true; emit('playingChange', { isPlaying: true }); };
function mount(allowSkip = true, adCreative = creative) {
  const onDone = vi.fn();
  const tree = NativeVastAd({ creative: adCreative, policy: { ...policy, allowSkip }, volume: 0.4, muted: true, onDone });
  cleanup = mock.effects[0]!();
  return { onDone, children: tree.props.children as any[] };
}

describe('Native VAST separate player JS lifecycle', () => {
  it('loads only the ad URI in its own player, with inline textureView and no native fullscreen/PiP', async () => {
    const { children } = mount();
    await Promise.resolve();
    expect(mock.createPlayer).toHaveBeenCalledExactlyOnceWith(null);
    expect(mock.player.replaceAsync).toHaveBeenCalledExactlyOnceWith({ uri: creative.mediaUrl, contentType: 'progressive' });
    expect(children[0].props).toMatchObject({ player: mock.player, nativeControls: false, surfaceType: 'textureView',
      fullscreenOptions: { enable: false }, allowsPictureInPicture: false, requiresLinearPlayback: true });
    expect(mock.player).toMatchObject({ volume: 0.4, muted: true, loop: false, staysActiveInBackground: false });
    expect(mock.fetch).not.toHaveBeenCalled();
  });

  it('times out stalled loading gracefully, without pre-play error/impression tracking', async () => {
    const { onDone } = mount();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(onDone).toHaveBeenCalledExactlyOnceWith('error');
    expect(mock.player.pause).toHaveBeenCalledOnce();
    expect(mock.fetch).not.toHaveBeenCalled();
  });

  it('keeps healthy ads playing beyond 15 seconds and times out only after progress stalls', async () => {
    const { onDone } = mount(); playing();
    for (let time = 10; time <= 40; time += 10) {
      await vi.advanceTimersByTimeAsync(10_000);
      mock.player.currentTime = time; emit('timeUpdate', { currentTime: time });
      expect(onDone).not.toHaveBeenCalled();
    }
    await vi.advanceTimersByTimeAsync(15_000);
    expect(onDone).toHaveBeenCalledExactlyOnceWith('error');
  });

  it('handles playing/time/click/end events without any native third-party beacon transport', () => {
    const { onDone, children } = mount();
    emit('timeUpdate', { currentTime: 50 });
    expect(mock.fetch).not.toHaveBeenCalled();
    playing(); playing();
    mock.player.currentTime = 50; emit('timeUpdate', { currentTime: 50 }); emit('timeUpdate', { currentTime: 50 });
    const learnMore = children[2].props.children[0];
    learnMore.props.onPress(); learnMore.props.onPress();
    emit('playToEnd'); emit('playToEnd'); emit('statusChange', { status: 'error' });
    expect(onDone).toHaveBeenCalledExactlyOnceWith('complete');
    expect(mock.fetch).not.toHaveBeenCalled();
  });

  it('enforces the later creative/admin skip threshold and exactly one skip callback', () => {
    const { onDone, children } = mount();
    const skip = children[2].props.children[1];
    skip.props.onPress(); expect(onDone).not.toHaveBeenCalled();
    playing(); mock.player.currentTime = 7; skip.props.onPress(); expect(onDone).not.toHaveBeenCalled();
    mock.player.currentTime = 8; skip.props.onPress(); skip.props.onPress();
    expect(onDone).toHaveBeenCalledExactlyOnceWith('skip');
    expect(mock.fetch).not.toHaveBeenCalled();
  });

  it('has no skip control when admin disables skipping', () => {
    const { children } = mount(false);
    expect(children[2].props.children[1]).toBeNull();
  });

  it('cancels on background without reporting a false complete/error event', () => {
    const { onDone } = mount(); playing();
    mock.app.currentState = 'background'; mock.appListeners.forEach((listener) => listener('background'));
    emit('playToEnd');
    expect(onDone).toHaveBeenCalledExactlyOnceWith('cancel');
    expect(mock.fetch).not.toHaveBeenCalled();
    cleanup?.(); cleanup = undefined;
    expect([...mock.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
    expect(mock.appListeners.size).toBe(0);
  });

  it('cannot start a late-loaded ad after cleanup/navigation', async () => {
    let resolve!: () => void;
    mock.player.replaceAsync.mockImplementation(() => new Promise<void>((done) => { resolve = done; }));
    const { onDone } = mount();
    cleanup?.(); cleanup = undefined;
    resolve(); await Promise.resolve();
    expect(mock.player.play).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['complete', 'skip', 'error'])('never enters an unsafe beacon redirect chain during %s, even if RN fetch ignores redirect options', (result) => {
    const followedPrivateRedirect = vi.fn();
    mock.fetch.mockImplementation(async () => {
      // Model RN transport following an allowlisted beacon's redirect without exposing 302.
      followedPrivateRedirect('http://169.254.169.254/fixture');
      return new Response(null, { status: 204 });
    });
    const redirecting = 'https://ads.example.com/redirect';
    const { onDone, children } = mount(true, { ...creative,
      tracking: Object.fromEntries(Object.keys(creative.tracking).map((event) => [event, [redirecting]])),
      clickTracking: [redirecting] });
    playing(); mock.player.currentTime = 50; emit('timeUpdate', { currentTime: 50 });
    children[2].props.children[0].props.onPress();
    if (result === 'complete') emit('playToEnd');
    else if (result === 'skip') children[2].props.children[1].props.onPress();
    else emit('statusChange', { status: 'error' });
    expect(onDone).toHaveBeenCalledExactlyOnceWith(result);
    expect(mock.fetch).not.toHaveBeenCalled();
    expect(followedPrivateRedirect).not.toHaveBeenCalled();
  });
});
