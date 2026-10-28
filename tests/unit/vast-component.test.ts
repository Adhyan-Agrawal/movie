import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import type { VastCreative } from '@/features/ads/vast/types';
import type { VastAdBreakProps } from '@/features/ads/vast/VastAdBreak';

type Effect = { setup: () => void | (() => void); deps?: readonly unknown[]; cleanup?: () => void; pending: boolean };
// Exercise lifecycle/media handlers without installing a DOM or contacting an ad server.
const hooks = vi.hoisted(() => ({
  refs: [] as Array<{ current: unknown }>, states: [] as unknown[], effects: [] as Effect[],
  refIndex: 0, stateIndex: 0, effectIndex: 0, consent: true, beacons: [] as string[],
}));
vi.mock('@/components/consent/ConsentBanner', () => ({ readConsent: () => ({ ads: hooks.consent }) }));
vi.mock('react', async (importOriginal) => ({
  ...await importOriginal<typeof import('react')>(),
  useRef: <T>(value: T) => {
    const index = hooks.refIndex++;
    if (!hooks.refs[index]) hooks.refs[index] = { current: value };
    return hooks.refs[index];
  },
  useState: <T>(value: T) => {
    const index = hooks.stateIndex++;
    if (index >= hooks.states.length) hooks.states[index] = value;
    return [hooks.states[index], (next: T | ((previous: T) => T)) => {
      hooks.states[index] = typeof next === 'function' ? (next as (previous: T) => T)(hooks.states[index] as T) : next;
    }];
  },
  useEffect: (setup: Effect['setup'], deps?: readonly unknown[]) => {
    const index = hooks.effectIndex++;
    const old = hooks.effects[index];
    const changed = !old || !deps || !old.deps || deps.some((value, key) => !Object.is(value, old.deps?.[key]));
    hooks.effects[index] = { setup, deps, cleanup: old?.cleanup, pending: changed };
  },
}));
import { VastAdBreak } from '@/features/ads/vast/VastAdBreak';

const POLICY = { enabled: true, firstBreakSeconds: 60, intervalSeconds: 60, maxBreaks: 2, allowSkip: true, skipAfterSeconds: 5 };
const CREATIVE: VastCreative = {
  id: 'fixture', mediaUrl: 'https://ads.example.com/ad.mp4', durationSeconds: 40, skipAfterSeconds: 5,
  tracking: {
    impression: ['https://ads.example.com/impression'], start: ['https://ads.example.com/start'],
    firstQuartile: ['https://ads.example.com/q1'], midpoint: ['https://ads.example.com/q2'],
    thirdQuartile: ['https://ads.example.com/q3'], complete: ['https://ads.example.com/complete'],
    skip: ['https://ads.example.com/skip'], error: ['https://ads.example.com/error'],
  },
  clickThrough: 'https://ads.example.com/learn', clickTracking: ['https://ads.example.com/click'],
};

let props: VastAdBreakProps;
let tree: ReactElement;
let media: { src: string; volume: number; muted: boolean; pause: ReturnType<typeof vi.fn>; load: ReturnType<typeof vi.fn>;
  play: ReturnType<typeof vi.fn>; removeAttribute: ReturnType<typeof vi.fn> };

function elements(value: ReactNode): Array<ReactElement<Record<string, unknown>>> {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(value)) return [];
  return [value, ...elements(value.props.children as ReactNode)];
}
function find(type: string, label?: string) {
  const element = elements(tree).find((entry) => entry.type === type && (!label || entry.props['aria-label'] === label));
  if (!element) throw new Error(`Missing ${type} ${label ?? ''}`);
  return element;
}
function fire(type: string, handler: string, event: unknown = undefined, label?: string) {
  const action = find(type, label).props[handler];
  if (typeof action !== 'function') throw new Error(`Missing ${handler}`);
  action(event);
}
function render() {
  hooks.refIndex = 0; hooks.stateIndex = 0; hooks.effectIndex = 0;
  tree = VastAdBreak(props);
  (find('video').props.ref as { current: unknown }).current = media;
  for (const effect of hooks.effects) if (effect.pending) {
    effect.cleanup?.();
    const cleanup = effect.setup();
    effect.cleanup = typeof cleanup === 'function' ? cleanup : undefined;
    effect.pending = false;
  }
}
function time(position: number) { fire('video', 'onTimeUpdate', { currentTarget: { currentTime: position } }); render(); }
function unmount() { for (const effect of hooks.effects) { effect.cleanup?.(); effect.cleanup = undefined; } }

beforeEach(() => {
  vi.useFakeTimers(); hooks.refs = []; hooks.states = []; hooks.effects = []; hooks.consent = true; hooks.beacons = [];
  props = { creative: CREATIVE, policy: POLICY, onDone: vi.fn() };
  media = { src: '', volume: 1, muted: false, pause: vi.fn(), load: vi.fn(), play: vi.fn().mockResolvedValue(undefined),
    removeAttribute: vi.fn(() => { media.src = ''; }) };
  vi.stubGlobal('Image', class { referrerPolicy = ''; set src(value: string) { hooks.beacons.push(value); } });
});
afterEach(() => { unmount(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('isolated VAST advertisement lifecycle', () => {
  it('loads only its own video and completes once after stopping it', () => {
    const content = { positionSeconds: 21.125, pendingSync: true, playing: true };
    props.onDone = vi.fn(() => { expect(media.pause).toHaveBeenCalled(); expect(media.src).toBe(''); });
    render();
    expect(media.src).toBe(CREATIVE.mediaUrl);
    expect(find('video').props.src).toBeUndefined();
    expect(find('video').props.playsInline).toBe(true);
    fire('video', 'onPlaying'); time(10); time(20); time(30);
    fire('video', 'onEnded'); fire('video', 'onError'); fire('video', 'onEnded');
    expect(props.onDone).toHaveBeenCalledExactlyOnceWith('complete');
    expect(hooks.beacons).toEqual(Object.values(CREATIVE.tracking).slice(0, 6).flat());
    expect(content).toEqual({ positionSeconds: 21.125, pendingSync: true, playing: true });
  });

  it('fires each quartile and URL once despite repeated playback events and backward ad time', () => {
    props.creative = { ...CREATIVE, tracking: { ...CREATIVE.tracking, start: CREATIVE.tracking.impression } };
    render(); fire('video', 'onPlaying'); fire('video', 'onPlaying');
    for (const position of [10, 10, 1, 20, 20, 30, 30]) time(position);
    expect(hooks.beacons).toEqual(['https://ads.example.com/impression', 'https://ads.example.com/q1', 'https://ads.example.com/q2', 'https://ads.example.com/q3']);
  });

  it('has an accessible skip countdown driven only by ad media time', async () => {
    render();
    expect(find('button', 'Skip advertisement').props.disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    render();
    expect(find('button', 'Skip advertisement').props.disabled).toBe(true);
    fire('button', 'onClick', undefined, 'Skip advertisement');
    expect(props.onDone).not.toHaveBeenCalled();
    time(5);
    expect(find('button', 'Skip advertisement').props.disabled).toBe(false);
    fire('button', 'onClick', undefined, 'Skip advertisement'); fire('video', 'onEnded');
    expect(props.onDone).toHaveBeenCalledExactlyOnceWith('skip');
    expect(hooks.beacons.filter((url) => url.endsWith('/skip'))).toHaveLength(1);
  });

  it('dispatches only the optional skip or error callback, never a second onDone callback', () => {
    props.onSkip = vi.fn(); props.onError = vi.fn();
    render(); time(5); fire('button', 'onClick', undefined, 'Skip advertisement'); fire('video', 'onError');
    expect(props.onSkip).toHaveBeenCalledOnce();
    expect(props.onError).not.toHaveBeenCalled(); expect(props.onDone).not.toHaveBeenCalled();
  });

  it('does not load media or send a beacon without persistent advertising consent', () => {
    hooks.consent = false; props.onError = vi.fn();
    render();
    expect(media.play).not.toHaveBeenCalled(); expect(media.src).toBe('');
    expect(hooks.beacons).toEqual([]);
    expect(props.onError).toHaveBeenCalledOnce(); expect(props.onDone).not.toHaveBeenCalled();
  });

  it.each(['disabled', 'declined'])('does not perform media or tracking requests when %s', (state) => {
    if (state === 'disabled') props.policy = { ...POLICY, enabled: false };
    else props.consent = false;
    render(); fire('video', 'onPlaying'); fire('video', 'onEnded');
    expect(media.play).not.toHaveBeenCalled(); expect(media.src).toBe(''); expect(hooks.beacons).toEqual([]);
    expect(props.onDone).toHaveBeenCalledExactlyOnceWith('error');
  });

  it('does not render a Skip action when either policy or creative forbids skipping', () => {
    props.policy = { ...POLICY, allowSkip: false }; render();
    expect(elements(tree).some((entry) => entry.props['aria-label'] === 'Skip advertisement')).toBe(false);
    props = { ...props, policy: POLICY, creative: { ...CREATIVE, skipAfterSeconds: null } }; render();
    expect(elements(tree).some((entry) => entry.props['aria-label'] === 'Skip advertisement')).toBe(false);
  });

  it('honors explicit consent withdrawal and blocks clicks and all later tracking', () => {
    render(); fire('video', 'onPlaying');
    hooks.consent = false;
    const preventDefault = vi.fn(); fire('a', 'onClick', { preventDefault });
    expect(preventDefault).toHaveBeenCalled();
    time(10); fire('video', 'onEnded');
    expect(props.onDone).toHaveBeenCalledExactlyOnceWith('error');
    expect(hooks.beacons).toEqual(['https://ads.example.com/impression', 'https://ads.example.com/start']);
  });

  it.each(['javascript:alert(1)', 'data:text/html,evil', 'http://ads.example.com/x', 'https://127.0.0.1/x',
    'https://localhost/x', 'https://user:secret@ads.example.com/x'])('does not render unsafe click target %s', (clickThrough) => {
    props.creative = { ...CREATIVE, clickThrough };
    render();
    expect(elements(tree).some((entry) => entry.type === 'a')).toBe(false);
  });

  it('opens click-through only on viewer action and sends safe click GETs at most once', () => {
    props.creative = { ...CREATIVE, clickTracking: ['https://ads.example.com/click', 'https://ads.example.com/click', 'javascript:alert(1)'] };
    render(); expect(hooks.beacons).toEqual([]);
    expect(find('a').props).toMatchObject({ target: '_blank', rel: 'noopener noreferrer', referrerPolicy: 'no-referrer' });
    fire('a', 'onClick', { preventDefault: vi.fn() }); fire('a', 'onClick', { preventDefault: vi.fn() });
    expect(hooks.beacons).toEqual(['https://ads.example.com/click']);
    expect(props.onDone).not.toHaveBeenCalled();
  });

  it('does not timeout a healthy longer ad at fifteen seconds, but bounds a subsequent stall', async () => {
    render(); fire('video', 'onPlaying');
    for (let second = 1; second <= 20; second++) { await vi.advanceTimersByTimeAsync(1000); time(second); }
    expect(props.onDone).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15001);
    expect(props.onDone).toHaveBeenCalledExactlyOnceWith('error');
  });

  it('bounds rejected autoplay while offering an explicit Play advertisement button', async () => {
    media.play.mockRejectedValueOnce(new Error('Autoplay blocked'));
    render(); await Promise.resolve(); render();
    expect(elements(tree).some((entry) => entry.type === 'button' && entry.props.className === 'lumora-vast-play')).toBe(true);
    await vi.advanceTimersByTimeAsync(15001);
    expect(props.onDone).toHaveBeenCalledExactlyOnceWith('error');
  });

  it('cleans up timeout and media work without firing late callbacks after unmount', async () => {
    render(); unmount();
    fire('video', 'onError'); fire('video', 'onEnded'); fire('video', 'onPlaying'); fire('video', 'onWaiting');
    await vi.advanceTimersByTimeAsync(100_000);
    expect(props.onDone).not.toHaveBeenCalled(); expect(hooks.beacons).toEqual([]);
    expect(media.pause).toHaveBeenCalled(); expect(media.src).toBe('');
  });

  it('survives Strict Mode effect replay without duplicate impressions or terminal callbacks', () => {
    render(); fire('video', 'onPlaying');
    for (const effect of hooks.effects) { effect.cleanup?.(); const cleanup = effect.setup(); effect.cleanup = typeof cleanup === 'function' ? cleanup : undefined; }
    fire('video', 'onPlaying'); fire('video', 'onEnded');
    expect(hooks.beacons.filter((url) => url.endsWith('/impression'))).toHaveLength(1);
    expect(props.onDone).toHaveBeenCalledExactlyOnceWith('complete');
  });

  it('uses the latest parent callback and never restarts media solely for callback or volume changes', () => {
    render(); const old = props.onDone;
    props = { ...props, onDone: vi.fn(), volume: 0.25, muted: true }; render();
    expect(media.play).toHaveBeenCalledOnce(); expect(media.volume).toBe(0.25); expect(media.muted).toBe(true);
    fire('video', 'onEnded');
    expect(old).not.toHaveBeenCalled(); expect(props.onDone).toHaveBeenCalledExactlyOnceWith('complete');
  });
});
