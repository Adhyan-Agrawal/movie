import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrailerInfo, TrailerLookup } from '@/features/trailers/types';

type Fixture = {
  slots: any[]; cursor: number; effects: Array<() => void>; dirty: boolean; mounted: boolean;
  props: TrailerLookup; tree: any; node: any; card: EventTarget; element: { closest: () => EventTarget };
  media: any; mediaHistory: any[]; play: ReturnType<typeof vi.fn>;
};
const hooks = vi.hoisted(() => ({ current: null as Fixture | null, load: vi.fn() }));
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(),
  useRef(initial: unknown) {
    const fixture = hooks.current!; const index = fixture.cursor++;
    return fixture.slots[index] ??= { current: initial };
  },
  useState(initial: unknown) {
    const fixture = hooks.current!; const index = fixture.cursor++;
    const slot = fixture.slots[index] ??= { value: initial };
    return [slot.value, (next: unknown) => {
      if (!Object.is(slot.value, next)) { slot.value = next; fixture.dirty = true; }
    }];
  },
  useEffect(effect: () => void | (() => void), dependencies: unknown[]) {
    const fixture = hooks.current!; const index = fixture.cursor++; const previous = fixture.slots[index];
    if (previous && dependencies.length === previous.dependencies.length
      && dependencies.every((value, offset) => Object.is(value, previous.dependencies[offset]))) return;
    const slot = fixture.slots[index] = { dependencies, cleanup: undefined as (() => void) | undefined };
    fixture.effects.push(() => { previous?.cleanup?.(); slot.cleanup = effect() || undefined; });
  },
}));
vi.mock('@/features/trailers/client', () => ({ loadTrailer: hooks.load }));
import { TrailerPreview } from '@/features/catalog/components/TrailerPreview';

// Mirrors hook commits, keyed video refs and native events, not browser decoding or autoplay policy.
let fixtures: Fixture[];
let page: EventTarget & { visibilityState: string };
let pointer: EventTarget & { matches: boolean };
let motion: EventTarget & { matches: boolean };
let connection: EventTarget & { saveData: boolean; effectiveType: string };
let observers: Array<{ callback: IntersectionObserverCallback; observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }>;
const info: TrailerInfo = { url: 'https://imdb-video.media-imdb.com/synthetic-full.mp4',
  previewUrl: 'https://imdb-video.media-imdb.com/synthetic-preview.mp4', mime: 'video/mp4', name: 'Synthetic trailer', expiresAt: 9_999_999_999_999 };
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function nodes(node: any): any[] {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(nodes);
  return [node, ...nodes(node.props?.children)];
}
function createFixture(props: TrailerLookup = { imdbId: 'tt9000001' }): Fixture {
  const card = new EventTarget();
  const fixture: Fixture = { slots: [], cursor: 0, effects: [], dirty: false, mounted: true,
    props, tree: null, node: null, card, element: { closest: () => card }, media: null, mediaHistory: [], play: vi.fn(async () => undefined) };
  fixtures.push(fixture); return fixture;
}
function render(fixture: Fixture) {
  hooks.current = fixture; fixture.cursor = 0; fixture.dirty = false;
  fixture.tree = TrailerPreview(fixture.props); fixture.tree.props.ref.current = fixture.element;
  const next = nodes(fixture.tree).find((node) => node.type === 'video');
  if (fixture.node && (!next || fixture.node.key !== next.key)) { fixture.node.props.ref.current = null; fixture.media = null; }
  if (next) {
    if (!fixture.media) {
      const media = { src: '', paused: true, readyState: 2, currentTime: 9, muted: false, playsInline: false,
        play: vi.fn(() => { media.paused = false; return fixture.play(); }),
        pause: vi.fn(() => { media.paused = true; }),
        removeAttribute: vi.fn((name: string) => { if (name === 'src') media.src = ''; }),
        load: vi.fn(() => { media.currentTime = 0; }) };
      fixture.media = media; fixture.mediaHistory.push(media);
    }
    next.props.ref.current = fixture.media; fixture.media.src = next.props.src;
  }
  fixture.node = next;
}
async function flush() {
  for (let turn = 0; turn < 12; turn += 1) {
    for (const fixture of fixtures.filter((entry) => entry.mounted)) {
      while (fixture.effects.length) fixture.effects.shift()!();
    }
    await Promise.resolve();
    for (const fixture of fixtures.filter((entry) => entry.mounted && entry.dirty)) render(fixture);
  }
}
async function mount(props?: TrailerLookup) { const fixture = createFixture(props); render(fixture); await flush(); return fixture; }
function unmount(fixture: Fixture) {
  fixture.tree.props.ref.current = null;
  if (fixture.node) fixture.node.props.ref.current = null;
  fixture.mounted = false;
  for (const slot of fixture.slots) slot?.cleanup?.();
  fixture.node = null; fixture.media = null;
}
function enter(fixture: Fixture, pointerType = 'mouse') { fixture.card.dispatchEvent(Object.assign(new Event('pointerenter'), { pointerType })); }
function leave(fixture: Fixture) { fixture.card.dispatchEvent(new Event('pointerleave')); }
function intersection(fixture: Fixture, ratio: number) {
  const observer = observers.find((entry) => entry.observe.mock.calls.some(([card]) => card === fixture.card))!;
  observer.callback([{ target: fixture.card, isIntersecting: ratio > 0, intersectionRatio: ratio } as unknown as IntersectionObserverEntry], {} as IntersectionObserver);
}
async function advance(milliseconds: number) { await vi.advanceTimersByTimeAsync(milliseconds); await flush(); }
function mediaEvent(node: any, media: any, event: 'LoadedData' | 'Playing' | 'Error') { node.props[`on${event}`]?.({ currentTarget: media }); }
function hasLabel(fixture: Fixture) { return nodes(fixture.tree).some((node) => node.type === 'span' && node.props.children === 'Trailer preview - Muted'); }
function expectReleased(media: any) {
  expect(media.pause).toHaveBeenCalled(); expect(media.removeAttribute).toHaveBeenCalledWith('src');
  expect(media.load).toHaveBeenCalled(); expect(media.paused).toBe(true); expect(media.src).toBe(''); expect(media.currentTime).toBe(0);
}

beforeEach(() => {
  vi.useFakeTimers(); hooks.load.mockReset(); hooks.load.mockResolvedValue(info); fixtures = []; observers = [];
  page = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  pointer = Object.assign(new EventTarget(), { matches: true }); motion = Object.assign(new EventTarget(), { matches: false });
  connection = Object.assign(new EventTarget(), { saveData: false, effectiveType: '4g' });
  vi.stubGlobal('document', page); vi.stubGlobal('navigator', { connection });
  vi.stubGlobal('window', { location: new URL('https://preview.example'), matchMedia: (query: string) => query.includes('reduced-motion') ? motion : pointer });
  vi.stubGlobal('IntersectionObserver', class {
    observe = vi.fn(); disconnect = vi.fn();
    constructor(public callback: IntersectionObserverCallback) { observers.push(this); }
  });
});
afterEach(() => {
  for (const fixture of fixtures.filter((entry) => entry.mounted)) unmount(fixture);
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals();
});

describe('decorative trailer hover lifecycle', () => {
  it('keeps the first render deterministic without browser globals, media, or requests', () => {
    vi.stubGlobal('window', undefined); vi.stubGlobal('document', undefined); vi.stubGlobal('navigator', undefined);
    const fixture = createFixture(); expect(() => render(fixture)).not.toThrow();
    expect(fixture.tree.props['aria-hidden']).toBe('true');
    expect(nodes(fixture.tree).some((node) => ['video', 'iframe', 'dialog', 'button'].includes(node.type))).toBe(false);
    expect(hooks.load).not.toHaveBeenCalled();
  });

  it('waits 650ms, then starts muted inline media without a dialog or eager preload', async () => {
    const fixture = await mount(); expect(hooks.load).not.toHaveBeenCalled(); enter(fixture);
    await advance(649); expect(hooks.load).not.toHaveBeenCalled(); await advance(1);
    expect(hooks.load).toHaveBeenCalledOnce(); expect(fixture.media.play).toHaveBeenCalledOnce();
    expect(fixture.node.props).toMatchObject({ src: info.previewUrl, muted: true, autoPlay: true, playsInline: true, loop: true,
      preload: 'none', disablePictureInPicture: true, disableRemotePlayback: true });
    expect(fixture.media.muted).toBe(true); expect(hasLabel(fixture)).toBe(false);
    expect(nodes(fixture.tree).some((node) => ['iframe', 'dialog', 'button'].includes(node.type))).toBe(false);
  });

  it('preserves TV trailer lookup identity', async () => {
    const fixture = await mount({ tmdbId: '900002', type: 'tv' }); enter(fixture); await advance(650);
    expect(hooks.load.mock.calls[0]![0]).toMatchObject({ tmdbId: '900002', type: 'tv' });
  });

  it('cancels the dwell on a quick leave without requesting metadata', async () => {
    const fixture = await mount(); enter(fixture); await advance(649); leave(fixture); await advance(1_000);
    expect(hooks.load).not.toHaveBeenCalled(); expect(fixture.node).toBeUndefined(); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['touch', 'coarse pointer', 'reduced motion', 'data saver', 'slow-2g', '2g', 'hidden', 'invalid identity'])('opts out for %s', async (reason) => {
    if (reason === 'coarse pointer') pointer.matches = false;
    if (reason === 'reduced motion') motion.matches = true;
    if (reason === 'data saver') connection.saveData = true;
    if (['slow-2g', '2g'].includes(reason)) connection.effectiveType = reason;
    if (reason === 'hidden') page.visibilityState = 'hidden';
    const fixture = await mount(reason === 'invalid identity' ? {} : undefined);
    enter(fixture, reason === 'touch' ? 'touch' : 'mouse'); await advance(1_000);
    expect(hooks.load).not.toHaveBeenCalled(); expect(fixture.node).toBeUndefined(); expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the poster until actual playback, not merely a loaded frame', async () => {
    const fixture = await mount(); enter(fixture); await advance(650);
    mediaEvent(fixture.node, fixture.media, 'LoadedData'); await flush(); expect(hasLabel(fixture)).toBe(false);
    mediaEvent(fixture.node, fixture.media, 'Playing'); await flush(); expect(hasLabel(fixture)).toBe(true);
  });

  it.each(['rejection', 'synchronous exception'])('quietly releases media on play() %s', async (reason) => {
    const fixture = await mount();
    if (reason === 'rejection') fixture.play.mockRejectedValueOnce(new Error('Synthetic autoplay denial'));
    else fixture.play.mockImplementationOnce(() => { throw new Error('Synthetic unsupported media'); });
    enter(fixture); await advance(650);
    expectReleased(fixture.mediaHistory[0]); expect(hooks.load.mock.calls[0]![1].aborted).toBe(true);
    expect(fixture.node).toBeUndefined(); expect(hasLabel(fixture)).toBe(false); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['unavailable', 'rejected'])('releases ownership after %s metadata', async (reason) => {
    if (reason === 'unavailable') hooks.load.mockResolvedValueOnce(null);
    else hooks.load.mockRejectedValueOnce(new Error('Synthetic metadata failure'));
    const fixture = await mount(); enter(fixture); await advance(650);
    expect(fixture.node).toBeUndefined(); expect(hooks.load.mock.calls[0]![1].aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['leave', 'hidden', 'offscreen', 'unmount'])('aborts pending metadata on %s and ignores its late response', async (reason) => {
    const request = deferred<TrailerInfo | null>(); hooks.load.mockReturnValueOnce(request.promise);
    const fixture = await mount(); enter(fixture); await advance(650);
    if (reason === 'leave') leave(fixture);
    if (reason === 'hidden') { page.visibilityState = 'hidden'; page.dispatchEvent(new Event('visibilitychange')); }
    if (reason === 'offscreen') intersection(fixture, 0);
    if (reason === 'unmount') unmount(fixture);
    expect(hooks.load.mock.calls[0]![1].aborted).toBe(true); request.resolve(info); await flush();
    expect(fixture.node == null).toBe(true); expect(fixture.mediaHistory).toHaveLength(0); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['leave', 'hidden', 'offscreen', 'unmount', 'media error'])('pauses, unloads and resets active video on %s', async (reason) => {
    const fixture = await mount(); enter(fixture); await advance(650); const media = fixture.media;
    mediaEvent(fixture.node, media, 'Playing'); await flush();
    if (reason === 'leave') leave(fixture);
    if (reason === 'hidden') { page.visibilityState = 'hidden'; page.dispatchEvent(new Event('visibilitychange')); }
    if (reason === 'offscreen') intersection(fixture, 0);
    if (reason === 'unmount') unmount(fixture);
    if (reason === 'media error') mediaEvent(fixture.node, media, 'Error');
    await flush(); expectReleased(media); expect(hooks.load.mock.calls[0]![1].aborted).toBe(true);
    expect(fixture.node == null).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });

  it('never starts a preview while the observed card remains offscreen or below its visibility threshold', async () => {
    const fixture = await mount(); intersection(fixture, 0); enter(fixture); await advance(650);
    intersection(fixture, 0.1); enter(fixture); await advance(650); expect(hooks.load).not.toHaveBeenCalled();
    intersection(fixture, 1); enter(fixture); await advance(650); expect(hooks.load).toHaveBeenCalledOnce();
  });

  it('rechecks live opt-outs during dwell, metadata lookup and playback', async () => {
    const fixture = await mount(); enter(fixture); await advance(300);
    motion.matches = true; motion.dispatchEvent(new Event('change')); await advance(650); expect(hooks.load).not.toHaveBeenCalled();
    motion.matches = false; motion.dispatchEvent(new Event('change'));
    const request = deferred<TrailerInfo | null>(); hooks.load.mockReturnValueOnce(request.promise); enter(fixture); await advance(650);
    connection.saveData = true; connection.dispatchEvent(new Event('change')); expect(hooks.load.mock.calls[0]![1].aborted).toBe(true);
    request.resolve(info); await flush(); expect(fixture.node).toBeUndefined();
    connection.saveData = false; connection.dispatchEvent(new Event('change')); enter(fixture); await advance(650);
    const media = fixture.media; pointer.matches = false; pointer.dispatchEvent(new Event('change')); await flush();
    expectReleased(media); expect(fixture.node).toBeUndefined(); expect(vi.getTimerCount()).toBe(0);
  });

  it('hands ownership to a second card and fences the first card response', async () => {
    const request = deferred<TrailerInfo | null>(); hooks.load.mockReturnValueOnce(request.promise);
    const first = await mount(); const second = await mount({ imdbId: 'tt9000002' });
    enter(first); await advance(650); enter(second); expect(hooks.load.mock.calls[0]![1].aborted).toBe(true); await advance(650);
    request.resolve(info); await flush(); expect(first.node).toBeUndefined(); expect(second.media.play).toHaveBeenCalledOnce();
    expect(fixtures.filter((fixture) => fixture.node)).toHaveLength(1);
  });

  it('stops the earlier active card synchronously before another card finishes its dwell', async () => {
    const first = await mount(); const second = await mount({ imdbId: 'tt9000002' }); enter(first); await advance(650);
    const media = first.media; enter(second); expectReleased(media); expect(hooks.load.mock.calls[0]![1].aborted).toBe(true);
    await advance(649); expect(second.node).toBeUndefined(); await advance(1);
    expect(fixtures.filter((fixture) => fixture.node)).toHaveLength(1); expect(second.media.play).toHaveBeenCalledOnce();
  });

  it.each(['resolution', 'rejection'])('isolates keyed re-hover media from old events and late play %s without an intermediate empty commit', async (settlement) => {
    const fixture = await mount(); const play = deferred<void>(); fixture.play.mockReturnValueOnce(play.promise);
    enter(fixture); await advance(650); const oldNode = fixture.node; const oldMedia = fixture.media;
    leave(fixture); enter(fixture); await advance(650); const currentMedia = fixture.media;
    expect(currentMedia).not.toBe(oldMedia); expect(fixture.node.key).not.toBe(oldNode.key);
    mediaEvent(oldNode, oldMedia, 'Error'); mediaEvent(oldNode, oldMedia, 'LoadedData'); mediaEvent(oldNode, oldMedia, 'Playing'); await flush();
    expect(fixture.media).toBe(currentMedia); expect(hasLabel(fixture)).toBe(false);
    if (settlement === 'resolution') play.resolve(); else play.reject(new Error('Late old-play rejection'));
    await flush(); expectReleased(oldMedia); expect(currentMedia.pause).not.toHaveBeenCalled();
    mediaEvent(fixture.node, currentMedia, 'Playing'); await flush(); expect(hasLabel(fixture)).toBe(true);
  });

  it('drops the old source on a lookup change before effects, without loading the new source until hover', async () => {
    const fixture = await mount(); enter(fixture); await advance(650); const oldNode = fixture.node; const oldMedia = fixture.media;
    mediaEvent(oldNode, oldMedia, 'Playing'); await flush();
    fixture.props = { tmdbId: '900002', type: 'tv' }; render(fixture);
    expect(fixture.node).toBeUndefined(); await flush(); expectReleased(oldMedia);
    expect(hooks.load).toHaveBeenCalledOnce(); enter(fixture); await advance(650);
    mediaEvent(oldNode, oldMedia, 'Error'); await flush(); expect(fixture.node.props.src).toBe(info.previewUrl);
    expect(hasLabel(fixture)).toBe(false); expect(hooks.load.mock.calls[1]![0]).toMatchObject({ tmdbId: '900002', type: 'tv' });
  });

  it('caps looping playback at 30 seconds and cleans subscriptions when removed', async () => {
    const fixture = await mount(); enter(fixture); await advance(650); const media = fixture.media;
    await advance(29_999); expect(fixture.node).toBeDefined(); await advance(1);
    expectReleased(media); expect(fixture.node).toBeUndefined(); expect(vi.getTimerCount()).toBe(0);
    await advance(30_000); expect(hooks.load).toHaveBeenCalledOnce();
    unmount(fixture); expect(observers[0]!.disconnect).toHaveBeenCalledOnce(); enter(fixture); await advance(1_000);
    expect(hooks.load).toHaveBeenCalledOnce();
  });

  it('keeps preview below subsequent artwork overlays without intercepting the title link', () => {
    const stylesheet = readFileSync(new URL('../../src/features/catalog/components/TrailerPreview.module.css', import.meta.url), 'utf8');
    const preview = stylesheet.match(/\.preview\s*\{[^}]*\}/)?.[0];
    expect(preview).toContain('z-index: 0;'); expect(preview).toContain('pointer-events: none;');
  });
});
