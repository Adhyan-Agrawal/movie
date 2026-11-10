import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { readFileSync } from 'node:fs';
import type { CastingHandle, CastingProgress } from '@/features/player/casting';
import type { NativePlayerProps } from '@/features/player/NativePlayer';
import type { DirectStream } from '@/lib/providers/types';
import type { PartyPlayerIntent, PartyPlayerPort, PartyPlayerTarget } from '@/features/watch-party/web/player-port';
import type { WatchPartyMediaIdentity } from '@/features/watch-party/protocol';
import { readConsent, writeConsent } from '@/lib/consent';
import type { VastAdBreakProps } from '@/features/ads/vast/VastAdBreak';
import { DEFAULT_SETTINGS } from '@/features/account/types';

// A commit/effect harness exercises the mounted component without a DOM dependency or network.
const harness = vi.hoisted(() => ({
  slots: [] as Array<{ value?: unknown; deps?: unknown[]; cleanup?: () => void }>,
  cursor: 0, dirty: false, effects: [] as Array<() => void>,
  players: [] as any[], events: [] as string[], checkpoint: null as any, createFailures: 0,
  write: vi.fn(), report: vi.fn(), casting: vi.fn(), adUpdate: vi.fn(), fetch: vi.fn(),
  storageGet: vi.fn(), storageSet: vi.fn(), storageRemove: vi.fn(), exitPictureInPicture: vi.fn(), navigate: vi.fn(),
  consentRaw: null as string | null, mountVast: false, tracking: [] as string[],
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
  playbackMediaKey: (title: string, episodeId?: string, season?: number, episode?: number) => season !== undefined && episode !== undefined
    ? `fixture-media:${title}:${season}:${episode}` : `fixture-media${title === 'fixture' ? '' : `:${title}`}${episodeId ? `:${episodeId}` : ''}`,
  readPlaybackCheckpoint: () => harness.checkpoint,
  writePlaybackCheckpoint: harness.write, markPlaybackCheckpointSynced: vi.fn(),
}));
vi.mock('@/features/player/fullscreen-orientation', () => ({ createFullscreenOrientation: () => ({ setFullscreen: vi.fn(), dispose: vi.fn() }) }));
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
  if (harness.createFailures > 0) { harness.createFailures -= 1; throw new Error('Player initialization failed'); }
  const listeners = new Map<string, Array<() => void>>();
  const eventList = () => {
    const events = new Map<string, Set<() => void>>();
    return { length: 0, on: vi.fn((event: string, listener: () => void) => events.set(event, new Set([...(events.get(event) ?? []), listener]))),
      off: vi.fn((event: string, listener: () => void) => events.get(event)?.delete(listener)),
      emit(event: string) { for (const listener of events.get(event) ?? []) listener(); } } as any;
  };
  const qualityList = eventList(); const audioList = eventList(); const textList = eventList();
  const element = new FakeElement();
  const player: any = {
    position: 0, seconds: 120, rate: 1, loudness: 1, silenced: false, stopped: true, readiness: 0, isSeeking: false, hasEnded: false, disposed: false, isPip: false, fullscreen: false, failure: null,
    url: options.sources[0]?.src ?? '', options, qualityList, audioList, textList,
    doubleClick: options.userActions.doubleClick,
    emit(event: string) { for (const listener of listeners.get(event) ?? []) listener(); },
    on(event: string | string[], listener: () => void) {
      for (const key of typeof event === 'string' ? [event] : event) listeners.set(key, [...(listeners.get(key) ?? []), listener]);
    },
    off(event: string, listener: () => void) { listeners.set(event, (listeners.get(event) ?? []).filter((value) => value !== listener)); },
    el: () => element, qualityLevels: () => qualityList, audioTracks: () => audioList, textTracks: () => textList,
    currentTime: vi.fn((position?: number) => {
      if (position === undefined) return player.position;
      harness.events.push(`seek:${position}`);
      player.isSeeking = true; player.emit('seeking'); player.position = position;
      player.emit('timeupdate'); player.isSeeking = false; player.emit('seeked');
      return player;
    }),
    duration: () => player.seconds, paused: () => player.stopped, seeking: () => player.isSeeking, ended: () => player.hasEnded,
    readyState: () => player.readiness, isDisposed: () => player.disposed,
    error: (failure?: unknown) => { if (failure !== undefined) player.failure = failure; return player.failure; },
    playbackRate: (rate?: number) => {
      if (rate !== undefined && rate !== player.rate) { player.rate = rate; player.emit('ratechange'); }
      return player.rate;
    },
    pause: vi.fn(() => { player.stopped = true; player.emit('pause'); }),
    play: vi.fn(async () => { player.stopped = false; player.emit('play'); player.emit('playing'); }),
    src: vi.fn((source: { src: string }) => {
      player.url = source.src; player.readiness = 0; player.failure = null;
      player.position = 0; player.rate = 1; player.stopped = true;
      for (const list of [qualityList, audioList, textList]) {
        for (let index = 0; index < list.length; index += 1) delete list[index];
        list.length = 0;
      }
      player.emit('loadstart');
    }),
    volume: vi.fn((value?: number) => { if (value === undefined) return player.loudness; player.loudness = value; return player; }),
    muted: vi.fn((value?: boolean) => { if (value === undefined) return player.silenced; player.silenced = value; return player; }),
    controls: vi.fn(), userActive: vi.fn(),
    addRemoteTextTrack: vi.fn(() => {
      const remote = new FakeElement() as FakeElement & { track: Record<string, unknown> };
      remote.track = { id: 'presentation', label: 'Presentation', language: 'und', kind: 'subtitles', mode: 'disabled', cues: null, addCue: vi.fn(), removeCue: vi.fn() };
      return remote;
    }),
    removeRemoteTextTrack: vi.fn(),
    disablePictureInPicture: vi.fn(),
    isInPictureInPicture: (active?: boolean) => { if (active !== undefined) { player.isPip = active; return; } return player.isPip; },
    requestPictureInPicture: vi.fn(async () => {
      const result = await (video as FakeVideo & { requestPictureInPicture: () => Promise<unknown> }).requestPictureInPicture();
      player.isPip = true; player.emit('enterpictureinpicture'); return result;
    }),
    exitPictureInPicture: vi.fn(async () => {
      await harness.exitPictureInPicture(); player.isPip = false; player.emit('leavepictureinpicture');
    }),
    ready: (callback: () => void) => { player.readyCallback = callback; callback(); }, isFullscreen: () => player.fullscreen,
    requestFullscreen: vi.fn(async () => { harness.events.push('fullscreen'); player.fullscreen = true; player.emit('fullscreenchange'); }),
    exitFullscreen: vi.fn(() => { player.fullscreen = false; player.emit('fullscreenchange'); }),
    dispose: vi.fn(() => { harness.events.push('dispose'); player.disposed = true; }),
  };
  harness.players.push(player);
  return player;
} }));

class FakeClassList {
  values = new Set<string>();
  toggle(value: string, force?: boolean) {
    if (force === true) this.values.add(value);
    else if (force === false) this.values.delete(value);
    else if (this.values.has(value)) this.values.delete(value);
    else this.values.add(value);
    return this.values.has(value);
  }
  contains(value: string) { return this.values.has(value); }
}
class FakeElement {
  className = '';
  current: unknown;
  classList = new FakeClassList();
  attributes = new Map<string, string>();
  closestMatch: string | null = null;
  click = vi.fn();
  listeners = new Map<string, Set<(event: Event) => void>>();
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  appendChild() {}
  remove() {}
  addEventListener(type: string, listener: (event: Event) => void) { this.listeners.set(type, new Set([...(this.listeners.get(type) ?? []), listener])); }
  removeEventListener(type: string, listener: (event: Event) => void) { this.listeners.get(type)?.delete(listener); }
  emit(type: string, event: Record<string, unknown> = {}) {
    const payload = { type, target: this, ...event } as unknown as Event;
    for (const listener of this.listeners.get(type) ?? []) listener(payload);
  }
  focus() { (globalThis.document as unknown as { activeElement: unknown }).activeElement = this; }
  closest(selector: string) { return this.closestMatch && selector.includes(this.closestMatch) ? this : null; }
  querySelector() { return video; }
}
class FakeVideo extends FakeElement { controlsList = { add: vi.fn() }; disablePictureInPicture = false; playsInline = false; }
class AdVideo extends FakeElement {
  src = ''; currentTime = 0; volume = 1; muted = false;
  play = vi.fn(async () => {}); pause = vi.fn(); load = vi.fn();
  removeAttribute(name: string) { this.attributes.delete(name); if (name === 'src') this.src = ''; }
}
const CONSENT_KEY = 'lumora.consent.v1';
const AD_GRANT = { necessary: true as const, analytics: false, ads: true, decidedAt: '2026-11-07T12:00:00.000Z' };
let actualVast: (props: VastAdBreakProps) => unknown;
let adKey: string | null = null;
let adTree: any = null;
let adVideo: AdVideo | null = null;
let video: FakeVideo;
let fakeDocument: Record<string, any>;
let NativePlayer: typeof import('@/features/player/NativePlayer')['NativePlayer'];
let props: NativePlayerProps;
let tree: any;
const container = new FakeElement();
const INTRO_URL = '/api/intro?episode=1';
const PING_KEY = 'lumora:player:show-ping:v1';

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
  const parentSlots = harness.cursor;
  const ad = harness.mountVast ? nodes().find((node) => node.props?.creative && node.props?.onDone) : undefined;
  if ((ad?.key ?? null) !== adKey) {
    for (const slot of harness.slots.slice(parentSlots)) slot?.cleanup?.();
    harness.slots.length = parentSlots;
    adKey = ad?.key ?? null;
    adVideo = ad ? new AdVideo() : null;
  }
  adTree = ad ? actualVast(ad.props) : null;
  const adElement = nodes(adTree).find((node) => node.type === 'video');
  if (adElement) adElement.props.ref.current = adVideo;
  for (const node of nodes()) {
    if (node.props?.['data-vjs-player'] !== undefined) node.props.ref.current = container;
    if (node.type === 'a' && node.props?.['data-player-up-next'] !== undefined && node.props.ref) {
      node.props.ref.current = { click: harness.navigate };
    }
  }
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
function settingsButton() { return nodes().find((node) => node.type === 'button' && node.props?.['aria-label'] === 'Settings'); }
function presentationButton(prefix: string) { return nodes().find((node) => String(node.props?.actionLabel ?? '').startsWith(prefix)); }
function pingBadge() { return nodes().find((node) => node.type === 'output' && node.props?.className?.includes('lumora-player-ping')); }
function healthCalls() { return harness.fetch.mock.calls.filter(([url]) => url === '/api/health'); }
function keydown(key: string, input: Omit<Partial<KeyboardEvent>, 'target'> & { target?: EventTarget | FakeElement | null } = {}) {
  const event: any = {
    key, target: input.target ?? player().el(), defaultPrevented: false, altKey: false, ctrlKey: false, metaKey: false,
    shiftKey: false, isComposing: false, preventDefault: vi.fn(function (this: { defaultPrevented: boolean }) { this.defaultPrevented = true; }),
    stopImmediatePropagation: vi.fn(), ...input,
  };
  player().el().emit('keydown', event);
  return event;
}
function installSubtitle() {
  const track = { id: 'captions-en', label: 'English', language: 'en', kind: 'subtitles', mode: 'disabled', cues: null, addCue: vi.fn(), removeCue: vi.fn() };
  player().textList[0] = track; player().textList.length = 1;
  player().textList.emit('addtrack');
  return track;
}
async function openSettings() {
  if (!nodes().some((node) => node.props?.role === 'region' && node.props?.['aria-label'] === 'Settings settings')) {
    settingsButton().props.onClick({ currentTarget: new FakeElement() });
    await pump();
  }
}
function enableStandardPictureInPicture(request: () => Promise<unknown> = vi.fn(async () => undefined)) {
  fakeDocument.pictureInPictureEnabled = true;
  (video as FakeVideo & { requestPictureInPicture: () => Promise<unknown> }).requestPictureInPicture = request;
  player().emit('techchange');
  return request;
}
async function remount() {
  for (const slot of harness.slots) slot?.cleanup?.();
  harness.slots = []; harness.effects = []; harness.players = []; harness.cursor = 0; harness.dirty = false;
  fakeDocument.pictureInPictureElement = null;
  video = new FakeVideo();
  render(); await pump();
}
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
  harness.dirty = false; harness.events = []; harness.checkpoint = null; harness.receiverProgress = null; harness.receiverDisconnect = null; harness.createFailures = 0;
  vi.clearAllMocks(); vi.useFakeTimers();
  harness.mountVast = false; harness.tracking = []; adKey = null; adTree = null; adVideo = null;
  harness.consentRaw = JSON.stringify(AD_GRANT);
  harness.report.mockResolvedValue({ ok: false });
  harness.fetch.mockResolvedValue(response({ startSeconds: 0, endSeconds: 10.25 }));
  harness.casting.mockResolvedValue(null);
  harness.storageGet.mockReset().mockImplementation((key: string) => key === CONSENT_KEY ? harness.consentRaw : null);
  harness.storageSet.mockReset().mockImplementation((key: string, value: string) => { if (key === CONSENT_KEY) harness.consentRaw = value; });
  harness.storageRemove.mockReset().mockImplementation((key: string) => { if (key === CONSENT_KEY) harness.consentRaw = null; });
  video = new FakeVideo();
  vi.stubGlobal('fetch', harness.fetch);
  vi.stubGlobal('Element', FakeElement); vi.stubGlobal('HTMLVideoElement', FakeVideo);
  fakeDocument = { createElement: () => new FakeElement(), visibilityState: 'visible', activeElement: null, pictureInPictureEnabled: false, pictureInPictureElement: null, exitPictureInPicture: harness.exitPictureInPicture, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  vi.stubGlobal('document', fakeDocument);
  const consentEvents = new EventTarget();
  vi.stubGlobal('window', { location: { href: 'https://movies.example/watch', origin: 'https://movies.example' },
    localStorage: { getItem: harness.storageGet, setItem: harness.storageSet, removeItem: harness.storageRemove },
    addEventListener: vi.fn(consentEvents.addEventListener.bind(consentEvents)),
    removeEventListener: vi.fn(consentEvents.removeEventListener.bind(consentEvents)),
    dispatchEvent: consentEvents.dispatchEvent.bind(consentEvents) });
  vi.stubGlobal('Image', class { referrerPolicy = ''; set src(value: string) { harness.tracking.push(value); } });
  writeConsent(AD_GRANT);
  harness.storageGet.mockClear(); harness.storageSet.mockClear();
  vi.stubGlobal('navigator', { maxTouchPoints: 0, onLine: true });
  ({ NativePlayer } = await import('@/features/player/NativePlayer'));
  props = { source: { url: '/movie.mp4', kind: 'mp4' }, introCatalogUrl: INTRO_URL, titleId: 'fixture', titleSlug: 'fixture', viewerKey: 'guest' };
  render(); await pump();
});
afterEach(() => {
  for (const slot of harness.slots) slot?.cleanup?.();
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals();
});

describe('native account language and caption defaults', () => {
  const owner = '10000000-0000-4000-8000-000000000001';
  const saved = (language = 'en', captions = true) => ({ accountId: owner,
    settings: { ...DEFAULT_SETTINGS, language, captions, reducedMotion: true }, hasSavedPreferences: true });
  async function mount(language = 'en', captions = true, viewerKey = `account:${owner}:profile:one`) {
    props = { ...props, viewerKey, accountPreferences: saved(language, captions) }; await remount();
  }
  function tracks() {
    const english = { id: 'en', label: 'English', language: 'eng-US', enabled: false };
    const hindi = { id: 'hi', label: 'Hindi', language: 'hi', enabled: true };
    player().audioList[0] = english; player().audioList[1] = hindi; player().audioList.length = 2;
    const captions = installSubtitle();
    return { english, hindi, captions };
  }

  it('applies offered audio/captions without restarting media, seeking, or changing a party timeline', async () => {
    await mount(); const installed = tracks(); const sources = player().src.mock.calls.length;
    await ready(24, 120);
    expect(installed.english.enabled).toBe(true); expect(installed.hindi.enabled).toBe(false);
    expect(installed.captions.mode).toBe('hidden');
    expect(player().addRemoteTextTrack).toHaveBeenCalledWith(expect.objectContaining({ label: 'Lumora subtitle presentation' }), true);
    expect(player().src).toHaveBeenCalledTimes(sources); expect(player().position).toBe(24);
    expect(tree.props['data-viewing-motion']).toBe('reduce');
  });

  it('keeps automatic captions off without downloading sidecar payloads', async () => {
    await mount('en', false); const installed = tracks(); installed.captions.mode = 'showing';
    props = { ...props, subtitleCatalogUrl: '/synthetic-subtitles' };
    harness.fetch.mockResolvedValue(response({ tracks: [{ id: 'sidecar', label: 'English', language: 'en', kind: 'subtitles', url: '/synthetic.vtt' }] }));
    render(); await pump(); await ready();
    expect(installed.captions.mode).toBe('disabled');
    expect(player().addRemoteTextTrack.mock.calls.some(([track]: any[]) => Boolean(track.src))).toBe(false);
  });

  it('keeps unavailable language explicit instead of translating or choosing another video stream', async () => {
    await mount('ja'); const installed = tracks(); const sources = player().src.mock.calls.length;
    await ready(); await openSettings();
    expect(installed.hindi.enabled).toBe(true); expect(installed.english.enabled).toBe(false); expect(installed.captions.mode).toBe('disabled');
    expect(player().src).toHaveBeenCalledTimes(sources);
    expect(nodes().some((node) => node.props?.role === 'status' && String(node.props.children).includes('not offered by this native source'))).toBe(true);
  });

  it('applies late-arriving offered tracks without reloading playback', async () => {
    await mount(); await ready(); const sources = player().src.mock.calls.length;
    const installed = tracks(); player().audioList.emit('addtrack'); await pump();
    expect(installed.english.enabled).toBe(true); expect(installed.captions.mode).toBe('hidden');
    expect(player().src).toHaveBeenCalledTimes(sources);
  });

  it('preserves accepted explicit audio/caption choices across preference refreshes and source replacement', async () => {
    await mount(); const installed = tracks(); await ready();
    for (const [label, value] of [['Audio', 'hi::'], ['Subtitles', 'off']]) {
      nodes().find((node) => node.props?.label === label && node.props.onClick).props.onClick({ currentTarget: new FakeElement() });
      await pump();
      nodes().find((node) => node.props?.label === label && node.props.onChange).props.onChange(value);
      await pump();
    }
    props = { ...props, accountPreferences: saved('en', true) }; render(); await pump();
    expect(installed.hindi.enabled).toBe(true); expect(installed.captions.mode).toBe('disabled');
    props = { ...props, source: { url: '/another.mp4', kind: 'mp4' } }; render(); await pump(); await ready();
    expect(installed.hindi.enabled).toBe(true); expect(installed.captions.mode).toBe('disabled');
  });

  it.each(['guest', 'unavailable', 'account:another'])('does not apply another identity snapshot to %s', async (viewer) => {
    await mount('en', true, viewer); const installed = tracks(); await ready();
    expect(installed.hindi.enabled).toBe(true); expect(installed.captions.mode).toBe('disabled');
    expect(tree.props['data-viewing-motion']).toBeUndefined();
  });

  it('refreshes account defaults on the same media without reviving disposed source callbacks', async () => {
    await mount(); const installed = tracks(); await ready();
    props = { ...props, accountPreferences: saved('hi', false) }; render(); await pump();
    expect(installed.hindi.enabled).toBe(true); expect(installed.captions.mode).toBe('disabled');
    const old = player(); for (const slot of harness.slots) slot?.cleanup?.();
    const changes = old.src.mock.calls.length; old.audioList.emit('addtrack'); await pump();
    expect(old.src).toHaveBeenCalledTimes(changes);
  });
});

describe('mounted native ad consent withdrawal', () => {
  const policy = { enabled: true, firstBreakSeconds: 5, intervalSeconds: 10, maxBreaks: 4, allowSkip: true, skipAfterSeconds: 2 };
  const creative: VastAdBreakProps['creative'] = {
    id: 'repeat-creative', mediaUrl: 'https://ads.example.com/ad.mp4', durationSeconds: 20, skipAfterSeconds: 2,
    tracking: { impression: ['https://ads.example.com/impression'], start: ['https://ads.example.com/start'],
      complete: ['https://ads.example.com/complete'], error: ['https://ads.example.com/error'] },
  };
  const adNode = () => nodes().find((node) => node.props?.creative && node.props?.onDone);
  const videoNode = () => nodes(adTree).find((node) => node.type === 'video');
  const requests = () => harness.fetch.mock.calls.filter(([url]) => url === '/api/vast?consent=1');
  function storageEvent(key: string | null = CONSENT_KEY) {
    const event = new Event('storage');
    Object.defineProperties(event, { key: { value: key }, newValue: { value: JSON.stringify(AD_GRANT) } });
    window.dispatchEvent(event);
  }
  async function prepare(overrides: Partial<NativePlayerProps> = {}) {
    actualVast = (await vi.importActual<typeof import('@/features/ads/vast/VastAdBreak')>('@/features/ads/vast/VastAdBreak')).VastAdBreak;
    harness.mountVast = true;
    harness.fetch.mockImplementation((url: string) => Promise.resolve(url === '/api/vast?consent=1'
      ? Response.json({ creative }) : response({ startSeconds: 0, endSeconds: 10.25 })));
    props = { ...props, adPolicy: policy, ...overrides };
    await remount(); await ready(0, 180);
  }
  async function start(time = 6) {
    player().position = time; player().stopped = false; player().emit('timeupdate');
    await pump(); await vi.advanceTimersByTimeAsync(0); await pump();
  }

  it('stops the actual ad and tracking on same-tab withdrawal and restores content without changing preferences', async () => {
    await prepare(); const content = player();
    content.loudness = 0.35; content.silenced = true; content.playbackRate(1.5);
    content.qualityList[0] = { id: '720', enabled: true }; content.qualityList.length = 1;
    content.audioList[0] = { id: 'en', enabled: true }; content.audioList.length = 1;
    const subtitle = installSubtitle(); await pump();
    nodes().find((node) => node.props?.label === 'Subtitles' && node.props.onClick).props.onClick({ currentTarget: new FakeElement() }); await pump();
    nodes().find((node) => node.props?.label === 'Subtitles' && node.props.onChange).props.onChange('en::'); await pump();
    const sourceCalls = content.src.mock.calls.length;
    await start();
    const advertisement = adVideo!; const handlers = videoNode().props; const done = adNode().props.onDone;
    handlers.onPlaying(); expect(harness.tracking).toHaveLength(2);
    const signal = requests()[0]![1]!.signal as AbortSignal;
    expect(writeConsent({ ...AD_GRANT, ads: false })).toBe(true);
    expect(signal.aborted).toBe(true);
    await pump();
    expect(adNode()).toBeUndefined(); expect(adTree).toBeNull();
    expect(advertisement.pause).toHaveBeenCalled(); expect(advertisement.load).toHaveBeenCalled(); expect(advertisement.src).toBe('');
    expect(content.position).toBe(6); expect(content.stopped).toBe(false); expect(content.rate).toBe(1.5);
    expect(content.loudness).toBe(0.35); expect(content.silenced).toBe(true); expect(content.src).toHaveBeenCalledTimes(sourceCalls);
    expect(content.qualityList[0].enabled).toBe(true); expect(content.audioList[0].enabled).toBe(true); expect(subtitle.mode).toBe('hidden');
    handlers.onPlaying(); handlers.onEnded(); done('complete'); await pump(); expect(harness.tracking).toHaveLength(2);
    await start(16); await start(26); expect(requests()).toHaveLength(1); expect(adNode()).toBeUndefined();
  });

  it.each(['removed', 'cleared', 'malformed', 'inaccessible', 'failed-persistence'])('fails closed for %s consent, not event payload grants', async (kind) => {
    await prepare(); await start(); const advertisement = adVideo!;
    if (kind === 'failed-persistence') {
      harness.storageRemove.mockImplementationOnce(() => { throw new Error('blocked storage'); });
      expect(writeConsent(null)).toBe(false); expect(harness.consentRaw).toBe(JSON.stringify(AD_GRANT));
    } else if (kind === 'inaccessible') {
      Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new Error('blocked getter'); } });
      window.dispatchEvent(new Event('focus'));
    } else {
      harness.consentRaw = kind === 'malformed' ? '{"ads":true}' : null;
      storageEvent(kind === 'cleared' ? null : CONSENT_KEY);
    }
    expect(readConsent()).toBeNull(); await pump();
    expect(adNode()).toBeUndefined(); expect(advertisement.src).toBe(''); expect(player().position).toBe(6);
    await start(16); expect(requests()).toHaveLength(1);
  });

  it('cancels pending metadata and ignores its response after withdrawal without issuing future ads', async () => {
    await prepare(); const body = deferred<{ creative: typeof creative }>();
    harness.fetch.mockImplementation((url: string) => Promise.resolve(url === '/api/vast?consent=1'
      ? { ok: true, status: 200, json: () => body.promise } as Response : response(null)));
    await start(); const signal = requests()[0]![1]!.signal as AbortSignal;
    expect(adNode()).toBeUndefined(); expect(player().stopped).toBe(true);
    writeConsent(null); await pump(); expect(signal.aborted).toBe(true); expect(player().stopped).toBe(false);
    body.resolve({ creative }); await pump(); await vi.advanceTimersByTimeAsync(0); await pump();
    expect(adNode()).toBeUndefined(); expect(harness.tracking).toEqual([]);
    await start(16); expect(requests()).toHaveLength(1);
  });

  it('re-reads current consent before mounting a fetched creative even without a delivered notification', async () => {
    await prepare(); const responseReady = deferred<Response>();
    harness.fetch.mockImplementation((url: string) => url === '/api/vast?consent=1' ? responseReady.promise : Promise.resolve(response(null)));
    await start(); harness.consentRaw = null;
    responseReady.resolve(Response.json({ creative })); await pump(); await vi.advanceTimersByTimeAsync(0); await pump();
    expect(adNode()).toBeUndefined(); expect(player().stopped).toBe(false); expect(requests()[0]![1]!.signal?.aborted).toBe(true);
    expect(harness.tracking).toEqual([]);
  });

  it('does not issue an ad request if consent is synchronously withdrawn while pausing content to start it', async () => {
    await prepare(); const content = player();
    content.pause.mockImplementationOnce(() => { content.stopped = true; content.emit('pause'); writeConsent(null); });
    await start();
    expect(requests()).toHaveLength(0); expect(adNode()).toBeUndefined(); expect(content.stopped).toBe(false);
    expect(content.position).toBe(6); expect(harness.tracking).toEqual([]);
  });

  it('does not let a cancelled startup finish a newer break after synchronous consent changes', async () => {
    await prepare(); const content = player();
    content.pause.mockImplementationOnce(() => {
      content.stopped = true; content.emit('pause'); writeConsent(null); writeConsent(AD_GRANT);
      content.position = 16; content.stopped = false; content.emit('timeupdate');
    });
    await start();
    expect(requests()).toHaveLength(1); expect(adNode()).toBeDefined(); expect(content.position).toBe(16);
    expect(content.stopped).toBe(true); expect(requests()[0]![1]!.signal?.aborted).toBe(false);
  });

  it('keeps the frozen room and base rate while restoring a registered party port without echo', async () => {
    const media: WatchPartyMediaIdentity = { kind: 'movie', mediaId: '10000000-0000-4000-8000-000000000001' };
    const intents = vi.fn(); let port: PartyPlayerPort | null = null;
    await prepare({ titleId: media.mediaId, watchPartyMedia: media, watchPartyActive: true,
      registerPartyPlayerPort(value) { port = value; value?.subscribe(intents); } });
    const initial = port as unknown as PartyPlayerPort;
    await initial.apply({ playback: { media, mode: 'playing', positionSeconds: 1, playbackRate: 1.25, revision: 1, anchorServerTimeMs: Date.now() },
      mode: 'playing', playbackRate: 1.30, positionSeconds: 1, seek: true, reason: 'snapshot' });
    await start(); expect(port).toBeNull(); writeConsent(null); await pump();
    const resumed = port as unknown as PartyPlayerPort;
    expect(resumed).not.toBe(initial); expect(resumed.read()).toMatchObject({ mode: 'frozen', freezeReason: 'ad-break', positionSeconds: 6, playbackRate: 1.25 });
    expect(player().stopped).toBe(true); expect(intents.mock.calls.map(([intent]) => intent.kind)).toEqual(['freeze']);
  });

  it('fences old completion handlers and unmounts repeated creative IDs before a newly consented break', async () => {
    await prepare(); await start(); const old = adNode(); const oldHandlers = videoNode().props; const oldVideo = adVideo!;
    writeConsent(null); await pump(); writeConsent(AD_GRANT); await start(16);
    const current = adNode(); expect(current).toBeDefined(); expect(current.key).not.toBe(old.key); expect(adVideo).not.toBe(oldVideo);
    old.props.onDone('complete'); oldHandlers.onPlaying(); oldHandlers.onEnded(); await pump();
    expect(adNode()).toBe(current); expect(player().position).toBe(16); expect(player().stopped).toBe(true);
    expect(harness.tracking).toEqual([]);
    videoNode().props.onPlaying(); expect(harness.tracking).toHaveLength(2);
    props = { ...props, source: { url: '/replacement.mp4', kind: 'mp4' } }; render(); await pump();
    const sourceCalls = player().src.mock.calls.length;
    current.props.onDone('complete'); await pump(); expect(adNode()).toBeUndefined(); expect(player().src).toHaveBeenCalledTimes(sourceCalls);
  });

  it('unsubscribes on unmount and fences retained callbacks, pending responses and timers after disposal', async () => {
    await prepare(); const pending = deferred<Response>();
    harness.fetch.mockImplementation((url: string) => url === '/api/vast?consent=1' ? pending.promise : Promise.resolve(response(null)));
    await start(); const content = player();
    const subscriptions = vi.mocked(window.addEventListener).mock.calls.filter(([event]) => event === 'lumora:consent-change');
    const callback = subscriptions.at(-1)![1] as EventListener;
    for (const slot of harness.slots) { slot?.cleanup?.(); if (slot) slot.cleanup = undefined; }
    harness.dirty = false; harness.storageGet.mockClear();
    callback(new Event('lumora:consent-change')); window.dispatchEvent(new Event('focus'));
    expect(harness.storageGet).not.toHaveBeenCalled();
    expect(window.removeEventListener).toHaveBeenCalledWith('lumora:consent-change', callback);
    expect(requests()[0]![1]!.signal?.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
    const playCalls = content.play.mock.calls.length;
    pending.resolve(Response.json({ creative })); await pump(); await vi.advanceTimersByTimeAsync(0); await pump();
    expect(harness.dirty).toBe(false); expect(content.play).toHaveBeenCalledTimes(playCalls); expect(harness.tracking).toEqual([]);
  });
});

describe('mounted native Watch Party registration', () => {
  const media: WatchPartyMediaIdentity = { kind: 'movie', mediaId: '10000000-0000-4000-8000-000000000001' };
  const otherMedia: WatchPartyMediaIdentity = { kind: 'movie', mediaId: '10000000-0000-4000-8000-000000000002' };
  const target = (position = 40, rate = 1, baseRate = rate): PartyPlayerTarget => ({
    playback: { media, mode: 'playing', positionSeconds: position, playbackRate: baseRate,
      anchorServerTimeMs: Date.now(), revision: 1 },
    positionSeconds: position, mode: 'playing', playbackRate: rate, seek: true, reason: 'snapshot',
  });
  async function mountParty(overrides: Partial<typeof props> = {}, makeReady = true) {
    let current: PartyPlayerPort | null = null;
    let unsubscribe: (() => void) | undefined;
    const intents = vi.fn<(intent: PartyPlayerIntent) => void>();
    const register = vi.fn((port: PartyPlayerPort | null) => {
      unsubscribe?.(); current = port; unsubscribe = port?.subscribe(intents);
    });
    props = { ...props, titleId: media.mediaId, watchPartyMedia: media, watchPartyActive: true,
      registerPartyPlayerPort: register, ...overrides };
    await remount();
    if (makeReady) await ready(20, 180);
    return { register, intents, port: () => current };
  }
  async function setting(label: string, value: string) {
    const tab = nodes().find((node) => node.props?.label === label && typeof node.props.onClick === 'function');
    if (tab) { tab.props.onClick({ currentTarget: new FakeElement() }); await pump(); }
    const select = nodes().find((node) => node.props?.label === label && typeof node.props.onChange === 'function');
    select.props.onChange(value); await pump();
  }

  it('registers the real instance only after metadata, restore and playable readiness; forwards no media URLs', async () => {
    const room = await mountParty({ initialPosition: 18 }, false);
    expect(room.register).not.toHaveBeenCalled();
    player().readyCallback(); await pump(); expect(room.port()).toBeNull();
    player().readiness = 1; player().emit('loadedmetadata'); await pump();
    expect(room.port()).toBeNull();
    player().readiness = 2; player().emit('canplay'); await pump();
    expect(room.port()?.read()).toMatchObject({ media, positionSeconds: 18, mode: 'paused', playbackRate: 1 });
    expect(JSON.stringify(room.port()?.read())).not.toContain('/movie.mp4');
    player().emit('loadeddata'); player().emit('canplay'); await pump();
    expect(room.register.mock.calls.filter(([port]) => port)).toHaveLength(1);
  });

  it.each([null, { kind: 'movie', mediaId: 'tmdb-movie-123' }, otherMedia])('refuses unsupported or mismatched identity %j', async (identity) => {
    const room = await mountParty({ watchPartyMedia: identity as WatchPartyMediaIdentity | null });
    expect(room.port()).toBeNull();
    expect(room.register.mock.calls.filter(([port]) => port)).toHaveLength(0);
  });

  it.each([
    { kind: 'movie', mediaId: 'tmdb:movie:27205' },
    { kind: 'episode', mediaId: 'tmdb:tv:1396', seasonNumber: 1, episodeNumber: 2 },
  ] as WatchPartyMediaIdentity[])('registers the explicit public catalogue identity %j without fabricating a database UUID', async (identity) => {
    const room = await mountParty({ titleId: identity.mediaId, watchPartyMedia: identity,
      ...(identity.kind === 'episode' ? { seasonNumber: identity.seasonNumber, episodeNumber: identity.episodeNumber } : {}) });
    expect(room.port()?.read()?.media).toEqual(identity);
    const remote = target(44); remote.playback.media = identity;
    await room.port()!.apply(remote);
    expect(player().position).toBe(44); expect(room.intents).not.toHaveBeenCalled();
  });

  it('does not fabricate a position or rate when the media tech has no finite snapshot', async () => {
    const room = await mountParty({}, false);
    const readTime = player().currentTime.getMockImplementation();
    player().currentTime.mockImplementation(() => Number.NaN);
    await ready(Number.NaN, 180); expect(room.port()).toBeNull();
    player().currentTime.mockImplementation(readTime);
    player().position = 20;
    await ready(20, 180); const port = room.port()!;
    player().position = Number.POSITIVE_INFINITY; expect(port.read()).toBeNull();
    await port.apply(target(80)); expect(player().position).toBe(Number.POSITIVE_INFINITY);
    player().position = 20; player().rate = Number.NaN; expect(port.read()).toBeNull();
    await port.apply(target(80, 2)); expect(player().position).toBe(20); expect(player().rate).toBeNaN();
  });

  it('applies remote seek/play/rate and pause on the same video without synchronous or delayed echo', async () => {
    const room = await mountParty(); const instance = player(); const port = room.port()!;
    instance.loudness = 0.35; instance.silenced = true;
    const initialSources = instance.src.mock.calls.length;
    instance.currentTime.mockImplementation((position?: number) => {
      if (position !== undefined) {
        instance.position = position; instance.isSeeking = true;
        setTimeout(() => { instance.isSeeking = false; instance.emit('seeked'); }, 20);
      }
      return instance.position;
    });
    instance.playbackRate = (rate?: number) => {
      if (rate !== undefined) { instance.rate = rate; setTimeout(() => instance.emit('ratechange'), 30); }
      return instance.rate;
    };
    instance.play.mockImplementation(() => {
      instance.stopped = false;
      return new Promise<void>((resolve) => setTimeout(() => { instance.emit('play'); instance.emit('playing'); resolve(); }, 40));
    });
    const applied = port.apply(target(44.5, 1.04, 1));
    await vi.advanceTimersByTimeAsync(50); await applied; await pump();
    instance.emit('seeked'); instance.emit('ratechange'); instance.emit('play'); await pump();
    expect(room.intents).not.toHaveBeenCalled();
    expect(instance.position).toBe(44.5); expect(instance.rate).toBe(1.04); expect(instance.stopped).toBe(false);
    expect(instance.loudness).toBe(0.35); expect(instance.silenced).toBe(true);
    expect(harness.players).toHaveLength(1); expect(instance.src).toHaveBeenCalledTimes(initialSources);
    const paused = target(44.5, 1.04, 1); paused.mode = 'paused'; paused.playback.mode = 'paused'; paused.seek = false;
    await port.apply(paused); instance.emit('pause'); await pump();
    expect(instance.stopped).toBe(true); expect(room.intents).not.toHaveBeenCalled();
  });

  it('emits real local play, pause, seek and rate intents, never frame-driven commands', async () => {
    const room = await mountParty(); const instance = player();
    await instance.play(); instance.pause(); instance.currentTime(31); instance.playbackRate(1.5); await pump();
    expect(room.intents.mock.calls.map(([intent]) => intent.kind)).toEqual(['play', 'pause', 'seek', 'rate']);
    expect(room.intents.mock.calls[2]![0].snapshot.positionSeconds).toBe(31);
    room.intents.mockClear(); harness.fetch.mockClear();
    for (let frame = 0; frame < 120; frame++) { instance.position += 0.01; instance.emit('timeupdate'); }
    await pump(); expect(room.intents).not.toHaveBeenCalled(); expect(harness.fetch).not.toHaveBeenCalled();
  });

  it('excludes drift correction from saved rate and preserves quality/audio/subtitles across a source replacement', async () => {
    const room = await mountParty(); const instance = player();
    instance.qualityList[0] = { id: '720', width: 1280, height: 720, enabled: true }; instance.qualityList.length = 1;
    instance.audioList[0] = { id: 'en', label: '', language: 'en', enabled: true }; instance.audioList.length = 1;
    instance.textList[0] = { id: 'en', label: '', language: 'en', kind: 'subtitles', mode: 'disabled', cues: [] };
    instance.textList.length = 1; instance.emit('loadeddata'); await pump();
    await setting('Quality', 'quality:720'); await setting('Audio', 'en::'); await setting('Subtitles', 'en::');
    const before = room.port()!;
    await before.apply(target(35, 1.30, 1.25)); await pump();
    instance.emit('timeupdate'); instance.emit('pause');
    props = { ...props, source: { url: '/replacement.mp4', kind: 'mp4' } }; render(); await pump();
    expect(before.read()).toBeNull(); expect(room.port()).toBeNull();
    expect(room.intents.mock.calls.filter(([intent]) => intent.kind === 'freeze').map(([intent]) => intent.freezeReason))
      .toEqual(['source-change']);
    instance.qualityList[0] = { id: '720', width: 1280, height: 720, enabled: true }; instance.qualityList.length = 1;
    instance.audioList[0] = { id: 'en', label: '', language: 'en', enabled: true }; instance.audioList.length = 1;
    instance.textList[0] = { id: 'en', label: '', language: 'en', kind: 'subtitles', mode: 'disabled', cues: [] }; instance.textList.length = 1;
    instance.readiness = 2; instance.emit('loadedmetadata'); instance.emit('canplay'); await pump();
    expect(player()).toBe(instance); expect(instance.position).toBe(35); expect(instance.rate).toBe(1.25);
    expect(instance.stopped).toBe(true); expect(room.port()?.read()?.freezeReason).toBe('source-change');
    expect(instance.audioList[0].enabled).toBe(true); expect(instance.textList[0].mode).toBe('hidden');
    expect(instance.qualityList[0].enabled).toBe(true);
    room.intents.mockClear(); await before.apply(target(80)); expect(instance.position).toBe(35);
    instance.emit('seeked'); instance.emit('ratechange'); await pump(); expect(room.intents).not.toHaveBeenCalled();
    props = { ...props, watchPartyActive: false }; render(); await pump();
    expect(room.port()?.read()?.mode).toBe('paused');
  });

  it('restores the authoritative base rate on room disconnect without another user intent', async () => {
    const room = await mountParty(); await room.port()!.apply(target(20, 0.96, 1)); await pump();
    props = { ...props, watchPartyActive: false }; render(); await pump();
    expect(player().rate).toBe(1); expect(room.intents).not.toHaveBeenCalled();
    await room.port()!.apply(target(90, 2)); expect(player().position).toBe(20); expect(player().rate).toBe(1);
  });

  it('does not turn a pending remote rate event into an intent when the user pauses or adjusts another control', async () => {
    const room = await mountParty(); const instance = player();
    instance.playbackRate = (rate?: number) => {
      if (rate !== undefined) { instance.rate = rate; setTimeout(() => instance.emit('ratechange'), 50); }
      return instance.rate;
    };
    await room.port()!.apply(target(20, 1.04, 1)); await pump();
    const volume = new FakeElement(); volume.closestMatch = '.vjs-volume-panel';
    instance.el().emit('pointerdown', { target: volume, pointerType: 'mouse' });
    keydown('k'); await pump();
    await vi.advanceTimersByTimeAsync(60); await pump();
    expect(room.intents.mock.calls.map(([intent]) => intent.kind)).toEqual(['pause']);
    props = { ...props, source: { url: '/next-source.mp4', kind: 'mp4' } }; render(); await pump();
    instance.readiness = 2; instance.emit('loadedmetadata'); instance.emit('canplay'); await pump();
    expect(instance.rate).toBe(1);
  });

  it('does not suppress a genuine keyboard scrub back to an earlier remote seek target', async () => {
    const room = await mountParty(); await room.port()!.apply(target(40)); await pump();
    player().position = 60; player().emit('timeupdate');
    const control = new FakeElement();
    control.closest = (selector: string) => selector.includes('.vjs-control-bar') || selector.includes('.vjs-progress-control') ? control : null;
    keydown('ArrowLeft', { target: control });
    player().currentTime(40); await pump();
    expect(room.intents.mock.calls.map(([intent]) => intent.kind)).toEqual(['seek']);
    expect(room.intents.mock.calls[0]![0].snapshot.positionSeconds).toBe(40);
  });

  it('keeps stale unsubscribe and replaced registration callbacks from removing the current subscription', async () => {
    const room = await mountParty(); const old = room.port()!;
    const listener = vi.fn(); const oldUnsubscribe = old.subscribe(listener);
    player().emit('waiting'); player().emit('canplay'); await pump();
    const current = room.port()!; current.subscribe(listener); oldUnsubscribe();
    await player().play(); expect(listener).toHaveBeenCalledOnce();
    const owner = vi.fn(); props = { ...props, registerPartyPlayerPort: owner }; render(); await pump();
    expect(room.register).toHaveBeenLastCalledWith(null);
    expect(owner).toHaveBeenCalledWith(expect.objectContaining({ read: expect.any(Function), apply: expect.any(Function) }));
    expect(current.read()).toBeNull();
  });

  it('suspends buffering, preserves frozen state through seeks, and thaws only on explicit local play', async () => {
    const room = await mountParty(); const first = room.port()!;
    const frozen: PartyPlayerTarget = { ...target(20), mode: 'frozen', freezeReason: 'source-change',
      playback: { ...target(20).playback, mode: 'frozen', freezeReason: 'source-change' } };
    await first.apply(frozen); player().emit('waiting'); await pump();
    expect(first.read()).toBeNull(); expect(room.port()).toBeNull();
    await first.apply(target(80)); expect(player().position).toBe(20);
    player().emit('canplay'); await pump();
    expect(room.port()?.read()?.freezeReason).toBe('source-change');
    player().currentTime(30); await pump();
    expect(room.intents.mock.calls.map(([intent]) => intent.kind)).toEqual(['seek']);
    expect(room.intents.mock.calls[0]![0].snapshot.mode).toBe('frozen');
    await player().play(); await pump();
    expect(room.intents.mock.calls.map(([intent]) => intent.kind)).toEqual(['seek', 'play']);
    expect(room.port()?.read()?.mode).toBe('playing');
  });

  it('freezes once for background, rejects hidden targets and does not autoplay merely on visibility return', async () => {
    const room = await mountParty(); await player().play(); room.intents.mockClear();
    const port = room.port()!;
    fakeDocument.visibilityState = 'hidden';
    for (const [event, callback] of fakeDocument.addEventListener.mock.calls) if (event === 'visibilitychange') callback();
    await pump(); expect(room.port()).toBeNull(); expect(port.read()).toBeNull();
    await port.apply(target(80)); expect(player().position).toBe(20); expect(player().stopped).toBe(true);
    expect(room.intents.mock.calls.map(([intent]) => intent.kind === 'freeze' ? intent.freezeReason : intent.kind)).toEqual(['background']);
    fakeDocument.visibilityState = 'visible';
    for (const [event, callback] of fakeDocument.addEventListener.mock.calls) if (event === 'visibilitychange') callback();
    await pump(); expect(room.port()?.read()?.freezeReason).toBe('background'); expect(player().stopped).toBe(true);
  });

  it('blocks room targets during an ad and restores content without clearing the ad freeze or echoing restore events', async () => {
    const ad = deferred<Response>();
    harness.fetch.mockImplementation((url: string) => url === '/api/vast?consent=1' ? ad.promise
      : Promise.resolve(response({ startSeconds: 0, endSeconds: 10.25 })));
    const room = await mountParty({ adPolicy: { enabled: true, firstBreakSeconds: 5, intervalSeconds: 30,
      maxBreaks: 1, allowSkip: true, skipAfterSeconds: 5 } });
    const port = room.port()!; const instance = player();
    instance.stopped = false; instance.position = 25; instance.emit('timeupdate'); await pump();
    expect(room.port()).toBeNull();
    expect(harness.fetch).toHaveBeenCalledWith('/api/vast?consent=1', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    const position = instance.position; await port.apply(target(80, 2)); expect(instance.position).toBe(position); expect(instance.rate).toBe(1);
    ad.resolve(Response.json({ creative: { id: 'ad', mediaUrl: 'https://ads.example.test/ad.mp4', durationSeconds: 10, tracking: {} } })); await pump();
    await vi.advanceTimersByTimeAsync(0); await pump();
    const adNode = nodes().find((node) => node.props?.creative && node.props?.onDone);
    expect(adNode).toBeDefined(); adNode.props.onDone('complete'); await pump();
    expect(room.port()?.read()?.positionSeconds).toBe(25); expect(instance.stopped).toBe(true);
    instance.emit('seeked'); instance.emit('ratechange'); await pump();
    expect(room.intents.mock.calls.map(([intent]) => intent.kind === 'freeze' ? intent.freezeReason : intent.kind)).toEqual(['ad-break']);
  });

  it('rejects other-media targets and makes old ports inert immediately across media changes and unmount', async () => {
    const room = await mountParty(); const old = room.port()!; const previous = player();
    const mismatch = target(75); mismatch.playback.media = otherMedia;
    await old.apply(mismatch); expect(previous.position).toBe(20);
    props = { ...props, titleId: otherMedia.mediaId, watchPartyMedia: otherMedia, source: { url: '/next.mp4', kind: 'mp4' } };
    render(); await pump(); expect(old.read()).toBeNull(); expect(room.port()).toBeNull();
    await ready(5, 160); const current = room.port()!; await old.apply(target(85)); expect(player().position).toBe(5);
    room.intents.mockClear(); for (const slot of harness.slots) slot?.cleanup?.(); harness.dirty = false;
    await current.apply(target(90)); previous.emit('seeked'); previous.emit('ratechange'); previous.emit('play'); await pump();
    expect(room.port()).toBeNull(); expect(room.intents).not.toHaveBeenCalled(); expect(harness.dirty).toBe(false);
  });

  it('survives StrictMode-style cleanup/setup and ignores late play rejection from the retired instance', async () => {
    const room = await mountParty(); const old = room.port()!; const previous = player();
    const play = deferred<void>(); previous.play.mockImplementation(() => play.promise);
    const apply = old.apply(target(20));
    for (const slot of harness.slots) {
      if (slot?.cleanup) { slot.cleanup(); slot.cleanup = undefined; }
      if (slot?.deps) slot.deps = undefined;
    }
    render(); await pump(); await ready(9, 180); const current = room.port();
    expect(current).not.toBe(old); expect(old.read()).toBeNull();
    play.reject(new Error('play aborted by source disposal')); await apply; await pump();
    expect(room.port()).toBe(current); expect(player().position).toBe(9);
    room.intents.mockClear(); await player().play(); await pump();
    expect(room.intents.mock.calls.map(([intent]) => intent.kind)).toEqual(['play']);
  });
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
    expect(previous.disposed).toBe(false); expect(previous.src).toHaveBeenCalledOnce(); expect(button()).toBeUndefined();
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

describe('native video display modes', () => {
  it('cycles Fit, Fill, and Zoom without replacing the player or source and persists each choice', async () => {
    await ready(1);
    const instance = player();
    instance.position = 37.5; instance.rate = 1.5; instance.stopped = false;
    expect(instance.el().classList.contains('lumora-display-fit')).toBe(true);
    await openSettings();
    presentationButton('Display mode Fit').props.onClick(); await pump();
    expect(instance.el().classList.contains('lumora-display-fill')).toBe(true);
    expect(instance.el().classList.contains('lumora-display-fit')).toBe(false);
    expect(harness.storageSet).toHaveBeenLastCalledWith('lumora:player:display-mode:v1', 'fill');
    presentationButton('Display mode Fill').props.onClick(); await pump();
    expect(instance.el().classList.contains('lumora-display-zoom')).toBe(true);
    expect(harness.storageSet).toHaveBeenLastCalledWith('lumora:player:display-mode:v1', 'zoom');
    presentationButton('Display mode Zoom').props.onClick(); await pump();
    expect(instance.el().classList.contains('lumora-display-fit')).toBe(true);
    expect(harness.players).toHaveLength(1);
    expect(instance.src).not.toHaveBeenCalled();
    expect(instance.position).toBe(37.5); expect(instance.rate).toBe(1.5); expect(instance.stopped).toBe(false);
  });

  it('restores a valid preference and safely defaults invalid or unavailable storage to Fit', async () => {
    harness.storageGet.mockReturnValue('zoom');
    await remount();
    expect(harness.storageGet).toHaveBeenCalledWith('lumora:player:display-mode:v1');
    expect(player().el().classList.contains('lumora-display-zoom')).toBe(true);
    harness.storageGet.mockReturnValue('overscan');
    await remount();
    expect(player().el().classList.contains('lumora-display-fit')).toBe(true);
    harness.storageGet.mockImplementation(() => { throw new Error('storage disabled'); });
    await remount();
    expect(player().el().classList.contains('lumora-display-fit')).toBe(true);
  });

  it('maps Fit to contain, Fill to stretch, and Zoom to aspect-preserving cover with no extra scale', () => {
    const css = readFileSync(new URL('../../src/styles/globals.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.lumora-videojs\.lumora-display-fit \.vjs-tech\s*\{[^}]*object-fit:\s*contain;/s);
    expect(css).toMatch(/\.lumora-videojs\.lumora-display-fill \.vjs-tech\s*\{[^}]*object-fit:\s*fill;/s);
    const zoom = css.match(/\.lumora-videojs\.lumora-display-zoom \.vjs-tech\s*\{[^}]*\}/s)?.[0] ?? '';
    expect(zoom).toMatch(/object-fit:\s*cover;/);
    expect(zoom).not.toMatch(/transform|scale\(/);
  });
});

describe('native video Picture-in-Picture', () => {
  it('does not render a control or claim support when the current tech has no supported API', async () => {
    await ready(1); await openSettings();
    expect(presentationButton('Enter Picture-in-Picture')).toBeUndefined();
    expect(video.disablePictureInPicture).toBe(false);
  });

  it('prevents duplicate pending requests and reflects standard enter and leave events', async () => {
    const pending = deferred<unknown>();
    const request = enableStandardPictureInPicture(vi.fn(() => pending.promise));
    await ready(1); await pump(); await openSettings();
    const enter = presentationButton('Enter Picture-in-Picture');
    player().stopped = false; player().rate = 1.5; harness.write.mockClear();
    enter.props.onClick(); enter.props.onClick(); await pump();
    expect(request).toHaveBeenCalledTimes(1);
    expect(player().requestPictureInPicture).toHaveBeenCalledTimes(1);
    expect(presentationButton('Enter Picture-in-Picture').props.disabled).toBe(true);
    fakeDocument.pictureInPictureElement = video;
    pending.resolve(undefined); await pump();
    expect(presentationButton('Exit Picture-in-Picture')).toBeDefined();
    fakeDocument.pictureInPictureElement = null;
    player().isPip = false; player().emit('leavepictureinpicture'); await pump();
    expect(presentationButton('Enter Picture-in-Picture')).toBeDefined();
    expect(player().stopped).toBe(false); expect(player().rate).toBe(1.5);
    expect(harness.write).not.toHaveBeenCalled();
  });

  it('uses the Safari presentation-mode fallback only when both runtime methods report support', async () => {
    const safari = video as FakeVideo & {
      webkitPresentationMode: string;
      webkitSupportsPresentationMode: (mode: string) => boolean;
      webkitSetPresentationMode: (mode: string) => void;
    };
    safari.webkitPresentationMode = 'inline';
    safari.webkitSupportsPresentationMode = vi.fn(() => true);
    safari.webkitSetPresentationMode = vi.fn((mode: string) => {
      safari.webkitPresentationMode = mode;
      safari.emit('webkitpresentationmodechanged');
    });
    player().emit('techchange');
    await ready(1); await pump(); await openSettings();
    presentationButton('Enter Picture-in-Picture').props.onClick(); await pump();
    expect(safari.webkitSetPresentationMode).toHaveBeenCalledWith('picture-in-picture');
    expect(presentationButton('Exit Picture-in-Picture')).toBeDefined();
    presentationButton('Exit Picture-in-Picture').props.onClick(); await pump();
    expect(safari.webkitSetPresentationMode).toHaveBeenLastCalledWith('inline');
    expect(presentationButton('Enter Picture-in-Picture')).toBeDefined();
  });

  it('shows only a sanitized failure notice when a request rejects', async () => {
    enableStandardPictureInPicture(vi.fn(async () => { throw new Error('https://private.example/video?token=secret'); }));
    await ready(1); await pump(); await openSettings();
    presentationButton('Enter Picture-in-Picture').props.onClick(); await pump();
    expect(nodes().some((node) => node.props?.children === 'Picture-in-Picture could not start. Try again from the player.')).toBe(true);
    expect(JSON.stringify(tree)).not.toContain('private.example');
    expect(JSON.stringify(tree)).not.toContain('token=secret');
  });

  it('disables the control while loading, switching, or connecting to Cast', async () => {
    enableStandardPictureInPicture(); await pump(); await openSettings();
    expect(presentationButton('Enter Picture-in-Picture').props.disabled).toBe(true);
    await ready(1);
    expect(presentationButton('Enter Picture-in-Picture').props.disabled).toBe(false);
    player().emit('waiting'); await pump();
    expect(presentationButton('Enter Picture-in-Picture').props.disabled).toBe(true);
    player().emit('canplay'); await pump();
    expect(presentationButton('Enter Picture-in-Picture').props.disabled).toBe(false);
    const cast = deferred<CastingHandle | null>();
    harness.casting.mockReturnValue(cast.promise);
    castButton().props.onClick(); await pump();
    expect(presentationButton('Enter Picture-in-Picture').props.disabled).toBe(true);
    cast.resolve(null); await pump();
    expect(presentationButton('Enter Picture-in-Picture').props.disabled).toBe(false);

    harness.fetch.mockImplementation(async (url: string) => url === '/catalog' ? ({ ok: true, json: async () => ({ streams: [
      { id: '0', url: '/one.m3u8', qualities: [{ id: '0', label: '240p', height: 240 }], audioTracks: [], subtitles: [] },
      { id: '1', url: '/two.m3u8', qualities: [{ id: '1', label: '720p', height: 720 }], audioTracks: [], subtitles: [] },
    ] }) } as Response) : response({ startSeconds: 0, endSeconds: 10.25 }));
    props = { ...props, source: { url: '/one.m3u8?stream=0', kind: 'hls', streamCatalogUrl: '/catalog' } };
    await remount(); enableStandardPictureInPicture(); await ready(1); await pump();
    const qualityTool = nodes().find((node) => node.props?.label === 'Quality');
    qualityTool.props.onClick({ currentTarget: new FakeElement() }); await pump();
    nodes().find((node) => node.props?.label === 'Quality' && typeof node.props?.onChange === 'function').props.onChange('quality:720');
    await pump();
    settingsButton().props.onClick({ currentTarget: new FakeElement() }); await pump();
    expect(presentationButton('Enter Picture-in-Picture').props.disabled).toBe(true);
  });

  it('exits before Cast starts and before in-place source replacement', async () => {
    const request = enableStandardPictureInPicture(vi.fn(async () => {
      fakeDocument.pictureInPictureElement = video;
    }));
    await ready(1); await pump(); await openSettings();
    presentationButton('Enter Picture-in-Picture').props.onClick(); await pump();
    expect(request).toHaveBeenCalledTimes(1);
    const exit = deferred<void>();
    harness.exitPictureInPicture.mockImplementation(() => { harness.events.push('pip-exit'); return exit.promise; });
    const cast = deferred<CastingHandle | null>();
    harness.casting.mockReturnValue(cast.promise);
    castButton().props.onClick(); await pump();
    expect(harness.casting).not.toHaveBeenCalled();
    fakeDocument.pictureInPictureElement = null;
    exit.resolve(); await pump();
    expect(harness.casting).toHaveBeenCalledTimes(1);
    cast.resolve(null); await pump();

    fakeDocument.pictureInPictureElement = video;
    player().isPip = true; player().emit('enterpictureinpicture'); await pump();
    harness.events = [];
    harness.exitPictureInPicture.mockImplementation(async () => {
      harness.events.push('pip-exit');
      fakeDocument.pictureInPictureElement = null;
    });
    const previous = player();
    previous.src.mockImplementation((source: { src: string }) => { harness.events.push('replace'); previous.url = source.src; previous.readiness = 0; previous.emit('loadstart'); });
    props = { ...props, source: { url: '/replacement.mp4', kind: 'mp4' } };
    render(); await pump();
    expect(harness.events.indexOf('pip-exit')).toBeGreaterThanOrEqual(0);
    expect(harness.events.indexOf('replace')).toBeGreaterThan(harness.events.indexOf('pip-exit'));
    expect(previous.disposed).toBe(false);
  });

  it('awaits player-level PiP exit before fullscreen and user-selected source replacement', async () => {
    const selected = vi.fn();
    props = { ...props, sources: [{ id: 'primary', label: 'Primary' }, { id: 'backup', label: 'Backup' }], selectedSourceId: 'primary', onSelectSource: selected };
    await remount();
    enableStandardPictureInPicture(vi.fn(async () => { fakeDocument.pictureInPictureElement = video; }));
    await ready(1); await pump(); await openSettings();
    presentationButton('Enter Picture-in-Picture').props.onClick(); await pump();
    const fullscreenExit = deferred<void>();
    harness.exitPictureInPicture.mockImplementation(() => { harness.events.push('pip-exit'); return fullscreenExit.promise; });
    harness.events = [];
    player().doubleClick({ sourceCapabilities: { firesTouchEvents: false } } as unknown as MouseEvent); await pump();
    expect(player().requestFullscreen).not.toHaveBeenCalled();
    fakeDocument.pictureInPictureElement = null; fullscreenExit.resolve(); await pump();
    expect(player().exitPictureInPicture).toHaveBeenCalled();
    expect(player().requestFullscreen).toHaveBeenCalledTimes(1);
    expect(harness.events).toEqual(['pip-exit', 'fullscreen']);
    expect(presentationButton('Enter Picture-in-Picture').props.disabled).toBe(true);

    player().fullscreen = false; player().emit('fullscreenchange');
    fakeDocument.pictureInPictureElement = video; player().isPip = true; player().emit('enterpictureinpicture'); await pump();
    const sourceExit = deferred<void>();
    harness.exitPictureInPicture.mockImplementation(() => sourceExit.promise);
    nodes().find((node) => node.props?.label === 'Playback fallback' && typeof node.props?.onChange === 'function').props.onChange('backup');
    await pump(); expect(selected).not.toHaveBeenCalled();
    fakeDocument.pictureInPictureElement = null; sourceExit.resolve(); await pump();
    expect(selected).toHaveBeenCalledExactlyOnceWith('backup');
  });

  it('defers a due VAST break throughout PiP and resumes scheduling after leave', async () => {
    const ad = deferred<Response>();
    harness.fetch.mockImplementation((url: string) => url === '/api/vast?consent=1' ? ad.promise : Promise.resolve(response({ startSeconds: 0, endSeconds: 10.25 })));
    props = { ...props, source: { url: '/ad-pip.mp4', kind: 'mp4' }, adPolicy: { enabled: true, firstBreakSeconds: 5, intervalSeconds: 30, maxBreaks: 1, allowSkip: true, skipAfterSeconds: 5 } };
    await remount();
    enableStandardPictureInPicture(vi.fn(async () => {
      fakeDocument.pictureInPictureElement = video;
    }));
    await ready(1); await pump(); await openSettings();
    presentationButton('Enter Picture-in-Picture').props.onClick(); await pump();
    player().stopped = false; player().position = 5; player().emit('timeupdate'); await pump();
    expect(harness.fetch.mock.calls.some(([url]) => url === '/api/vast?consent=1')).toBe(false);
    expect(harness.adUpdate).toHaveBeenLastCalledWith(expect.objectContaining({ contentTimeSeconds: 5, adPlaying: true }));
    expect(presentationButton('Exit Picture-in-Picture')).toBeDefined();
    expect(harness.exitPictureInPicture).not.toHaveBeenCalled();
    fakeDocument.pictureInPictureElement = null; player().isPip = false; player().emit('leavepictureinpicture'); await pump();
    expect(harness.fetch.mock.calls.some(([url]) => url === '/api/vast?consent=1')).toBe(true);
    expect(presentationButton('Enter Picture-in-Picture')).toBeUndefined();
    ad.resolve({ ok: false, status: 204 } as Response); await pump();
  });
});

describe('web native player keyboard controls', () => {
  it('owns surface shortcuts once, advertises them accessibly, and consumes only handled keys', async () => {
    await ready(30, 200);
    expect(player().options.userActions.hotkeys).toBe(false);
    expect(player().el().attributes.get('aria-keyshortcuts')).toContain('Shift+N');
    expect(player().el().attributes.get('aria-describedby')).toBe('intro-fixture-keyboard-shortcuts');
    expect((window.addEventListener as ReturnType<typeof vi.fn>).mock.calls.some(([type]) => type === 'keydown')).toBe(false);

    const play = keydown(' ');
    expect(play.preventDefault).toHaveBeenCalledOnce();
    expect(play.stopImmediatePropagation).toHaveBeenCalledOnce();
    expect(player().play).toHaveBeenCalledOnce();

    const pause = keydown('K');
    expect(pause.preventDefault).toHaveBeenCalledOnce();
    expect(player().pause).toHaveBeenCalledOnce();

    for (const key of ['x', 'i', 'c']) {
      const ignored = keydown(key);
      expect(ignored.preventDefault).not.toHaveBeenCalled();
      expect(ignored.stopImmediatePropagation).not.toHaveBeenCalled();
    }
  });

  it.each(['input', 'textarea', 'select', 'button', 'a', 'dialog', '[role="dialog"]', '[contenteditable]', '.vjs-control-bar', '[data-player-settings]'])
  ('ignores %s focus without suppressing browser behavior', async (closestMatch) => {
    await ready(30, 200);
    const target = new FakeElement(); target.closestMatch = closestMatch;
    const event = keydown('k', { target });
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(player().play).not.toHaveBeenCalled();
  });

  it('ignores an excluded active element and all modifier shortcuts except Shift+N', async () => {
    await ready(95, 100);
    const focused = new FakeElement(); focused.closestMatch = 'input'; fakeDocument.activeElement = focused;
    expect(keydown('k').preventDefault).not.toHaveBeenCalled();
    fakeDocument.activeElement = null;
    for (const modifiers of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }, { shiftKey: true }]) {
      expect(keydown('k', modifiers).preventDefault).not.toHaveBeenCalled();
    }
    expect(player().play).not.toHaveBeenCalled();
  });

  it('maps Arrow/J/L, Home/End, and 0-9 through the native seek and checkpoint path', async () => {
    await ready(100, 200);
    player().rate = 1.5;
    const cases: Array<[string, number]> = [
      ['ArrowLeft', 95], ['ArrowRight', 105], ['j', 90], ['l', 110], ['Home', 0], ['0', 0], ['End', 200],
      ...Array.from({ length: 9 }, (_, index) => [String(index + 1), (index + 1) * 20] as [string, number]),
    ];
    for (const [key, expected] of cases) {
      player().position = 100; player().currentTime.mockClear(); harness.write.mockClear();
      const event = keydown(key);
      expect(event.preventDefault, key).toHaveBeenCalledOnce();
      expect(player().currentTime.mock.calls.some((args: unknown[]) => args.length === 1 && args[0] === expected), key).toBe(true);
      expect(harness.write, key).toHaveBeenCalledWith('guest', 'fixture-media', expected, 200, false);
      expect(player().rate).toBe(1.5);
    }
  });

  it('changes volume in five-percent steps and toggles mute through Video.js', async () => {
    await ready(30, 200);
    player().loudness = 0.5;
    expect(keydown('ArrowUp').preventDefault).toHaveBeenCalledOnce(); expect(player().loudness).toBe(0.55);
    expect(keydown('ArrowDown').preventDefault).toHaveBeenCalledOnce(); expect(player().loudness).toBe(0.5);
    expect(keydown('m').preventDefault).toHaveBeenCalledOnce(); expect(player().silenced).toBe(true);
    expect(keydown('M').preventDefault).toHaveBeenCalledOnce(); expect(player().silenced).toBe(false);
  });

  it('toggles fullscreen and uses the existing PiP action only when supported', async () => {
    await ready(30, 200);
    const enterFullscreen = keydown('f'); await pump();
    expect(enterFullscreen.preventDefault).toHaveBeenCalledOnce();
    expect(player().requestFullscreen).toHaveBeenCalledOnce();
    const leaveFullscreen = keydown('F'); await pump();
    expect(leaveFullscreen.preventDefault).toHaveBeenCalledOnce();
    expect(player().exitFullscreen).toHaveBeenCalledOnce();

    enableStandardPictureInPicture(); await pump();
    const enterPip = keydown('i'); await pump();
    expect(enterPip.preventDefault).toHaveBeenCalledOnce();
    expect(player().requestPictureInPicture).toHaveBeenCalledOnce();
    const leavePip = keydown('I'); await pump();
    expect(leavePip.preventDefault).toHaveBeenCalledOnce();
    expect(player().exitPictureInPicture).toHaveBeenCalledOnce();
  });

  it('toggles the last available caption through stream selection', async () => {
    await ready(30, 200);
    const track = installSubtitle(); await pump();
    const enable = keydown('c'); await pump();
    expect(enable.preventDefault).toHaveBeenCalledOnce();
    expect(track.mode).toBe('hidden');
    expect(player().addRemoteTextTrack).toHaveBeenCalledOnce();
    const disable = keydown('C'); await pump();
    expect(disable.preventDefault).toHaveBeenCalledOnce();
    expect(track.mode).toBe('disabled');
  });

  it('opens available Up Next only for Shift+N', async () => {
    props = { ...props, upNext: { name: 'Episode 2', href: '/watch/tv/show?episode=2' } }; render(); await pump();
    await ready(5, 100);
    expect(keydown('n').preventDefault).not.toHaveBeenCalled();
    const next = keydown('N', { shiftKey: true });
    expect(next.preventDefault).toHaveBeenCalledOnce();
    expect(harness.navigate).toHaveBeenCalledOnce();
  });
});

describe('web native player keyboard gates', () => {
  const guardedKeys: Array<[string, Partial<KeyboardEvent>]> = [
    [' ', {}], ['ArrowLeft', {}], ['ArrowRight', {}], ['j', {}], ['l', {}], ['ArrowUp', {}], ['ArrowDown', {}],
    ['m', {}], ['f', {}], ['c', {}], ['i', {}], ['Home', {}], ['End', {}], ['5', {}], ['N', { shiftKey: true }],
  ];

  function expectGuarded() {
    for (const [key, modifiers] of guardedKeys) expect(keydown(key, modifiers).preventDefault, key).not.toHaveBeenCalled();
  }

  it('does not handle shortcuts before the source is ready or while it is buffering', async () => {
    expectGuarded();
    await ready(30, 200);
    player().emit('waiting'); await pump();
    expectGuarded();
    player().emit('canplay'); await pump();
    expect(keydown('k').preventDefault).toHaveBeenCalledOnce();
  });

  it('does not bypass an active VAST load or break', async () => {
    const ad = deferred<Response>();
    harness.fetch.mockImplementation((url: string) => url === '/api/vast?consent=1'
      ? ad.promise : Promise.resolve(response({ startSeconds: 0, endSeconds: 10.25 })));
    props = { ...props, source: { url: '/keyboard-ad.mp4', kind: 'mp4' }, adPolicy: { enabled: true, firstBreakSeconds: 5, intervalSeconds: 30, maxBreaks: 1, allowSkip: true, skipAfterSeconds: 5 } };
    render(); await pump(); await ready(1, 200);
    player().stopped = false; player().position = 5; player().emit('timeupdate'); await pump();
    expect(harness.fetch.mock.calls.some(([url]) => url === '/api/vast?consent=1')).toBe(true);
    expectGuarded();
    ad.resolve({ ok: false, status: 204 } as Response); await pump();
  });

  it('does not mutate the local player or receiver while Cast is active', async () => {
    await ready(30, 200);
    const handle = await connectCast({ positionSeconds: 30, durationSeconds: 200, paused: true });
    player().play.mockClear(); player().pause.mockClear(); player().currentTime.mockClear();
    expectGuarded();
    expect(player().play).not.toHaveBeenCalled(); expect(player().pause).not.toHaveBeenCalled();
    expect(player().currentTime.mock.calls.some((args: unknown[]) => args.length > 0)).toBe(false);
    expect(handle.play).not.toHaveBeenCalled(); expect(handle.pause).not.toHaveBeenCalled(); expect(handle.seek).not.toHaveBeenCalled();
  });

  it('blocks duplicate and unrelated actions during a PiP transition', async () => {
    const pending = deferred<unknown>();
    enableStandardPictureInPicture(vi.fn(() => pending.promise));
    await ready(30, 200); await pump();
    const enter = keydown('i');
    expect(enter.preventDefault).toHaveBeenCalledOnce();
    expectGuarded();
    expect(player().requestPictureInPicture).toHaveBeenCalledOnce();
    pending.resolve(undefined); await pump();
  });
});

describe('opt-in native player ping display', () => {
  it('defaults off, persists the Settings choice, and requests only same-origin health', async () => {
    await openSettings();
    expect(presentationButton('Show ping').props.buttonLabel).toBe('Off');
    expect(healthCalls()).toHaveLength(0); expect(pingBadge()).toBeUndefined();
    presentationButton('Show ping').props.onClick(); await pump();
    expect(harness.storageSet).toHaveBeenCalledWith(PING_KEY, 'true');
    expect(healthCalls()).toHaveLength(1);
    expect(healthCalls()[0]?.[1]).toMatchObject({ cache: 'no-store', credentials: 'same-origin', signal: expect.any(AbortSignal) });
    expect(pingBadge().props.children).toBe('Ping 0 ms');
    expect(JSON.stringify(tree)).not.toContain('/api/health');
  });

  it('restores only the versioned true preference and safely persists disable', async () => {
    harness.storageGet.mockImplementation((key: string) => key === PING_KEY ? 'true' : null);
    await remount();
    expect(healthCalls()).toHaveLength(1); expect(pingBadge()).toBeDefined();
    await openSettings(); presentationButton('Hide ping').props.onClick(); await pump();
    expect(harness.storageSet).toHaveBeenCalledWith(PING_KEY, 'false');
    expect(pingBadge()).toBeUndefined();
  });

  it('measures sanitized RTT, never overlaps, and waits the bounded cadence', async () => {
    const first = deferred<Response>(); const second = deferred<Response>();
    let probes = 0;
    harness.storageGet.mockImplementation((key: string) => key === PING_KEY ? 'true' : null);
    harness.fetch.mockImplementation((url: string) => url === '/api/health'
      ? (++probes === 1 ? first.promise : second.promise)
      : Promise.resolve(response({ startSeconds: 0, endSeconds: 10.25 })));
    vi.setSystemTime(new Date('2026-11-02T00:00:00Z'));
    await remount(); expect(healthCalls()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(42); first.resolve({ ok: true } as Response); await pump();
    expect(pingBadge().props.children).toBe('Ping 42 ms');
    await vi.advanceTimersByTimeAsync(14_999); expect(healthCalls()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1); expect(healthCalls()).toHaveLength(2);
    second.resolve({ ok: true } as Response); await pump();
  });

  it('times out and aborts a hung request before scheduling the next probe', async () => {
    harness.storageGet.mockImplementation((key: string) => key === PING_KEY ? 'true' : null);
    harness.fetch.mockImplementation((url: string) => url === '/api/health'
      ? new Promise<Response>(() => {}) : Promise.resolve(response({ startSeconds: 0, endSeconds: 10.25 })));
    await remount();
    const signal = healthCalls()[0]?.[1]?.signal as AbortSignal;
    await vi.advanceTimersByTimeAsync(5_000); await pump();
    expect(signal.aborted).toBe(true); expect(pingBadge().props.children).toBe('Unavailable');
    await vi.advanceTimersByTimeAsync(14_999); expect(healthCalls()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1); expect(healthCalls()).toHaveLength(2);
  });

  it('aborts and stops while hidden, restarts when visible, and aborts on dispose', async () => {
    harness.storageGet.mockImplementation((key: string) => key === PING_KEY ? 'true' : null);
    harness.fetch.mockImplementation((url: string) => url === '/api/health'
      ? new Promise<Response>(() => {}) : Promise.resolve(response({ startSeconds: 0, endSeconds: 10.25 })));
    await remount();
    const firstSignal = healthCalls()[0]?.[1]?.signal as AbortSignal;
    fakeDocument.visibilityState = 'hidden';
    for (const [type, listener] of fakeDocument.addEventListener.mock.calls) if (type === 'visibilitychange') listener();
    expect(firstSignal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000); expect(healthCalls()).toHaveLength(1);
    fakeDocument.visibilityState = 'visible';
    for (const [type, listener] of fakeDocument.addEventListener.mock.calls) if (type === 'visibilitychange') listener();
    expect(healthCalls()).toHaveLength(2);
    const secondSignal = healthCalls()[1]?.[1]?.signal as AbortSignal;
    for (const slot of harness.slots) slot?.cleanup?.();
    expect(secondSignal.aborted).toBe(true);
  });

  it('shows Offline and sanitized Unavailable states without exposing failures', async () => {
    harness.storageGet.mockImplementation((key: string) => key === PING_KEY ? 'true' : null);
    (navigator as unknown as { onLine: boolean }).onLine = false;
    await remount();
    expect(healthCalls()).toHaveLength(0); expect(pingBadge().props.children).toBe('Offline');
    (navigator as unknown as { onLine: boolean }).onLine = true;
    harness.fetch.mockImplementation((url: string) => url === '/api/health'
      ? Promise.reject(new Error('https://private.example/?token=secret'))
      : Promise.resolve(response({ startSeconds: 0, endSeconds: 10.25 })));
    for (const [type, listener] of (window.addEventListener as ReturnType<typeof vi.fn>).mock.calls) if (type === 'online') listener();
    await pump();
    expect(pingBadge().props.children).toBe('Unavailable');
    expect(JSON.stringify(tree)).not.toContain('private.example');
    expect(JSON.stringify(tree)).not.toContain('token=secret');
  });
});

describe('verified native episode controls and real content completion', () => {
  let prepare: (() => Promise<boolean>) | null;
  let ended: Mock<() => void>;
  let navigate: Mock<(direction: 'previous' | 'next') => boolean>;
  const next = { seasonNumber: 1, episodeNumber: 3, name: 'Verified third episode', href: '/watch/tv/fixture?season=1&episode=3' };
  const previous = { seasonNumber: 1, episodeNumber: 1, name: 'Verified first episode', href: '/watch/tv/fixture?season=1&episode=1' };

  beforeEach(async () => {
    prepare = null; ended = vi.fn<() => void>(); navigate = vi.fn<(direction: 'previous' | 'next') => boolean>(() => true);
    harness.exitPictureInPicture.mockReset(); harness.exitPictureInPicture.mockResolvedValue(undefined);
    props = { ...props, seasonNumber: 1, episodeNumber: 2, episodeNavigation: { previous, next },
      upNext: { name: next.name, href: next.href }, autoNext: false, onAutoNextChange: vi.fn(), onNavigateEpisode: navigate,
      onContentEnded: ended, registerEpisodeTransition: (transition) => { prepare = transition; } };
    await remount();
  });

  it('does not infer ended from progress, duration, readiness or an ended event with ended() false', async () => {
    await ready(120); player().emit('timeupdate'); player().emit('durationchange'); player().emit('canplay');
    player().emit('ended'); await pump(); expect(ended).not.toHaveBeenCalled();
    player().hasEnded = true; player().emit('ended'); await pump();
    expect(ended).toHaveBeenCalledOnce();
    expect(harness.write).toHaveBeenCalledWith('guest', 'fixture-media:fixture:1:2', 120, 120, false);
    for (let index = 0; index < 3; index += 1) { player().emit('ended'); player().emit('loadedmetadata'); player().emit('canplay'); }
    await pump(); expect(ended).toHaveBeenCalledOnce(); expect(navigate).not.toHaveBeenCalled();
  });

  it('excludes initial loading, buffering and source replacement from content-ended notifications', async () => {
    player().hasEnded = true; player().position = 120; player().emit('ended'); await pump(); expect(ended).not.toHaveBeenCalled();
    player().hasEnded = false; await ready(30); player().emit('waiting');
    player().hasEnded = true; player().position = 120; player().emit('ended'); await pump(); expect(ended).not.toHaveBeenCalled();
    player().hasEnded = false; player().emit('canplay');
    props = { ...props, source: { url: '/replacement.mp4', kind: 'mp4' } }; render(); await pump();
    player().hasEnded = true; player().position = 120; player().emit('ended'); await pump(); expect(ended).not.toHaveBeenCalled();
  });

  it('requires an actual finite content duration and end position, not a stale ended event', async () => {
    await ready(10); player().hasEnded = true;
    for (const duration of [0, NaN, Infinity]) { player().seconds = duration; player().emit('ended'); }
    player().seconds = 120; player().emit('ended'); await pump(); expect(ended).not.toHaveBeenCalled();
  });

  it('does not emit content-ended during PiP entry or transition-driven PiP exit', async () => {
    await ready(30); const entered = deferred<unknown>(); enableStandardPictureInPicture(() => entered.promise); await openSettings();
    presentationButton('Enter Picture-in-Picture').props.onClick(); await pump();
    player().position = 120; player().hasEnded = true; player().emit('ended'); await pump(); expect(ended).not.toHaveBeenCalled();
    entered.resolve(undefined); await pump(); expect(ended).not.toHaveBeenCalled();
    const exited = deferred<void>(); harness.exitPictureInPicture.mockImplementation(() => exited.promise);
    keydown('f'); await pump(); player().emit('ended'); await pump(); expect(ended).not.toHaveBeenCalled();
    exited.resolve(); await pump(); expect(ended).not.toHaveBeenCalled();
  });

  it('keeps Cast completion/connection separate from local content-ended and refuses independent receiver navigation', async () => {
    await ready(30); await connectCast({ positionSeconds: 120, durationSeconds: 120, paused: true });
    player().position = 120; player().hasEnded = true; player().emit('ended'); await pump(); expect(ended).not.toHaveBeenCalled();
    expect(await prepare!()).toBe(false); await pump();
    expect(nodes().some((node) => node.props?.role === 'alert' && String(node.props.children).includes('Stop casting'))).toBe(true);
  });

  it('cancels an active VAST request on an explicit episode transition and ignores a late creative', async () => {
    const ad = deferred<Response>();
    harness.fetch.mockImplementation((url) => url === '/api/vast?consent=1' ? ad.promise : Promise.resolve(response(null)));
    props = { ...props, introCatalogUrl: undefined, adPolicy: { enabled: true, firstBreakSeconds: 5,
      intervalSeconds: 5, maxBreaks: 3, allowSkip: true, skipAfterSeconds: 5 } };
    await remount(); await ready(1); player().stopped = false;
    player().position = 5; player().emit('timeupdate'); await pump();
    const request = harness.fetch.mock.calls.find(([url]) => url === '/api/vast?consent=1'); expect(request).toBeDefined();
    player().position = 120; player().hasEnded = true; player().emit('ended'); await pump(); expect(ended).not.toHaveBeenCalled();
    player().position = 5; player().hasEnded = false;
    player().play.mockClear();
    expect(await prepare!()).toBe(true); await pump(); expect(request![1].signal.aborted).toBe(true);
    ad.resolve({ ok: true, status: 200, json: async () => ({ creative: { id: 'late-ad', mediaUrl: '/ad.mp4', durationSeconds: 10 } }) } as Response);
    await pump();
    expect(nodes().some((node) => node.props?.creative?.id === 'late-ad')).toBe(false); expect(player().url).toBe('/movie.mp4');
    expect(player().play).not.toHaveBeenCalled();
  });

  it('closes PiP and writes the exact content checkpoint before preparation resolves without changing source/rate/captions', async () => {
    await ready(33.75); player().rate = 1.5; player().stopped = true;
    const caption = installSubtitle(); await pump();
    nodes().find((node) => node.props?.label === 'Subtitles' && node.props.onClick).props.onClick({ currentTarget: new FakeElement() }); await pump();
    nodes().find((node) => node.props?.label === 'Subtitles' && node.props.onChange).props.onChange('en::'); await pump();
    enableStandardPictureInPicture(); await openSettings(); presentationButton('Enter Picture-in-Picture').props.onClick(); await pump();
    const exited = deferred<void>(); harness.exitPictureInPicture.mockImplementation(() => exited.promise);
    harness.write.mockClear(); const preparing = prepare!(); await pump();
    expect(harness.write).not.toHaveBeenCalled(); expect(player().src).not.toHaveBeenCalled();
    exited.resolve(); expect(await preparing).toBe(true); await pump();
    expect(harness.write).toHaveBeenCalledWith('guest', 'fixture-media:fixture:1:2', 33.75, 120, false);
    expect(player().position).toBe(33.75); expect(player().rate).toBe(1.5); expect(player().stopped).toBe(true);
    expect(caption.mode).toBe('hidden'); expect(player().src).not.toHaveBeenCalled();
  });

  it('allows retry after PiP exit fails, with no stuck native transition latch', async () => {
    await ready(20); enableStandardPictureInPicture(); await openSettings();
    presentationButton('Enter Picture-in-Picture').props.onClick(); await pump();
    harness.exitPictureInPicture.mockRejectedValueOnce(new Error('Exit blocked'));
    expect(await prepare!()).toBe(false); expect(await prepare!()).toBe(true);
    expect(player().src).not.toHaveBeenCalled(); expect(player().position).toBe(20);
  });

  it.each(['preparing', 'pending'])('blocks new media commands while an episode transition is %s', async (phase) => {
    const selectSource = vi.fn();
    props = { ...props, sources: [{ id: 'primary', label: 'Server 1' }, { id: 'backup', label: 'Server 2' }],
      selectedSourceId: 'primary', onSelectSource: selectSource };
    render(); await pump(); await ready(20);
    player().qualityList[0] = { id: '720', height: 720, enabled: true }; player().qualityList.length = 1;
    player().qualityList.emit('addqualitylevel'); await pump();
    nodes().find((node) => node.props?.label === 'Quality' && node.props.onClick).props.onClick({ currentTarget: new FakeElement() }); await pump();
    const quality = nodes().find((node) => node.props?.label === 'Quality' && node.props.onChange);
    await openSettings();
    const fallback = nodes().find((node) => node.props?.label === 'Playback fallback' && node.props.onChange);
    harness.casting.mockResolvedValue(null);
    const exited = deferred<void>();
    let preparing: Promise<boolean> | undefined;
    if (phase === 'preparing') {
      enableStandardPictureInPicture(); await pump(); await openSettings(); presentationButton('Enter Picture-in-Picture').props.onClick(); await pump();
      harness.exitPictureInPicture.mockImplementation(() => exited.promise);
      preparing = prepare!(); await pump();
    } else {
      props = { ...props, episodeNavigationPending: true }; render(); await pump();
    }
    const sourceRequests = player().src.mock.calls.length;
    castButton().props.onClick(); quality.props.onChange('quality:720'); fallback.props.onChange('backup'); await pump();
    exited.resolve(); if (preparing) expect(await preparing).toBe(true); await pump();
    expect.soft(harness.casting).not.toHaveBeenCalled(); expect.soft(selectSource).not.toHaveBeenCalled();
    expect(player().src).toHaveBeenCalledTimes(sourceRequests);
    nodes().find((node) => node.props?.label === 'Quality' && node.props.onClick).props.onClick({ currentTarget: new FakeElement() }); await pump();
    expect.soft(nodes().find((node) => node.props?.label === 'Quality' && node.props.onChange).props.value).toBe('auto');
  });

  it('unregisters preparation and rejects an awaited transition when the mounted player is disposed', async () => {
    await ready(20); enableStandardPictureInPicture(); await openSettings(); presentationButton('Enter Picture-in-Picture').props.onClick(); await pump();
    const exited = deferred<void>(); harness.exitPictureInPicture.mockImplementation(() => exited.promise);
    const preparing = prepare!(); await pump();
    for (const slot of harness.slots) slot?.cleanup?.();
    expect(prepare).toBeNull(); exited.resolve(); expect(await preparing).toBe(false);
  });

  it('reuses verified Next/Prev for Shift+N/P without requiring stream readiness and respects repeat/focus guards', async () => {
    expect(keydown('N', { shiftKey: true }).preventDefault).toHaveBeenCalledOnce();
    expect(keydown('P', { shiftKey: true }).preventDefault).toHaveBeenCalledOnce();
    expect(navigate.mock.calls).toEqual([['next'], ['previous']]); navigate.mockClear();
    expect(keydown('N', { shiftKey: true, repeat: true }).preventDefault).not.toHaveBeenCalled();
    const input = new FakeElement(); input.closestMatch = 'input'; fakeDocument.activeElement = input;
    keydown('P', { shiftKey: true }); keydown('N', { shiftKey: true }); expect(navigate).not.toHaveBeenCalled();
    fakeDocument.activeElement = null; props = { ...props, episodeNavigation: { previous: null, next } }; render(); await pump();
    expect(keydown('P', { shiftKey: true }).preventDefault).not.toHaveBeenCalled(); expect(navigate).not.toHaveBeenCalled();
  });

  it('defaults the series setting OFF and never remounts media when Auto Next changes', async () => {
    await ready(20); await openSettings(); const initial = player(); const change = props.onAutoNextChange!;
    const action = presentationButton('Turn on Auto Next'); expect(action.props.pressed).toBe(false); expect(action.props.buttonLabel).toBe('Off');
    action.props.onClick(); expect(change).toHaveBeenCalledWith(true);
    props = { ...props, autoNext: true }; render(); await pump();
    expect(presentationButton('Turn off Auto Next').props.buttonLabel).toBe('On');
    expect(player()).toBe(initial); expect(initial.src).not.toHaveBeenCalled();
  });

  it('blocks party/pending buttons, shortcuts, preparation and ended, including stale setting/link handlers', async () => {
    await ready(20); await openSettings(); const setting = presentationButton('Turn on Auto Next');
    const link = nodes().find((node) => node.type === 'a' && node.props?.['data-player-up-next'] !== undefined);
    props = { ...props, episodeNavigationDisabled: true }; render(); await pump();
    expect(presentationButton('Turn on Auto Next').props.disabled).toBe(true); setting.props.onClick();
    const event = { preventDefault: vi.fn() }; link.props.onClick(event); expect(event.preventDefault).toHaveBeenCalledOnce();
    keydown('N', { shiftKey: true }); keydown('P', { shiftKey: true }); expect(await prepare!()).toBe(false);
    player().hasEnded = true; player().position = 120; player().emit('ended'); await pump();
    expect(navigate).not.toHaveBeenCalled(); expect(props.onAutoNextChange).not.toHaveBeenCalled(); expect(ended).not.toHaveBeenCalled();
    props = { ...props, episodeNavigationDisabled: false, episodeNavigationPending: true }; render(); await pump();
    keydown('N', { shiftKey: true }); player().emit('ended'); await pump(); expect(navigate).not.toHaveBeenCalled(); expect(ended).not.toHaveBeenCalled();
  });

  it('keeps verified episode controls inside the fullscreen portal and omits the series setting without its contract', async () => {
    await ready(20); player().fullscreen = true; player().emit('fullscreenchange'); await pump();
    const control = nodes().find((node) => typeof node.type === 'function' && node.type.name === 'EpisodeControls');
    expect(control.props.next).toEqual(next); expect(control.props.previous).toEqual(previous);
    expect(nodes().find((node) => node.type === 'portal')?.props.target).toBe(player().el());
    props = { ...props, episodeNavigation: undefined, onAutoNextChange: undefined, autoNext: undefined, upNext: undefined };
    render(); await openSettings();
    expect(presentationButton('Turn on Auto Next')).toBeUndefined(); expect(presentationButton('Turn off Auto Next')).toBeUndefined();
  });
});

describe('web player selection and reload correctness', () => {
  it('keeps the exact numbered source pinned when choosing genuine compatible languages and Auto quality', async () => {
    const catalog = [stream('0', 2160, 'en', 'en', 1), stream('1', 2160, 'en', 'en', 900)].map((entry) => ({ ...entry,
      audioTracks: [{ id: 'en', label: 'English', language: 'en', default: true }, { id: 'hi', label: 'Hindi', language: 'hi' }] }));
    await mountCatalog(catalog); liveOptions([2160], ['en', 'hi'], ['en']); await ready(42);
    await choose('Quality', 'quality:2160'); await choose('Audio', 'stream:1');
    liveOptions([2160], ['en', 'hi'], ['en']); player().readiness = 2; player().emit('loadedmetadata'); player().emit('canplay'); await pump();
    await choose('Audio', 'hi::'); await choose('Quality', 'auto');
    for (let index = 0; index < 3; index += 1) { player().emit('canplay'); player().audioList.emit('change'); await pump(); }
    expect(player().url).toBe('/fixture-1.m3u8'); expect(player().audioList[1].enabled).toBe(true);
    await choose('Audio', 'en::'); expect(player().url).toBe('/fixture-1.m3u8');
    await choose('Audio', 'auto'); await choose('Quality', 'auto'); expect(player().url).toBe('/fixture-0.m3u8');
  });

  const stream = (id: string, height: number, language = 'en', subtitle = 'en', latency?: number): DirectStream => ({
    id, url: `/fixture-${id}.m3u8`, startupLatencyMs: latency,
    qualities: [{ id: `rendition-${id}`, label: `${height}p`, height }],
    audioTracks: [{ id: `audio-${id}`, label: language, language, default: true }],
    subtitles: [{ id: `subtitle-${id}`, label: subtitle, language: subtitle, kind: 'subtitles' }],
  });
  const catalogResponse = (streams: DirectStream[]) => ({ ok: true, json: async () => ({ streams }) }) as Response;
  function select(label: string) { return nodes().find((node) => node.props?.label === label && typeof node.props?.onChange === 'function'); }
  async function panel(label: 'Quality' | 'Audio' | 'Subtitles') {
    const tool = nodes().find((node) => node.props?.label === label && typeof node.props?.onChange !== 'function');
    if (!tool.props.active) tool.props.onClick({ currentTarget: new FakeElement() });
    await pump();
  }
  async function choose(label: 'Quality' | 'Audio' | 'Subtitles', value: string) {
    await panel(label); select(label).props.onChange(value); await pump();
  }
  function liveOptions(heights = [720, 1080], languages = ['en', 'de'], subtitles = ['en', 'es']) {
    const instance = player();
    for (const [list, values] of [
      [instance.qualityList, heights.map((height) => ({ id: `live-${height}`, height, enabled: true }))],
      [instance.audioList, languages.map((language, index) => ({ id: `live-${language}`, label: language, language, enabled: index === 0 }))],
      [instance.textList, subtitles.map((language) => ({ id: `live-${language}`, label: language, language, kind: 'subtitles', mode: 'disabled', cues: null, addCue: vi.fn(), removeCue: vi.fn() }))],
    ] as Array<[any, any[]]>) {
      for (let index = 0; index < list.length; index += 1) delete list[index];
      Object.assign(list, values); list.length = values.length;
      list.emit(list === instance.qualityList ? 'addqualitylevel' : 'addtrack');
    }
  }
  function retainedOption(label: string, value: string) {
    const setting = select(label);
    const rendered = setting.type(setting.props);
    const nativeSelect = nodes(rendered).find((node) => node.type === 'select');
    expect(nativeSelect.props.value).toBe(value);
    expect(nodes(nativeSelect).some((node) => node.type === 'option' && node.props.value === value)).toBe(true);
  }
  function fail() { player().failure = { code: 4, message: 'https://private.example/video?token=secret' }; player().emit('error'); }
  async function mountCatalog(streams: DirectStream[] | Promise<Response>, url = '/catalog', sourceUrl = '/fixture-0.m3u8?stream=0') {
    harness.fetch.mockImplementation((request: string) => request === url
      ? Array.isArray(streams) ? Promise.resolve(catalogResponse(streams)) : streams
      : Promise.resolve(response({ startSeconds: 0, endSeconds: 10.25 })));
    props = { ...props, source: { url: sourceUrl, kind: 'hls', streamCatalogUrl: url }, onError: vi.fn(), onReady: vi.fn() };
    await remount();
  }

  const directCatalogUrl = '/api/vidnest?tmdbId=27205&type=movie&metadata=1';
  const directAutoUrl = '/api/vidnest?tmdbId=27205&type=movie&stream=auto';
  const capabilityStream = (id: string, latency: number, expiresAt = Date.now() + 60 * 60 * 1000): DirectStream => ({
    ...stream(id, 720, 'en', 'en', latency), url: `/api/vidnest?token=fixture-${id}`, expiresAt,
  });
  const directLookups = () => harness.fetch.mock.calls.filter(([url]) => String(url).startsWith('/api/vidnest'));

  it('starts Direct playback from one catalog lookup without a concurrent Auto resolver load', async () => {
    const pending = deferred<Response>();
    await mountCatalog(pending.promise, directCatalogUrl, directAutoUrl);
    expect(player().options.sources).toEqual([]);
    expect(player().src).not.toHaveBeenCalled();
    expect(directLookups()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(28_000); await pump();
    expect(props.onError).not.toHaveBeenCalled();
    pending.resolve(catalogResponse([capabilityStream('0', 900), capabilityStream('1', 10)])); await pump();
    expect(player().src).toHaveBeenCalledOnce();
    expect(player().url).toBe('/api/vidnest?token=fixture-1');
    expect(directLookups()).toHaveLength(1);
    expect(props.onReady).not.toHaveBeenCalled();
    liveOptions([720], ['en'], ['en']); player().readiness = 1; player().emit('loadedmetadata'); await pump();
    expect(props.onReady).not.toHaveBeenCalled();
    player().readiness = 2; player().emit('loadeddata'); await pump();
    expect(props.onReady).toHaveBeenCalledOnce();
  });

  it('bounds an unresponsive initial catalog and ignores its late response without another lookup', async () => {
    const pending = deferred<Response>();
    await mountCatalog(pending.promise, directCatalogUrl, directAutoUrl);
    const signal = directLookups()[0]![1].signal as AbortSignal;
    await vi.advanceTimersByTimeAsync(35_000); await pump();
    expect(signal.aborted).toBe(true); expect(props.onError).toHaveBeenCalledOnce();
    pending.resolve(catalogResponse([capabilityStream('0', 1)])); await pump();
    await vi.advanceTimersByTimeAsync(60_000); await pump();
    expect(player().src).not.toHaveBeenCalled(); expect(props.onReady).not.toHaveBeenCalled();
    expect(directLookups()).toHaveLength(1);
  });

  it('reuses all issued URLs for repeated numbered audio choices, parent refreshes and explicit media Retry', async () => {
    await mountCatalog([capabilityStream('0', 10), capabilityStream('1', 900)], directCatalogUrl, directAutoUrl);
    liveOptions([720], ['en'], ['en']); await ready(24);
    for (let index = 0; index < 25; index++) {
      const id = (index + 1) % 2;
      await choose('Audio', `stream:${id}`);
      expect(player().url).toBe(`/api/vidnest?token=fixture-${id}`);
      liveOptions([720], ['en'], ['en']); player().readiness = 2; player().emit('loadedmetadata'); player().emit('canplay'); await pump();
    }
    expect(player().src).toHaveBeenCalledTimes(26); // Initial load plus 25 actual source changes.
    const loads = player().src.mock.calls.length;
    for (let index = 0; index < 5; index++) {
      props = { ...props, source: { ...props.source, url: `${directAutoUrl}&refresh=${index}` } };
      render(); await pump();
    }
    expect(player().src).toHaveBeenCalledTimes(loads);
    expect(directLookups()).toHaveLength(1);
    props = { ...props, retryKey: 1 }; render(); await pump();
    expect(player().src).toHaveBeenCalledTimes(loads + 1);
    expect(directLookups()).toHaveLength(1);
    expect(player().src.mock.calls.every(([source]: [{ src: string }]) => source.src.includes('?token='))).toBe(true);
  });

  it('honors an explicitly requested numeric Direct source from the same initial catalog', async () => {
    await mountCatalog([capabilityStream('0', 1), capabilityStream('1', 900)], directCatalogUrl, directAutoUrl.replace('auto', '1'));
    expect(player().url).toBe('/api/vidnest?token=fixture-1');
    expect(player().src).toHaveBeenCalledOnce();
    expect(directLookups()).toHaveLength(1);
  });

  it('uses the existing catalog when an explicit numeric Direct source prop changes', async () => {
    await mountCatalog([capabilityStream('0', 1), capabilityStream('1', 900)], directCatalogUrl, directAutoUrl);
    liveOptions([720], ['en'], ['en']); await ready(16);
    props = { ...props, source: { ...props.source, url: directAutoUrl.replace('auto', '1') } }; render(); await pump();
    expect(player().url).toBe('/api/vidnest?token=fixture-1');
    expect(directLookups()).toHaveLength(1);
  });

  it('coalesces choices during one expired-link refresh and applies only the latest choice', async () => {
    const expiresAt = Date.now() + 1000;
    const subtitleUrl = '/api/subtitles?tmdbId=27205&type=movie';
    props = { ...props, subtitleCatalogUrl: subtitleUrl };
    await mountCatalog([capabilityStream('0', 1, expiresAt), capabilityStream('1', 900, expiresAt)], directCatalogUrl, directAutoUrl);
    liveOptions([720], ['en'], ['en']); await ready(37.5);
    player().rate = 1.5; player().stopped = false; player().emit('timeupdate');
    const pending = deferred<Response>();
    const subtitles = deferred<Response>();
    harness.fetch.mockImplementation((url) => url === directCatalogUrl ? pending.promise
      : url === subtitleUrl ? subtitles.promise : Promise.resolve(response(null)));
    await vi.advanceTimersByTimeAsync(1001); await pump();
    expect(directLookups()).toHaveLength(1); // Expiry alone never polls the resolver.
    await choose('Audio', 'stream:1'); await choose('Audio', 'stream:0'); await choose('Audio', 'stream:1');
    expect(directLookups()).toHaveLength(2);
    expect((directLookups()[1]![1].signal as AbortSignal).aborted).toBe(false);
    const subtitleCalls = harness.fetch.mock.calls.filter(([url]) => url === subtitleUrl);
    expect(subtitleCalls).toHaveLength(2);
    expect((subtitleCalls[1]![1].signal as AbortSignal).aborted).toBe(false);
    pending.resolve(catalogResponse([capabilityStream('0', 1), capabilityStream('1', 900)]
      .map((entry) => ({ ...entry, url: `${entry.url}-renewed` })))); await pump();
    expect(player().url).toBe('/api/vidnest?token=fixture-1-renewed');
    liveOptions([720], ['en'], ['en']); player().readiness = 2; player().emit('loadedmetadata'); player().emit('canplay'); await pump();
    expect(player().position).toBe(37.5); expect(player().rate).toBe(1.5); expect(player().stopped).toBe(false);
    expect(directLookups()).toHaveLength(2);
    subtitles.resolve({ ok: true, json: async () => ({ tracks: [] }) } as Response); await pump();
    expect(harness.fetch.mock.calls.filter(([url]) => url === subtitleUrl)).toHaveLength(2);
  });

  it.each([
    ['Quality', 'quality:720', false], ['Quality', 'auto', false],
    ['Quality', 'auto', true], ['Subtitles', 'en::', true], ['Audio', 'en::', true],
  ] as const)('renews the same loaded capability for %s=%s with pin=%s', async (label, value, pinned) => {
    const expiresAt = Date.now() + 1000;
    await mountCatalog([capabilityStream('0', 1, expiresAt), capabilityStream('1', 900, expiresAt)], directCatalogUrl, directAutoUrl);
    liveOptions([720], ['en'], ['en']); await ready(38.5);
    await choose('Quality', 'quality:720');
    if (pinned) {
      await choose('Audio', 'stream:1'); liveOptions([720], ['en'], ['en']);
      player().readiness = 2; player().emit('loadedmetadata'); player().emit('canplay'); await pump();
    }
    player().rate = 1.5; player().stopped = false; player().emit('timeupdate');
    const loads = player().src.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1001);
    harness.fetch.mockResolvedValue(catalogResponse([capabilityStream('0', 1), capabilityStream('1', 900)]
      .map((entry) => ({ ...entry, url: `${entry.url}-renewed` }))));
    await choose(label, value);
    expect(player().url).toBe(`/api/vidnest?token=fixture-${pinned ? '1' : '0'}-renewed`);
    expect(player().src).toHaveBeenCalledTimes(loads + 1);
    liveOptions([720], ['en'], ['en']); player().readiness = 2; player().emit('loadedmetadata'); player().emit('canplay'); await pump();
    expect(player().position).toBe(38.5); expect(player().rate).toBe(1.5); expect(player().stopped).toBe(false);
    await panel(label); retainedOption(label, value);
    if (pinned) { await panel('Audio'); expect(select('Audio').props.status).toBe('Audio stream 2 pinned'); }
    props = { ...props, retryKey: 1 }; render(); await pump();
    expect(player().url).toBe(`/api/vidnest?token=fixture-${pinned ? '1' : '0'}-renewed`);
    expect(directLookups()).toHaveLength(2);
  });

  it('waits for one renewal before Retry loads a pinned stream, preserving all manual choices and position', async () => {
    const expiresAt = Date.now() + 1000;
    await mountCatalog([capabilityStream('0', 1, expiresAt), capabilityStream('1', 900, expiresAt)], directCatalogUrl, directAutoUrl);
    liveOptions([720], ['en'], ['en']); await ready(41.25);
    await choose('Quality', 'quality:720'); await choose('Audio', 'stream:1');
    liveOptions([720], ['en'], ['en']); player().readiness = 2; player().emit('loadedmetadata'); player().emit('canplay'); await pump();
    await choose('Audio', 'en::'); await choose('Subtitles', 'en::');
    player().rate = 1.25; player().stopped = false; player().emit('timeupdate');
    await vi.advanceTimersByTimeAsync(1001); fail(); await pump();
    const loads = player().src.mock.calls.length;
    const pending = deferred<Response>(); harness.fetch.mockReturnValue(pending.promise);
    props = { ...props, retryKey: 1 }; render(); await pump();
    props = { ...props, retryKey: 2 }; render(); await pump();
    expect(player().src).toHaveBeenCalledTimes(loads); expect(directLookups()).toHaveLength(2);
    expect((directLookups()[1]![1].signal as AbortSignal).aborted).toBe(false);
    pending.resolve(catalogResponse([capabilityStream('0', 1), capabilityStream('1', 900)]
      .map((entry) => ({ ...entry, url: `${entry.url}-renewed` })))); await pump();
    expect(player().src).toHaveBeenCalledTimes(loads + 1); expect(player().url).toBe('/api/vidnest?token=fixture-1-renewed');
    liveOptions([720], ['en'], ['en']); player().readiness = 2; player().emit('loadedmetadata'); player().emit('loadeddata'); await pump();
    expect(player().position).toBe(41.25); expect(player().rate).toBe(1.25); expect(player().stopped).toBe(false);
    for (const [label, value] of [['Quality', 'quality:720'], ['Audio', 'en::'], ['Subtitles', 'en::']] as const) {
      await panel(label); retainedOption(label, value);
    }
    await panel('Audio'); expect(select('Audio').props.status).toBe('Audio stream 2 pinned');
    expect(directLookups()).toHaveLength(2);
  });

  it('keeps a non-pinned numeric source on same-quality renewal instead of picking a faster different stream', async () => {
    const expiresAt = Date.now() + 1000;
    await mountCatalog([capabilityStream('0', 1, expiresAt), capabilityStream('1', 900, expiresAt)], directCatalogUrl, directAutoUrl.replace('auto', '1'));
    liveOptions([720], ['en'], ['en']); await ready(23.5); await choose('Quality', 'quality:720');
    await vi.advanceTimersByTimeAsync(1001);
    harness.fetch.mockResolvedValue(catalogResponse([capabilityStream('0', 1), capabilityStream('1', 900)]
      .map((entry) => ({ ...entry, url: `${entry.url}-renewed` }))));
    await choose('Quality', 'quality:720');
    expect(player().url).toBe('/api/vidnest?token=fixture-1-renewed'); expect(directLookups()).toHaveLength(2);
  });

  it('lets a later manual choice supersede a queued expired Retry without a second renewal request', async () => {
    const expiresAt = Date.now() + 1000;
    await mountCatalog([capabilityStream('0', 1, expiresAt), capabilityStream('1', 900, expiresAt)], directCatalogUrl, directAutoUrl);
    liveOptions([720], ['en'], ['en']); await ready(25);
    await vi.advanceTimersByTimeAsync(1001);
    const pending = deferred<Response>(); harness.fetch.mockReturnValue(pending.promise);
    const loads = player().src.mock.calls.length;
    props = { ...props, retryKey: 1 }; render(); await pump();
    await choose('Audio', 'stream:1');
    expect(directLookups()).toHaveLength(2); expect(player().src).toHaveBeenCalledTimes(loads);
    pending.resolve(catalogResponse([capabilityStream('0', 1), capabilityStream('1', 900)]
      .map((entry) => ({ ...entry, url: `${entry.url}-renewed` })))); await pump();
    expect(player().url).toBe('/api/vidnest?token=fixture-1-renewed'); expect(player().src).toHaveBeenCalledTimes(loads + 1);
    expect(directLookups()).toHaveLength(2); retainedOption('Audio', 'stream:1');
  });

  it('caps catalog reuse at four hours even when the reported capability expiry is later', async () => {
    const startedAt = Date.now();
    await mountCatalog([capabilityStream('0', 1, startedAt + 24 * 60 * 60 * 1000)], directCatalogUrl, directAutoUrl);
    liveOptions([720], ['en'], ['en']); await ready(12);
    vi.setSystemTime(startedAt + 4 * 60 * 60 * 1000 - 1);
    await choose('Quality', 'quality:720'); expect(directLookups()).toHaveLength(1);
    vi.setSystemTime(startedAt + 4 * 60 * 60 * 1000 + 1);
    harness.fetch.mockResolvedValue(catalogResponse([{ ...capabilityStream('0', 1), url: '/api/vidnest?token=renewed-after-cap' }]));
    await choose('Quality', 'quality:720');
    expect(directLookups()).toHaveLength(2); expect(player().url).toBe('/api/vidnest?token=renewed-after-cap');
  });

  it.each(['missing', 'quality', 'audio', 'subtitle', 'expired'] as const)
  ('rejects a %s renewed pin without using old live tracks or loading a different stream', async (failure) => {
    const expiresAt = Date.now() + 1000;
    await mountCatalog([capabilityStream('0', 1, expiresAt), capabilityStream('1', 900, expiresAt)], directCatalogUrl, directAutoUrl);
    liveOptions([720], ['en'], ['en']); await ready(39.5);
    await choose('Quality', 'quality:720'); await choose('Audio', 'stream:1');
    liveOptions([720], ['en'], ['en']); player().readiness = 2; player().emit('loadedmetadata'); player().emit('canplay'); await pump();
    await choose('Audio', 'en::'); await choose('Subtitles', 'en::');
    const loads = player().src.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1001);
    const renewed = [capabilityStream('0', 1), capabilityStream('1', 900)].map((entry) => ({ ...entry, url: `${entry.url}-renewed` }));
    if (failure === 'missing') renewed.pop();
    if (failure === 'quality') renewed[1]!.qualities = stream('1', 480).qualities;
    if (failure === 'audio') renewed[1]!.audioTracks = stream('1', 720, 'de').audioTracks;
    if (failure === 'subtitle') renewed[1]!.subtitles = stream('1', 720, 'en', 'fr').subtitles;
    if (failure === 'expired') renewed[1]!.expiresAt = expiresAt;
    harness.fetch.mockResolvedValue(catalogResponse(renewed));
    await choose('Quality', 'quality:720');
    expect(player().src).toHaveBeenCalledTimes(loads); expect(player().url).toBe('/api/vidnest?token=fixture-1');
    expect(player().position).toBe(39.5); expect(nodes().some((node) => node.props?.role === 'alert')).toBe(true);
    for (const [label, value] of [['Quality', 'quality:720'], ['Audio', 'en::'], ['Subtitles', 'en::']] as const) {
      await panel(label); retainedOption(label, value);
    }
    await panel('Audio'); expect(select('Audio').props.status).toBe('Audio stream 2 pinned');
    props = { ...props, retryKey: 1 }; render(); await pump();
    const lookups = directLookups().length;
    await vi.advanceTimersByTimeAsync(60_000); await pump();
    expect(player().src).toHaveBeenCalledTimes(loads); expect(directLookups()).toHaveLength(lookups);
  });

  it.each(['movie', 'episode'] as const)('isolates cached links and an in-flight renewal across a %s change', async (kind) => {
    props = { ...props, titleId: 'first', selectedSourceId: 'direct',
      ...(kind === 'episode' ? { seasonNumber: 1, episodeNumber: 1 } : {}) };
    const oldCatalogUrl = kind === 'movie' ? directCatalogUrl : '/api/vidnest?tmdbId=1&type=tv&season=1&episode=1&metadata=1';
    const oldSourceUrl = oldCatalogUrl.replace('metadata=1', 'stream=auto');
    const expiresAt = Date.now() + 1000;
    await mountCatalog([capabilityStream('0', 1, expiresAt), capabilityStream('1', 900, expiresAt)], oldCatalogUrl, oldSourceUrl);
    liveOptions([720], ['en'], ['en']); await ready(19.5); await choose('Audio', 'stream:1');
    liveOptions([720], ['en'], ['en']); player().readiness = 2; player().emit('loadedmetadata'); player().emit('canplay'); await pump();
    const pending = deferred<Response>(); harness.fetch.mockReturnValue(pending.promise);
    await vi.advanceTimersByTimeAsync(1001); await choose('Audio', 'stream:0');
    const oldSignal = directLookups()[1]![1].signal as AbortSignal;
    const previous = player();
    const nextCatalogUrl = kind === 'movie' ? directCatalogUrl.replace('27205', '2') : oldCatalogUrl.replace('episode=1', 'episode=2');
    harness.fetch.mockResolvedValue(catalogResponse([{ ...capabilityStream('0', 1), url: '/api/vidnest?token=next-title-or-episode' }]));
    props = { ...props, ...(kind === 'movie' ? { titleId: 'second' } : { episodeNumber: 2 }),
      source: { kind: 'hls', url: nextCatalogUrl.replace('metadata=1', 'stream=auto'), streamCatalogUrl: nextCatalogUrl } };
    render(); await pump();
    expect(previous.disposed).toBe(true); expect(oldSignal.aborted).toBe(true); expect(harness.players).toHaveLength(2);
    pending.resolve(catalogResponse([{ ...capabilityStream('0', 1), url: '/api/vidnest?token=stale-renewal' }])); await pump();
    expect(player().url).toBe('/api/vidnest?token=next-title-or-episode'); expect(player().src).toHaveBeenCalledOnce();
    expect(directLookups()).toHaveLength(3);
    await panel('Audio'); expect(select('Audio').props.status).toBeUndefined();
    await panel('Quality'); retainedOption('Quality', 'auto');
  });

  it('does not amplify a catalog failure into an Auto lookup and only retries when requested', async () => {
    await mountCatalog(Promise.resolve({ ok: false, status: 429 } as Response), directCatalogUrl, directAutoUrl);
    expect(props.onError).toHaveBeenCalledOnce();
    expect(player().src).not.toHaveBeenCalled();
    props = { ...props, source: { ...props.source, url: `${directAutoUrl}&refresh=1` } }; render(); await pump();
    expect(directLookups()).toHaveLength(1);
    harness.fetch.mockResolvedValue(catalogResponse([capabilityStream('0', 1)]));
    props = { ...props, retryKey: 1 }; render(); await pump();
    expect(directLookups()).toHaveLength(2);
    expect(player().src).toHaveBeenCalledOnce();
    expect(player().url).toBe('/api/vidnest?token=fixture-0');
  });

  it('rejects an expired refreshed catalog without a background retry loop', async () => {
    const expiresAt = Date.now() + 1000;
    const streams = [capabilityStream('0', 1, expiresAt), capabilityStream('1', 900, expiresAt)];
    await mountCatalog(streams, directCatalogUrl, directAutoUrl);
    liveOptions([720], ['en'], ['en']); await ready(21);
    await vi.advanceTimersByTimeAsync(1001); await choose('Audio', 'stream:1');
    expect(directLookups()).toHaveLength(2);
    expect(player().url).toBe('/api/vidnest?token=fixture-0');
    await vi.advanceTimersByTimeAsync(60_000); await pump();
    expect(directLookups()).toHaveLength(2);
  });

  it('does not report media readiness from Video.js ready or metadata alone', async () => {
    props = { ...props, onReady: vi.fn(), onError: vi.fn() }; await remount();
    expect(props.onReady).not.toHaveBeenCalled();
    player().readiness = 1; player().emit('loadedmetadata'); await pump();
    expect(props.onReady).not.toHaveBeenCalled();
    player().readiness = 2; player().emit('loadeddata'); await pump();
    expect(props.onReady).toHaveBeenCalledOnce();
    player().readyCallback(); player().emit('loadedmetadata'); player().emit('canplay'); await pump();
    expect(props.onReady).toHaveBeenCalledOnce();
  });

  it('retains a manual quality chosen before catalog arrival instead of taking a faster recommendation', async () => {
    const pending = deferred<Response>(); await mountCatalog(pending.promise);
    liveOptions(); await ready(23);
    await choose('Quality', 'quality:720');
    pending.resolve(catalogResponse([stream('0', 720, 'en', 'en', 900), stream('1', 480, 'en', 'en', 10)])); await pump();
    expect(harness.players).toHaveLength(1); expect(player().src).not.toHaveBeenCalled();
    expect(select('Quality').props.value).toBe('quality:720');
    expect(player().qualityList[0].enabled).toBe(true); expect(player().qualityList[1].enabled).toBe(false);
  });

  it('cancels stale catalog token requests without reinitializing media or resetting any manual choice', async () => {
    const oldCatalog = deferred<Response>(); const nextCatalog = deferred<Response>();
    await mountCatalog(oldCatalog.promise, '/catalog?token=old'); liveOptions(); await ready(27.5);
    await choose('Quality', 'quality:720'); await choose('Audio', 'de::'); await choose('Subtitles', 'es::');
    const instance = player(); instance.rate = 1.5; instance.stopped = false;
    const signal = harness.fetch.mock.calls.find(([url]) => url === '/catalog?token=old')![1].signal as AbortSignal;
    harness.fetch.mockImplementation((url: string) => url === '/catalog?token=new' ? nextCatalog.promise
      : Promise.resolve({ ok: true, json: async () => ({ tracks: [] }) } as Response));
    props = { ...props, source: { ...props.source, streamCatalogUrl: '/catalog?token=new' }, subtitleCatalogUrl: '/subtitles?token=new',
      onReady: vi.fn(), onError: vi.fn(), titleName: 'Updated metadata' };
    render(); await pump();
    expect(signal.aborted).toBe(true); expect(harness.players).toHaveLength(1); expect(instance.src).not.toHaveBeenCalled();
    oldCatalog.resolve(catalogResponse([stream('stale', 240, 'en', 'en', 1)]));
    nextCatalog.resolve(catalogResponse([stream('0', 720, 'de', 'es', 900), stream('1', 480, 'en', 'en', 1)])); await pump();
    for (const [label, value] of [['Quality', 'quality:720'], ['Audio', 'de::'], ['Subtitles', 'es::']] as const) {
      await panel(label); retainedOption(label, value);
    }
    expect(instance.position).toBe(27.5); expect(instance.rate).toBe(1.5); expect(instance.stopped).toBe(false);
    expect(JSON.stringify(tree)).not.toContain('stale');
  });

  it('keeps selected values present in the real select during remove/add list churn and repeated ready events', async () => {
    liveOptions(); await ready(24);
    await choose('Quality', 'quality:720'); await choose('Audio', 'de::'); await choose('Subtitles', 'es::');
    liveOptions([], [], []); await pump();
    for (const [label, value] of [['Quality', 'quality:720'], ['Audio', 'de::'], ['Subtitles', 'es::']] as const) {
      await panel(label); retainedOption(label, value);
    }
    liveOptions();
    for (let index = 0; index < 5; index += 1) {
      player().readyCallback(); player().emit('loadedmetadata'); player().emit('loadeddata'); player().emit('canplay');
      for (const list of [player().qualityList, player().audioList, player().textList]) list.emit('change');
      await pump();
    }
    expect(harness.players).toHaveLength(1); expect(player().src).not.toHaveBeenCalled();
    expect(player().qualityList[0].enabled).toBe(true); expect(player().qualityList[1].enabled).toBe(false);
    expect(player().audioList[1].enabled).toBe(true); expect(player().audioList[0].enabled).toBe(false);
    expect(player().textList[1].mode).toBe('hidden');
  });

  it.each([true, false])('preserves same-episode manual selections, time, rate and paused=%s through source replacement', async (paused) => {
    props = { ...props, titleId: 'show', episodeId: 'metadata-old', seasonNumber: 1, episodeNumber: 2 }; await remount();
    liveOptions(); await ready(46.75); await choose('Quality', 'quality:720'); await choose('Audio', 'de::'); await choose('Subtitles', 'es::');
    const instance = player(); instance.rate = 1.5; instance.stopped = paused; instance.emit('timeupdate');
    harness.write.mockClear();
    props = { ...props, episodeId: 'metadata-new', source: { url: '/replacement.m3u8', kind: 'hls' }, onReady: vi.fn(), onError: vi.fn() };
    render(); await pump();
    expect(harness.players).toHaveLength(1); expect(instance.disposed).toBe(false); expect(instance.src).toHaveBeenCalledOnce();
    instance.emit('timeupdate'); instance.emit('pause'); await pump();
    expect(harness.write.mock.calls.some((args) => args[2] === 0)).toBe(false);
    liveOptions(); instance.readiness = 2; instance.emit('loadedmetadata'); instance.emit('loadeddata'); await pump();
    expect(instance.position).toBe(46.75); expect(instance.rate).toBe(1.5); expect(instance.stopped).toBe(paused);
    for (const [label, value] of [['Quality', 'quality:720'], ['Audio', 'de::'], ['Subtitles', 'es::']] as const) {
      await panel(label); retainedOption(label, value);
    }
  });

  it('rejects an incompatible manual combination visibly and keeps the previous playable selection', async () => {
    await mountCatalog([stream('0', 720), stream('1', 480, 'de')]); liveOptions([720], ['en'], ['en']); await ready(12);
    await choose('Quality', 'quality:720'); await choose('Audio', 'de::');
    expect(player().src).not.toHaveBeenCalled(); expect(select('Audio').props.value).toBe('en::');
    expect(nodes().some((node) => node.props?.role === 'alert')).toBe(true);
    await panel('Quality'); expect(select('Quality').props.value).toBe('quality:720');
  });

  it('does not fall back to Auto or another URL after a failed manual rendition, even after repeated ready/list errors', async () => {
    await mountCatalog([stream('0', 720), stream('1', 480, 'en', 'en', 1)]); liveOptions([720, 1080], ['en'], ['en']); await ready(18);
    await choose('Quality', 'quality:720');
    player().src.mockClear();
    fail(); await pump();
    for (let index = 0; index < 5; index += 1) {
      player().emit('error'); player().readyCallback(); player().emit('loadedmetadata'); player().emit('canplay');
      player().qualityList.emit('change'); await pump();
    }
    expect(player().src).not.toHaveBeenCalled(); expect(props.onError).toHaveBeenCalledOnce();
    retainedOption('Quality', 'quality:720'); expect(JSON.stringify(tree)).not.toContain('private.example');
  });

  it.each([['Audio', 'de::'], ['Subtitles', 'fr::']] as const)('does not auto-switch again when a manual %s source fails', async (label, value) => {
    await mountCatalog([stream('0', 720), stream('1', 720, 'de', 'fr', 10), stream('2', 480, 'de', 'fr', 20)]);
    liveOptions([720], ['en'], ['en']); await ready(18);
    await choose(label, value); expect(player().src).toHaveBeenCalledOnce();
    fail(); player().emit('error'); await pump();
    expect(player().src).toHaveBeenCalledOnce(); expect(props.onError).toHaveBeenCalledOnce();
    expect(select(label).props.value).toBe(value);
  });

  it('turns a manual rendition API exception into one honest error instead of an unhandled list/reload loop', async () => {
    props = { ...props, onError: vi.fn() }; await remount(); liveOptions([720]); await ready(9);
    Object.defineProperty(player().qualityList[0], 'enabled', { configurable: true, get: () => false, set: () => { throw new Error('private rendition error'); } });
    await panel('Quality');
    expect(() => select('Quality').props.onChange('quality:720')).not.toThrow(); await pump();
    for (let index = 0; index < 5; index += 1) { player().qualityList.emit('change'); player().readyCallback(); await pump(); }
    expect(props.onError).toHaveBeenCalledOnce(); expect(player().src).not.toHaveBeenCalled();
    retainedOption('Quality', 'quality:720');
  });

  it('stops an unexpected rendition fallback instead of repeatedly re-enabling a failed manual rendition', async () => {
    props = { ...props, onError: vi.fn() }; await remount(); liveOptions([720, 1080]); await ready(22);
    await choose('Quality', 'quality:720'); player().stopped = false; player().emit('timeupdate');
    player().qualityList[0].enabled = false; player().qualityList[1].enabled = true; player().qualityList.selectedIndex = 1;
    player().qualityList.emit('change'); await pump();
    expect(props.onError).toHaveBeenCalledOnce(); expect(player().stopped).toBe(true); expect(player().src).not.toHaveBeenCalled();
    expect(player().qualityList[0].enabled).toBe(false); retainedOption('Quality', 'quality:720');
    for (let index = 0; index < 5; index += 1) { player().qualityList.emit('change'); player().readyCallback(); await pump(); }
    expect(props.onError).toHaveBeenCalledOnce(); expect(player().qualityList[0].enabled).toBe(false);
  });

  it('bounds Auto error recovery to one replacement and one fatal callback, then permits exactly one user Retry', async () => {
    await mountCatalog([stream('0', 720, 'en', 'en', 100), stream('1', 720, 'en', 'en', 200), stream('2', 720, 'en', 'en', 300)]);
    liveOptions([720], ['en'], ['en']); await ready(31.5);
    player().rate = 1.5; player().stopped = false; player().emit('timeupdate');
    player().src.mockClear(); fail(); await pump();
    expect(player().src).toHaveBeenCalledOnce();
    // No actual MediaError on the replacement: a stale event is not a second failure.
    player().emit('error'); player().readyCallback(); await pump(); expect(player().src).toHaveBeenCalledOnce();
    fail(); await pump(); expect(props.onError).toHaveBeenCalledOnce(); expect(player().src).toHaveBeenCalledOnce();
    for (let index = 0; index < 5; index += 1) { player().emit('error'); player().emit('canplay'); player().readyCallback(); await pump(); }
    expect(props.onError).toHaveBeenCalledOnce(); expect(player().src).toHaveBeenCalledOnce();
    const instance = player(); const failedUrl = instance.url;
    props = { ...props, retryKey: 1 }; render(); await pump();
    expect(harness.players).toHaveLength(1); expect(instance.src).toHaveBeenCalledTimes(2); expect(instance.url).toBe(failedUrl);
    liveOptions([720], ['en'], ['en']); instance.readiness = 2; instance.emit('loadedmetadata'); instance.emit('loadeddata'); await pump();
    expect(instance.position).toBe(31.5); expect(instance.rate).toBe(1.5); expect(instance.stopped).toBe(false);
    expect(props.onReady).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])('terminates no-data playback without MediaError instead of indefinitely cycling the catalog (manual=%s)', async (manual) => {
    await mountCatalog(Array.from({ length: 13 }, (_, index) => stream(String(index), 720, 'en', 'en', 100 + index)));
    expect(player().readiness).toBe(0); expect(player().failure).toBeNull(); expect(props.onReady).not.toHaveBeenCalled();
    if (manual) await choose('Quality', 'quality:720');
    await vi.advanceTimersByTimeAsync(15_000); await pump();
    expect(player().src).toHaveBeenCalledTimes(manual ? 0 : 1);
    if (!manual) { await vi.advanceTimersByTimeAsync(15_000); await pump(); }
    expect(props.onError).toHaveBeenCalledOnce(); expect(props.onReady).not.toHaveBeenCalled();
    expect(nodes().some((node) => typeof node.props?.className === 'string' && node.props.className.startsWith('lumora-player-switch-status'))).toBe(false);
    const requestCount = player().src.mock.calls.length;
    for (let index = 0; index < 5; index += 1) { player().readyCallback(); player().emit('canplay'); player().qualityList.emit('change'); await pump(); }
    await vi.advanceTimersByTimeAsync(90_000); await pump();
    expect(player().src).toHaveBeenCalledTimes(requestCount); expect(props.onError).toHaveBeenCalledOnce(); expect(harness.write).not.toHaveBeenCalled();
    await panel('Quality'); retainedOption('Quality', manual ? 'quality:720' : 'auto');
  });

  it('retains manual quality, audio and subtitles through failure, catalog errors and an explicit Retry', async () => {
    await mountCatalog([stream('0', 720, 'de', 'es'), stream('1', 480, 'de', 'es')]); liveOptions(); await ready(29.75);
    await choose('Quality', 'quality:720'); await choose('Audio', 'de::'); await choose('Subtitles', 'es::');
    player().rate = 1.25; player().stopped = false; player().emit('timeupdate'); fail(); await pump();
    harness.fetch.mockResolvedValue({ ok: false, status: 503 } as Response);
    props = { ...props, source: { ...props.source, streamCatalogUrl: '/catalog?token=changed' } }; render(); await pump();
    for (let index = 0; index < 5; index += 1) { player().readyCallback(); player().emit('loadedmetadata'); player().audioList.emit('change'); await pump(); }
    expect(props.onError).toHaveBeenCalledOnce(); expect(player().src).not.toHaveBeenCalled(); expect(harness.players).toHaveLength(1);
    props = { ...props, retryKey: 1 }; render(); await pump(); expect(player().src).toHaveBeenCalledOnce();
    liveOptions(); player().readiness = 2; player().emit('loadedmetadata'); player().emit('loadeddata'); await pump();
    expect(player().position).toBe(29.75); expect(player().rate).toBe(1.25); expect(player().stopped).toBe(false);
    for (const [label, value] of [['Quality', 'quality:720'], ['Audio', 'de::'], ['Subtitles', 'es::']] as const) {
      await panel(label); retainedOption(label, value);
    }
  });

  it('does not retry a terminal failure merely because a parent supplies refreshed source tokens or source IDs', async () => {
    props = { ...props, onError: vi.fn(), onReady: vi.fn() }; await remount(); liveOptions(); await ready(19);
    await choose('Quality', 'quality:720'); fail(); await pump();
    const instance = player();
    props = { ...props, source: { url: '/refreshed.m3u8?token=new', kind: 'hls' }, selectedSourceId: 'replacement-from-parent' };
    render(); await pump(); instance.readyCallback(); instance.emit('loadeddata'); await pump();
    expect(instance.src).not.toHaveBeenCalled(); expect(props.onError).toHaveBeenCalledOnce(); expect(props.onReady).toHaveBeenCalledOnce();
    props = { ...props, retryKey: 1 }; render(); await pump();
    expect(instance.src).toHaveBeenCalledOnce(); expect(instance.url).toBe('/refreshed.m3u8?token=new');
    liveOptions(); instance.readiness = 2; instance.emit('loadedmetadata'); instance.emit('loadeddata'); await pump(); retainedOption('Quality', 'quality:720');
  });

  it('handles a synchronous manual source failure once and retries the requested source rather than reverting to Auto', async () => {
    await mountCatalog([stream('0', 480), stream('1', 720)]); liveOptions([480], ['en'], ['en']); await ready(17.5);
    player().src.mockImplementationOnce(() => { throw new Error('private source failure'); });
    await choose('Quality', 'quality:720'); expect(props.onError).toHaveBeenCalledOnce(); expect(player().src).toHaveBeenCalledOnce();
    retainedOption('Quality', 'quality:720'); expect(JSON.stringify(tree)).not.toContain('private source');
    props = { ...props, retryKey: 1 }; render(); await pump();
    expect(player().src).toHaveBeenCalledTimes(2); expect(player().url).toBe('/fixture-1.m3u8');
    liveOptions([720], ['en'], ['en']); player().readiness = 2; player().emit('loadedmetadata'); player().emit('loadeddata'); await pump();
    expect(player().position).toBe(17.5); retainedOption('Quality', 'quality:720');
  });

  it('deduplicates old-source errors while Auto waits for PiP exit before its single replacement', async () => {
    const leave = deferred<void>();
    await mountCatalog([stream('0', 720), stream('1', 480)]); liveOptions([720]); await ready(21);
    enableStandardPictureInPicture(); await pump(); keydown('i'); await pump(); expect(player().isPip).toBe(true);
    const instance = player(); instance.exitPictureInPicture = vi.fn(() => leave.promise.then(() => {
      instance.isPip = false; instance.emit('leavepictureinpicture');
    }));
    fail(); await pump();
    for (let index = 0; index < 5; index += 1) { instance.emit('error'); instance.readyCallback(); await pump(); }
    expect(instance.src).not.toHaveBeenCalled(); expect(props.onError).not.toHaveBeenCalled();
    leave.resolve(); await pump(); expect(instance.src).toHaveBeenCalledOnce();
    fail(); await pump(); expect(instance.src).toHaveBeenCalledOnce(); expect(props.onError).toHaveBeenCalledOnce();
  });

  it('only reinitializes a failed player setup after the user explicitly retries', async () => {
    harness.createFailures = 1; props = { ...props, retryKey: 0, onError: vi.fn(), onReady: vi.fn() }; await remount();
    expect(harness.players).toHaveLength(0); expect(props.onError).toHaveBeenCalledOnce();
    props = { ...props, titleName: 'New metadata', source: { url: '/fresh.mp4', kind: 'mp4' } }; render(); await pump();
    expect(harness.players).toHaveLength(0); expect(props.onError).toHaveBeenCalledOnce();
    props = { ...props, retryKey: 1 }; render(); await pump(); expect(harness.players).toHaveLength(1);
    await ready(3); expect(props.onReady).toHaveBeenCalledOnce();
  });

  it('resets only for a real episode change and flushes the previous episode under its original identity', async () => {
    props = { ...props, viewerKey: 'account:fixture', titleId: 'show', episodeId: 'episode-two', seasonNumber: 1, episodeNumber: 2 };
    await remount(); liveOptions(); await ready(28); await choose('Quality', 'quality:720');
    const previous = player(); harness.report.mockClear(); harness.write.mockClear();
    props = { ...props, episodeId: 'episode-three', episodeNumber: 3, source: { url: '/next-episode.m3u8', kind: 'hls' } }; render(); await pump();
    expect(previous.disposed).toBe(true); expect(harness.players).toHaveLength(2);
    expect(harness.report).toHaveBeenCalledWith(expect.objectContaining({ episodeId: 'episode-two', positionSeconds: 28 }));
    expect(harness.write).toHaveBeenCalledWith('account:fixture', 'fixture-media:show:1:2', 28, 120, true);
    await panel('Quality'); expect(select('Quality').props.value).toBe('auto');
  });

  it('offers every numbered stream with no declared tracks and keeps unlabeled muxed audio enabled', async () => {
    const catalog = [stream('0', 720), stream('1', 720), stream('2', 480)].map((entry) => ({ ...entry, audioTracks: [], subtitles: [] }));
    await mountCatalog(catalog); liveOptions([720], [], []);
    const muxed = { id: 'main', label: '', language: '', enabled: true };
    player().audioList[0] = muxed; player().audioList.length = 1;
    await ready(21); await panel('Audio');
    expect(nodes(select('Audio')).filter((node) => node.type === 'option' && String(node.props.value).startsWith('stream:')).map((node) => node.props.children))
      .toEqual(['Audio stream 1', 'Audio stream 2', 'Audio stream 3']);
    expect(nodes().some((node) => node.props?.children === 'Select different audio streams to find your preferred audio.')).toBe(true);
    expect(JSON.stringify(tree)).not.toContain('Default audio');
    await choose('Audio', 'stream:0');
    player().audioList[0] = muxed; player().audioList.length = 1;
    player().readiness = 2; player().emit('loadedmetadata'); player().emit('canplay'); await pump();
    expect(muxed.enabled).toBe(true); retainedOption('Audio', 'stream:0');
  });

  it.each([true, false])('preserves numbered-source time, rate, pause=%s and compatible captions', async (paused) => {
    await mountCatalog([stream('0', 720), stream('1', 720)]); liveOptions([720], ['en'], ['en']); await ready(33.75);
    await choose('Subtitles', 'en::');
    const instance = player(); instance.rate = 1.5; instance.stopped = paused; instance.emit('timeupdate');
    await choose('Audio', 'stream:1'); expect(instance.url).toBe('/fixture-1.m3u8');
    liveOptions([720], ['en'], ['en']); instance.readiness = 2; instance.emit('loadedmetadata'); instance.emit('canplay'); await pump();
    expect(instance.position).toBe(33.75); expect(instance.rate).toBe(1.5); expect(instance.stopped).toBe(paused);
    expect(instance.audioList[0].enabled).toBe(true); expect(instance.textList[0].mode).toBe('hidden');
    await panel('Audio'); retainedOption('Audio', 'stream:1');
  });

  it('holds a numbered pin through late catalog additions, repeated readiness and source-token refresh', async () => {
    await mountCatalog([stream('0', 720), stream('1', 720)]); liveOptions([720]); await ready(31);
    await choose('Audio', 'stream:1'); liveOptions([720]); player().readiness = 2; player().emit('loadedmetadata'); player().emit('canplay'); await pump();
    await choose('Quality', 'auto');
    const instance = player(); const calls = instance.src.mock.calls.length;
    harness.fetch.mockResolvedValue(catalogResponse([stream('0', 720, 'en', 'en', 1),
      { ...stream('1', 720, 'en', 'en', 900), url: '/refreshed-index-1.m3u8' }, stream('2', 480, 'en', 'en', 2)]));
    props = { ...props, source: { ...props.source, url: '/incoming-auto.m3u8?token=new', streamCatalogUrl: '/catalog?token=new' } };
    render(); await pump();
    for (let index = 0; index < 4; index += 1) { instance.readyCallback(); instance.emit('loadedmetadata'); instance.emit('canplay'); instance.audioList.emit('change'); await pump(); }
    expect(instance.src).toHaveBeenCalledTimes(calls); expect(instance.url).toBe('/fixture-1.m3u8');
    await panel('Audio'); retainedOption('Audio', 'stream:1');
    await choose('Quality', 'auto'); expect(instance.src).toHaveBeenCalledTimes(calls);
    await choose('Audio', 'auto'); await choose('Quality', 'auto');
    expect(instance.url).toBe('/fixture-0.m3u8');
  });

  it('rejects numbered 4K conflicts visibly and retains both the previous source and manual quality', async () => {
    await mountCatalog([stream('0', 2160), stream('1', 720)]); liveOptions([2160], ['en'], ['en']); await ready(18);
    await choose('Quality', 'quality:2160'); await choose('Audio', 'stream:1');
    expect(player().src).not.toHaveBeenCalled();
    expect(nodes().some((node) => node.props?.role === 'alert' && String(node.props.children).includes('independent audio'))).toBe(true);
    await panel('Quality'); retainedOption('Quality', 'quality:2160');
    await choose('Audio', 'stream:0'); liveOptions([2160]); player().readiness = 2; player().emit('loadedmetadata'); player().emit('canplay'); await pump();
    await choose('Quality', 'quality:720'); expect(player().url).toBe('/fixture-0.m3u8'); retainedOption('Quality', 'quality:2160');
  });

  it('retains an explicit numbered choice through failure and Retry, never automatic recovery', async () => {
    await mountCatalog([stream('0', 720), stream('1', 720)]); liveOptions([720]); await ready(22);
    await choose('Audio', 'stream:1'); liveOptions([720]); player().readiness = 2; player().emit('loadedmetadata'); player().emit('canplay'); await pump();
    const calls = player().src.mock.calls.length; fail(); await pump();
    expect(player().src).toHaveBeenCalledTimes(calls); expect(props.onError).toHaveBeenCalledOnce();
    props = { ...props, retryKey: 1 }; render(); await pump();
    expect(player().src).toHaveBeenCalledTimes(calls + 1); expect(player().url).toBe('/fixture-1.m3u8');
    await panel('Audio'); retainedOption('Audio', 'stream:1');
  });

  it('does not carry a numbered pin to an explicitly changed playback source or episode', async () => {
    props = { ...props, selectedSourceId: 'primary' };
    await mountCatalog([stream('0', 720), stream('1', 720)]); liveOptions([720]); await ready(22);
    await choose('Audio', 'stream:1');
    props = { ...props, selectedSourceId: 'backup', source: { url: '/backup.m3u8', kind: 'hls' } }; render(); await pump();
    expect(player().url).toBe('/backup.m3u8'); await panel('Audio'); expect(select('Audio').props.value).not.toBe('stream:1');
    props = { ...props, seasonNumber: 1, episodeNumber: 3 }; render(); await pump();
    await panel('Audio'); expect(select('Audio').props.value).not.toBe('stream:1');
  });
});
