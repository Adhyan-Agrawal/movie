import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CastingHandle, CastingProgress } from '@/features/player/casting';
import type { NativePlayerProps } from '@/features/player/NativePlayer';

// A commit/effect harness exercises the mounted component without a DOM dependency or network.
const harness = vi.hoisted(() => ({
  slots: [] as Array<{ value?: unknown; deps?: unknown[]; cleanup?: () => void }>,
  cursor: 0, dirty: false, effects: [] as Array<() => void>,
  players: [] as any[], events: [] as string[], checkpoint: null as any,
  write: vi.fn(), report: vi.fn(), casting: vi.fn(), adUpdate: vi.fn(), fetch: vi.fn(),
  receiverProgress: null as ((progress: CastingProgress) => void) | null,
  receiverDisconnect: null as (() => void) | null,
}));

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return { ...actual,
    useRef: (value: unknown) => {
      const index = harness.cursor++;
      harness.slots[index] ??= { value: { current: value } };
      return harness.slots[index]!.value;
    },
    useState: (value: unknown) => {
      const index = harness.cursor++;
      harness.slots[index] ??= { value };
      return [harness.slots[index]!.value, (next: unknown) => {
        const slot = harness.slots[index]!;
        const result = typeof next === 'function' ? next(slot.value) : next;
        if (!Object.is(slot.value, result)) { slot.value = result; harness.dirty = true; }
      }];
    },
    useId: () => { harness.cursor++; return 'intro-fixture'; },
    useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
      const index = harness.cursor++;
      const previous = harness.slots[index];
      if (previous?.deps && deps.length === previous.deps.length && deps.every((value, i) => Object.is(value, previous.deps![i]))) return;
      harness.slots[index] = { deps, cleanup: previous?.cleanup };
      harness.effects.push(() => {
        previous?.cleanup?.();
        harness.slots[index]!.cleanup = effect() ?? undefined;
      });
    },
  };
});
vi.mock('react-dom', () => ({ createPortal: (children: unknown, target: unknown) => ({ type: 'portal', props: { children, target } }) }));
vi.mock('@/features/playback/progress-actions', () => ({ reportProgressAction: harness.report }));
vi.mock('@/features/playback/guest-watch', () => ({ readGuestEntries: () => [], updateGuestPosition: vi.fn() }));
vi.mock('@/features/playback/playback-checkpoint', () => ({
  playbackMediaKey: () => 'fixture-media', readPlaybackCheckpoint: () => harness.checkpoint,
  writePlaybackCheckpoint: harness.write, markPlaybackCheckpointSynced: vi.fn(),
}));
vi.mock('@/features/player/fullscreen-orientation', () => ({ createFullscreenOrientation: () => ({ setFullscreen: vi.fn(), dispose: vi.fn() }) }));
vi.mock('@/components/consent/ConsentBanner', () => ({ readConsent: () => ({ ads: true }) }));
vi.mock('@/features/ads/vast/VastAdBreak', () => ({ VastAdBreak: () => null }));
vi.mock('@/features/player/casting', () => ({ requestCasting: harness.casting }));
vi.mock('@/features/ads/vast/scheduler', async () => {
  const actual = await vi.importActual<typeof import('@/features/ads/vast/scheduler')>('@/features/ads/vast/scheduler');
  return { ...actual, createVastSchedule: (...args: Parameters<typeof actual.createVastSchedule>) => {
    const schedule = actual.createVastSchedule(...args);
    return { ...schedule, update: (input: Parameters<typeof schedule.update>[0]) => {
      harness.events.push(`ad:${input.contentTimeSeconds}:${Boolean(input.seeking)}`);
      harness.adUpdate(input);
      return schedule.update(input);
    } };
  } };
});
vi.mock('video.js', () => ({ default: (_element: unknown, options: any) => {
  const listeners = new Map<string, Array<() => void>>();
  const list = { length: 0, on: vi.fn(), off: vi.fn() };
  const element = new FakeElement();
  const player: any = {
    position: 0, seconds: 120, rate: 1, stopped: true, readiness: 0, isSeeking: false, disposed: false,
    url: options.sources[0].src,
    emit(event: string) { for (const listener of listeners.get(event) ?? []) listener(); },
    on(event: string | string[], listener: () => void) {
      for (const key of typeof event === 'string' ? [event] : event) listeners.set(key, [...(listeners.get(key) ?? []), listener]);
    },
    el: () => element, qualityLevels: () => list, audioTracks: () => list, textTracks: () => list,
    currentTime: vi.fn((position?: number) => {
      if (position === undefined) return player.position;
      harness.events.push(`seek:${position}`);
      player.isSeeking = true; player.emit('seeking'); player.position = position;
      player.emit('timeupdate'); player.isSeeking = false; player.emit('seeked');
      return player;
    }),
    duration: () => player.seconds, paused: () => player.stopped, seeking: () => player.isSeeking,
    readyState: () => player.readiness, isDisposed: () => player.disposed, error: () => null,
    playbackRate: (rate?: number) => { if (rate !== undefined) player.rate = rate; return player.rate; },
    pause: vi.fn(() => { player.stopped = true; player.emit('pause'); }),
    play: vi.fn(async () => { player.stopped = false; player.emit('playing'); }),
    src: vi.fn((source: { src: string }) => { player.url = source.src; player.readiness = 0; player.emit('loadstart'); }),
    volume: () => 1, muted: () => false, controls: vi.fn(), userActive: vi.fn(),
    ready: (callback: () => void) => callback(), isFullscreen: () => false,
    dispose: vi.fn(() => { player.disposed = true; }),
  };
  harness.players.push(player);
  return player;
} }));

class FakeElement {
  className = '';
  current: unknown;
  setAttribute() {}
  appendChild() {}
  remove() {}
  addEventListener() {}
  removeEventListener() {}
  closest() { return null; }
  querySelector() { return video; }
}
class FakeVideo extends FakeElement { controlsList = { add: vi.fn() }; }
let video: FakeVideo;
let NativePlayer: typeof import('@/features/player/NativePlayer')['NativePlayer'];
let props: NativePlayerProps;
let tree: any;
const container = new FakeElement();
const INTRO_URL = '/api/intro?episode=1';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const response = (intro: unknown) => ({ ok: true, json: async () => ({ intro }) }) as Response;
function nodes(node = tree): any[] {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap((item) => item === undefined ? [] : nodes(item));
  return node.props?.children === undefined ? [node] : [node, ...nodes(node.props.children)];
}
function button() { return nodes().find((node) => node.type === 'button' && node.props.className?.includes('lumora-player-skip-intro')); }
function render() {
  harness.cursor = 0; harness.dirty = false;
  tree = NativePlayer(props);
  for (const node of nodes()) if (node.props?.['data-vjs-player'] !== undefined) node.props.ref.current = container;
  for (const effect of harness.effects.splice(0)) effect();
}
async function pump() {
  for (let index = 0; index < 30; index++) { await Promise.resolve(); if (harness.dirty) render(); }
}
function player() { return harness.players.at(-1)!; }
async function ready(position = 0, duration = 120) {
  const instance = player();
  instance.seconds = duration; instance.readiness = 2;
  instance.emit('loadedmetadata'); instance.emit('loadeddata'); instance.emit('canplay');
  instance.position = position; instance.emit('timeupdate');
  await pump();
}
function castButton() { return nodes().find((node) => node.props?.label === 'Cast'); }
async function connectCast(remote: CastingProgress, seek: CastingHandle['seek'] = vi.fn(async () => undefined)) {
  const handle: CastingHandle = { deviceName: 'Fixture TV', play: vi.fn(async () => {}), pause: vi.fn(async () => {}), seek, stop: vi.fn(), dispose: vi.fn() };
  harness.casting.mockImplementation(async (_video: unknown, _media: unknown, publish: (progress: CastingProgress) => void, disconnect: () => void) => {
    harness.receiverProgress = publish; harness.receiverDisconnect = disconnect; publish(remote); return handle;
  });
  castButton().props.onClick(); await pump();
  return handle;
}

beforeEach(async () => {
  harness.slots = []; harness.effects = []; harness.players = []; harness.cursor = 0;
  harness.dirty = false; harness.events = []; harness.checkpoint = null; harness.receiverProgress = null; harness.receiverDisconnect = null;
  vi.clearAllMocks(); vi.useFakeTimers();
  harness.report.mockResolvedValue({ ok: false });
  harness.fetch.mockResolvedValue(response({ startSeconds: 0, endSeconds: 10.25 }));
  harness.casting.mockResolvedValue(null);
  video = new FakeVideo();
  vi.stubGlobal('fetch', harness.fetch);
  vi.stubGlobal('Element', FakeElement); vi.stubGlobal('HTMLVideoElement', FakeVideo);
  vi.stubGlobal('document', { createElement: () => new FakeElement(), visibilityState: 'visible', addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal('window', { location: { href: 'https://movies.example/watch', origin: 'https://movies.example' }, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal('navigator', { maxTouchPoints: 0 });
  ({ NativePlayer } = await import('@/features/player/NativePlayer'));
  props = { source: { url: '/movie.mp4', kind: 'mp4' }, introCatalogUrl: INTRO_URL, titleId: 'fixture', titleSlug: 'fixture', viewerKey: 'guest' };
  render(); await pump();
});
afterEach(() => {
  for (const slot of harness.slots) slot?.cleanup?.();
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals();
});

describe('web Skip Intro visibility and seeking', () => {
  it('fetches lazily without waiting for media and hides until actual content is ready', async () => {
    expect(harness.fetch).toHaveBeenCalledWith(INTRO_URL, expect.objectContaining({ credentials: 'same-origin', signal: expect.any(AbortSignal) }));
    expect(button()).toBeUndefined();
    await ready(0);
    expect(button()).toBeDefined();
    expect(button().props['data-player-ui']).toBe('');
    expect(nodes().find((node) => node.type === 'portal')?.props.target).toBe(player().el());
  });
  it('supports zero/fractional markers, pause/rate, scheduler-before-seek and existing checkpoint flush', async () => {
    await ready(0.25);
    player().rate = 1.5; player().stopped = true;
    harness.events = []; harness.write.mockClear();
    button().props.onClick(); await pump();
    expect(harness.events[0]).toBe('ad:10.25:true');
    expect(harness.events[1]).toBe('seek:10.25');
    expect(player().position).toBe(10.25);
    expect(player().stopped).toBe(true); expect(player().rate).toBe(1.5);
    expect(harness.write).toHaveBeenCalledWith('guest', 'fixture-media', 10.25, 120, false);
    expect(button()).toBeUndefined();
  });
  it('shows only in [start,end), and rewinding re-shows without persistent skipped state', async () => {
    harness.fetch.mockResolvedValue(response({ startSeconds: 5.25, endSeconds: 10.25 }));
    props = { ...props, introCatalogUrl: '/api/intro?episode=2' }; render(); await pump();
    await ready(5); expect(button()).toBeUndefined();
    player().currentTime(5.25); await pump(); expect(button()).toBeDefined();
    button().props.onClick(); await pump(); expect(button()).toBeUndefined();
    player().currentTime(6.5); await pump(); expect(button()).toBeDefined();
    player().currentTime(11); await pump(); expect(button()).toBeUndefined();
  });
  it.each([null, {}, { startSeconds: -1, endSeconds: 10 }, { startSeconds: 10, endSeconds: 10 },
    { startSeconds: 11, endSeconds: 10 }, { startSeconds: '0', endSeconds: 10 },
    { startSeconds: 0, endSeconds: Infinity }, { startSeconds: NaN, endSeconds: 10 }])('rejects invalid marker %j', async (intro) => {
    harness.fetch.mockResolvedValue(response(intro));
    props = { ...props, introCatalogUrl: '/api/intro?invalid=1' }; render(); await pump();
    await ready(0); expect(button()).toBeUndefined();
  });
  it.each([0, NaN, Infinity, 9.9])('requires actual finite duration proving the intro end: %s', async (duration) => {
    await ready(0, duration); expect(button()).toBeUndefined();
  });
  it('rechecks live duration/position on click rather than trusting the rendered button', async () => {
    await ready(1);
    const stale = button(); player().seconds = 3;
    player().currentTime.mockClear(); stale.props.onClick(); await pump();
    expect(player().currentTime.mock.calls.some((args: unknown[]) => args.length > 0)).toBe(false);
  });
  it('hides while waiting and restores after canplay, including a paused seek', async () => {
    await ready(1); expect(button()).toBeDefined();
    player().emit('waiting'); await pump(); expect(button()).toBeUndefined();
    player().emit('canplay'); await pump(); expect(button()).toBeDefined();
  });
  it('uses a resumed intro position, not a skipped-state flag', async () => {
    props = { ...props, source: { url: '/resume.mp4', kind: 'mp4' }, initialPosition: 6.5 }; render(); await pump();
    await ready(6.5); expect(button()).toBeDefined();
  });
  it('does not catch up VAST thresholds when skipping while playing', async () => {
    props = { ...props, source: { url: '/ad-content.mp4', kind: 'mp4' }, adPolicy: { enabled: true, firstBreakSeconds: 5, intervalSeconds: 5, maxBreaks: 3, allowSkip: true, skipAfterSeconds: 5 } };
    render(); await pump(); await ready(1); player().stopped = false;
    button().props.onClick(); await pump();
    expect(harness.fetch.mock.calls.some(([url]) => url === '/api/vast?consent=1')).toBe(false);
  });
  it('blocks during ad loading and a visible ad break', async () => {
    const ad = deferred<Response>();
    harness.fetch.mockImplementation(async (url: string) => url === '/api/vast?consent=1' ? ad.promise : response({ startSeconds: 0, endSeconds: 10.25 }));
    props = { ...props, source: { url: '/ads.mp4', kind: 'mp4' }, adPolicy: { enabled: true, firstBreakSeconds: 5, intervalSeconds: 5, maxBreaks: 3, allowSkip: true, skipAfterSeconds: 5 } };
    render(); await pump(); await ready(1); player().stopped = false;
    player().position = 5; player().emit('timeupdate'); await pump(); expect(button()).toBeUndefined();
    ad.resolve({ ok: true, status: 200, json: async () => ({ creative: { id: 'ad', mediaUrl: '/ad.mp4', durationSeconds: 10 } }) } as Response);
    await pump(); expect(button()).toBeUndefined();
  });
});

describe('intro catalog ownership', () => {
  it('cancels changed URLs, ignores late old responses, and does not remount media', async () => {
    const old = deferred<Response>();
    harness.fetch.mockReturnValueOnce(old.promise).mockResolvedValueOnce(response({ startSeconds: 40, endSeconds: 50 }));
    props = { ...props, introCatalogUrl: '/api/intro?old=1' }; render(); await pump();
    const signal = harness.fetch.mock.calls.at(-1)![1].signal as AbortSignal;
    const count = harness.players.length;
    props = { ...props, introCatalogUrl: '/api/intro?new=1' }; render(); await pump();
    expect(signal.aborted).toBe(true); expect(harness.players).toHaveLength(count);
    old.resolve(response({ startSeconds: 0, endSeconds: 10 })); await pump();
    await ready(5); expect(button()).toBeUndefined();
    player().currentTime(45); await pump(); expect(button()).toBeDefined();
  });
  it('retains independent metadata through source replacement, but hides until the replacement is ready', async () => {
    await ready(1);
    const fetches = harness.fetch.mock.calls.length;
    const previous = player();
    props = { ...props, source: { url: '/replacement.mp4', kind: 'mp4' } }; render(); await pump();
    expect(previous.disposed).toBe(true); expect(button()).toBeUndefined();
    expect(harness.fetch).toHaveBeenCalledTimes(fetches);
    await ready(2); expect(button()).toBeDefined();
  });
  it('removing the URL clears the marker immediately', async () => {
    await ready(1);
    props = { ...props, introCatalogUrl: undefined }; render(); await pump();
    expect(button()).toBeUndefined();
  });
  it('fails open on catalog network errors without changing media readiness', async () => {
    harness.fetch.mockRejectedValueOnce(new Error('Unavailable'));
    props = { ...props, introCatalogUrl: '/api/intro?offline=1' }; render(); await pump();
    await ready(1); expect(button()).toBeUndefined(); expect(player().disposed).toBe(false);
  });
});

describe('receiver-only Skip Intro', () => {
  it('blocks connecting, and native AirPlay null handle remains a local seek', async () => {
    await ready(1);
    const pending = deferred<CastingHandle | null>(); harness.casting.mockReturnValue(pending.promise);
    castButton().props.onClick(); await pump(); expect(button()).toBeUndefined();
    pending.resolve(null); await pump(); expect(button()).toBeDefined();
    button().props.onClick(); await pump(); expect(player().position).toBe(10.25);
  });
  it('does not start a second Cast connection while the first picker is pending', async () => {
    await ready(1);
    const pending = deferred<CastingHandle | null>();
    harness.casting.mockReturnValue(pending.promise);
    castButton().props.onClick(); castButton().props.onClick(); await pump();
    expect(harness.casting).toHaveBeenCalledTimes(1);
    pending.resolve(null); await pump();
  });
  it('seeks only the Cast receiver, prevents duplicates and checkpoints acknowledged remote progress', async () => {
    await ready(1);
    const pending = deferred<void>();
    const seek = vi.fn(() => pending.promise);
    await connectCast({ positionSeconds: 3.5, durationSeconds: 120, paused: false }, seek);
    player().currentTime.mockClear(); harness.write.mockClear();
    const action = button(); action.props.onClick(); action.props.onClick(); await pump();
    expect(seek).toHaveBeenCalledExactlyOnceWith(10.25);
    expect(player().currentTime).not.toHaveBeenCalled(); expect(player().position).toBe(1);
    expect(button().props.disabled).toBe(true);
    harness.receiverProgress!({ positionSeconds: 10.25, durationSeconds: 120, paused: false });
    pending.resolve(); await pump();
    expect(harness.write).toHaveBeenCalledWith('guest', 'fixture-media', 10.25, 120, false);
    expect(button()).toBeUndefined();
  });
  it('uses the remote duration and position rather than paused local content', async () => {
    await ready(1);
    await connectCast({ positionSeconds: 30, durationSeconds: 120, paused: true }); expect(button()).toBeUndefined();
    harness.receiverProgress!({ positionSeconds: 5, durationSeconds: 9, paused: true }); await pump(); expect(button()).toBeUndefined();
    harness.receiverProgress!({ positionSeconds: 5, durationSeconds: 120, paused: true }); await pump(); expect(button()).toBeDefined();
  });
  it('sanitizes receiver failures and never falls back to a local seek', async () => {
    await ready(1);
    await connectCast({ positionSeconds: 3, durationSeconds: 120, paused: true }, vi.fn(async () => { throw new Error('https://secret.example?token=private'); }));
    player().currentTime.mockClear(); button().props.onClick(); await pump();
    expect(player().currentTime).not.toHaveBeenCalled();
    expect(nodes().some((node) => node.props?.children === 'The device could not skip the intro. Try again.')).toBe(true);
    expect(JSON.stringify(tree)).not.toContain('secret.example');
  });
  it('ignores stale receiver acknowledgement after replacing the source', async () => {
    await ready(1);
    const pending = deferred<void>();
    await connectCast({ positionSeconds: 3, durationSeconds: 120, paused: true }, vi.fn(() => pending.promise));
    button().props.onClick(); await pump();
    props = { ...props, source: { url: '/new-session.mp4', kind: 'mp4' } }; render(); await pump();
    harness.write.mockClear(); pending.resolve(); await pump();
    expect(harness.write).not.toHaveBeenCalled(); expect(player().position).toBe(0);
  });
  it('does not issue a queued receiver command after the intro URL changed', async () => {
    await ready(1);
    const seek = vi.fn(async () => undefined);
    await connectCast({ positionSeconds: 3, durationSeconds: 120, paused: true }, seek);
    button().props.onClick();
    props = { ...props, introCatalogUrl: '/api/intro?next-episode=1' }; render(); await pump();
    expect(seek).not.toHaveBeenCalled();
  });
  it('reports a sanitized disconnect during receiver failure without seeking local content to the intro end', async () => {
    await ready(1);
    await connectCast({ positionSeconds: 3, durationSeconds: 120, paused: true }, vi.fn(async () => {
      harness.receiverDisconnect!(); throw new Error('https://secret.example?token=private');
    }));
    player().currentTime.mockClear(); button().props.onClick(); await pump();
    expect(player().currentTime).not.toHaveBeenCalledWith(10.25);
    expect(nodes().some((node) => node.props?.children === 'Casting ended before the intro could be skipped.')).toBe(true);
  });
  it('bounds a hung Cast seek and releases the pending command without a local fallback', async () => {
    await ready(1);
    await connectCast({ positionSeconds: 3, durationSeconds: 120, paused: true }, vi.fn(() => new Promise<void>(() => {})));
    player().currentTime.mockClear(); button().props.onClick(); await pump();
    expect(button().props.disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000); await pump();
    expect(button().props.disabled).toBe(false); expect(player().currentTime).not.toHaveBeenCalled();
  });
  it('bounds a local seek that never acknowledges and restores the action', async () => {
    await ready(1);
    player().currentTime.mockImplementation((position?: number) => position === undefined ? player().position : player());
    button().props.onClick(); await pump();
    expect(button().props.disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000); await pump();
    expect(button().props.disabled).toBe(false);
    expect(nodes().some((node) => node.props?.children === 'The intro could not be skipped. Try again.')).toBe(true);
  });
});
