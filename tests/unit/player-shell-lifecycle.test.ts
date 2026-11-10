import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlayerShellProps } from '@/features/player/PlayerShell';
import type { PlaybackSource } from '@/lib/providers/types';
import type { EpisodeNavigation } from '@/features/player/episode-navigation';
import { readConsent, writeConsent } from '@/lib/consent';
import { DEFAULT_SETTINGS } from '@/features/account/types';

const harness = vi.hoisted(() => ({
  slots: [] as any[], cursor: 0, effects: [] as Array<() => void>, dirty: false,
  refresh: vi.fn(), push: vi.fn(), record: vi.fn(), report: vi.fn(), fetch: vi.fn(), storageGet: vi.fn(), storageSet: vi.fn(), storageRemove: vi.fn(), preferenceSave: vi.fn(),
  consentRaw: null as string | null,
  partyOptions: vi.fn(),
  native: () => null, controls: () => null,
  party: { state: { room: null, participants: [], phase: 'idle' }, registerPlayerPort: vi.fn() } as any,
}));
vi.mock('react', async (original) => {
  const actual = await original<typeof import('react')>();
  const equal = (left?: unknown[], right?: unknown[]) => Boolean(left && right && left.length === right.length && left.every((value, index) => Object.is(value, right[index])));
  return {
    ...actual,
    useRef(value: unknown) { const index = harness.cursor++; return harness.slots[index] ??= { current: value }; },
    useState(initial: unknown) {
      const index = harness.cursor++;
      if (!harness.slots[index]) harness.slots[index] = { value: typeof initial === 'function' ? initial() : initial };
      return [harness.slots[index].value, (next: unknown) => {
        const value = typeof next === 'function' ? next(harness.slots[index].value) : next;
        if (!Object.is(value, harness.slots[index].value)) { harness.slots[index].value = value; harness.dirty = true; }
      }];
    },
    useCallback(callback: unknown, dependencies: unknown[]) {
      const index = harness.cursor++; const previous = harness.slots[index];
      if (!previous || !equal(previous.dependencies, dependencies)) harness.slots[index] = { callback, dependencies };
      return harness.slots[index].callback;
    },
    useEffect(effect: () => void | (() => void), dependencies?: unknown[]) {
      const index = harness.cursor++; const previous = harness.slots[index];
      if (previous && equal(previous.dependencies, dependencies)) return;
      harness.slots[index] = { dependencies, cleanup: previous?.cleanup };
      harness.effects.push(() => { harness.slots[index].cleanup?.(); harness.slots[index].cleanup = effect(); });
    },
  };
});
vi.mock('next/navigation', () => {
  const router = { refresh: harness.refresh, push: harness.push };
  return { useRouter: () => router };
});
vi.mock('next/link', () => ({ default: () => null }));
vi.mock('@/features/player/NativePlayer', () => ({ NativePlayer: harness.native }));
vi.mock('@/features/player/PlayerControlsBar', () => ({ PlayerControlsBar: harness.controls }));
vi.mock('@/features/ads/PreRollAd', () => ({ PreRollAd: () => null }));
vi.mock('@/features/watch-party/web', () => ({ WatchPartyPanel: () => null, useWatchPartySession: (options: { configured?: boolean }) => {
  harness.partyOptions(options);
  return { ...harness.party, available: options.configured === true };
} }));
vi.mock('@/features/playback/guest-watch', () => ({ recordGuestWatch: harness.record }));
vi.mock('@/features/playback/session-actions', () => ({
  reportPlaybackStartAction: vi.fn(async () => ({ ok: false })), reportPlaybackEndAction: vi.fn(async () => undefined),
  reportPlaybackHeartbeatAction: vi.fn(),
}));
vi.mock('@/features/playback/report-actions', () => ({ reportPlaybackIssueAction: harness.report }));
vi.mock('@/features/account/preference-actions', () => ({ saveAccountPreferencesAction: harness.preferenceSave }));

import { PlayerShell } from '@/features/player/PlayerShell';

let props: PlayerShellProps;
let tree: any;
function nodes(node = tree): any[] {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap((child) => nodes(child));
  return [node, ...nodes(node.props?.children ?? [])];
}
function render() { harness.cursor = 0; harness.dirty = false; tree = PlayerShell(props); }
async function pump() {
  for (let index = 0; index < 15; index += 1) {
    while (harness.effects.length) harness.effects.shift()!();
    await Promise.resolve();
    if (harness.dirty) render();
  }
}
const native = () => nodes().find((node) => node.type === harness.native);
const iframe = () => nodes().find((node) => node.type === 'iframe');
const controls = () => nodes().find((node) => node.type === harness.controls);
const unavailable = () => nodes().find((node) => typeof node.props?.onRetry === 'function' && typeof node.props?.message === 'string');
const consent = () => nodes().find((node) => typeof node.props?.onLoad === 'function' && typeof node.props?.providerName === 'string');
const loading = () => nodes().some((node) => typeof node.type === 'function' && node.type.name === 'PlayerLoadingOverlay');
const direct: PlaybackSource = { id: 'native', url: '/fixture.m3u8?token=one', kind: 'hls', label: 'Server 1', providerId: 'direct', consentRequired: false,
  capabilities: { fullscreen: true, qualitySelection: true, subtitles: true, audioTracks: true, playbackRate: true,
    episodeSelection: false, providerResume: false, telemetry: true, skipMarkers: false } };
const embedded: PlaybackSource = { id: 'embed', url: 'https://embed.example/movie', kind: 'embed', label: 'Server 2', providerId: 'embed', consentRequired: true,
  capabilities: { ...direct.capabilities, qualitySelection: false, subtitles: false, audioTracks: false, playbackRate: false, telemetry: false } };
const CONSENT_KEY = 'lumora.consent.v1';
const AD_GRANT = { necessary: true as const, analytics: false, ads: true, decidedAt: '2026-11-07T12:00:00.000Z' };

beforeEach(async () => {
  vi.useFakeTimers(); harness.slots = []; harness.effects = []; harness.cursor = 0; harness.dirty = false;
  harness.refresh.mockClear(); harness.record.mockClear();
  harness.push.mockReset(); harness.fetch.mockReset(); harness.fetch.mockResolvedValue({ ok: true, json: async () => null });
  harness.consentRaw = null;
  harness.storageGet.mockReset().mockImplementation((key: string) => key === CONSENT_KEY ? harness.consentRaw : null);
  harness.storageSet.mockReset().mockImplementation((key: string, value: string) => { if (key === CONSENT_KEY) harness.consentRaw = value; });
  harness.storageRemove.mockReset().mockImplementation((key: string) => { if (key === CONSENT_KEY) harness.consentRaw = null; });
  harness.report.mockReset(); harness.report.mockResolvedValue({ ok: true }); harness.partyOptions.mockClear();
  harness.preferenceSave.mockReset().mockImplementation(async (accountId, changes) => ({ ok: true,
    snapshot: { accountId, settings: { ...DEFAULT_SETTINGS, ...changes }, hasSavedPreferences: true } }));
  harness.party.state = { room: null, participants: [], phase: 'idle' };
  vi.stubGlobal('fetch', harness.fetch);
  const consentEvents = new EventTarget();
  vi.stubGlobal('window', { setTimeout, clearTimeout, setInterval, clearInterval,
    location: new URL('https://app.example/watch/tv/fixture?season=1&episode=2'),
    localStorage: { getItem: harness.storageGet, setItem: harness.storageSet, removeItem: harness.storageRemove },
    addEventListener: vi.fn(consentEvents.addEventListener.bind(consentEvents)),
    removeEventListener: vi.fn(consentEvents.removeEventListener.bind(consentEvents)),
    dispatchEvent: consentEvents.dispatchEvent.bind(consentEvents) });
  writeConsent(null); harness.storageGet.mockClear(); harness.storageRemove.mockClear();
  vi.stubGlobal('sessionStorage', { getItem: () => null, setItem: vi.fn() });
  props = { title: { id: 'fixture', slug: 'fixture', type: 'tv', name: 'Fixture' }, source: direct,
    sources: [direct, embedded], viewerKey: 'guest', seasonNumber: 1, episodeNumber: 2 };
  render(); await pump();
});
afterEach(() => {
  for (const slot of harness.slots) slot?.cleanup?.();
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals();
});

describe('shell advertising consent subscription', () => {
  const preroll = { adsterraKey: 'synthetic-zone', width: 320, height: 50 };
  const advertisement = () => nodes().find((node) => node.props?.adsterraKey === preroll.adsterraKey);
  async function mount(source: PlaybackSource = direct, grant = true) {
    for (const slot of harness.slots) slot?.cleanup?.();
    harness.slots = []; harness.effects = [];
    props = { ...props, source, sources: [source], preroll };
    writeConsent(grant ? AD_GRANT : null);
    render(); await pump();
  }

  it('ends the current pre-roll on withdrawal and resumes an already allowed native source without another ad gate', async () => {
    await mount(); expect(advertisement()).toBeDefined(); expect(native()).toBeUndefined();
    writeConsent(null); await pump();
    expect(advertisement()).toBeUndefined(); expect(native().props.source.url).toBe(direct.url);
    writeConsent(AD_GRANT); await pump();
    expect(advertisement()).toBeUndefined(); expect(native().props.source.url).toBe(direct.url);
  });

  it('never treats ad consent as provider consent and does not revoke a separately accepted source', async () => {
    await mount(embedded); expect(consent()).toBeDefined(); expect(iframe()).toBeUndefined();
    writeConsent(null); await pump(); expect(consent()).toBeDefined(); expect(iframe()).toBeUndefined();
    writeConsent(AD_GRANT); await pump(); expect(consent()).toBeDefined(); expect(iframe()).toBeUndefined();
    consent().props.onLoad(); await pump(); const source = iframe().props.src;
    writeConsent(null); await pump(); expect(iframe().props.src).toBe(source); expect(consent()).toBeUndefined();
  });

  it.each(['malformed', 'inaccessible'])('removes an active pre-roll for %s storage without accepting event-payload permission', async (kind) => {
    await mount(); expect(advertisement()).toBeDefined();
    if (kind === 'inaccessible') {
      Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new Error('storage blocked'); } });
      window.dispatchEvent(new Event('pageshow'));
    } else {
      harness.consentRaw = '{"ads":true}';
      const event = new Event('storage'); Object.defineProperties(event, { key: { value: CONSENT_KEY }, newValue: { value: JSON.stringify(AD_GRANT) } });
      window.dispatchEvent(event);
    }
    await pump(); expect(readConsent()).toBeNull(); expect(advertisement()).toBeUndefined(); expect(native()).toBeDefined();
  });

  it('removes replaced and unmounted subscriptions and ignores retained old callbacks', async () => {
    await mount();
    const old = vi.mocked(window.addEventListener).mock.calls.filter(([name]) => name === 'lumora:consent-change').at(-1)![1] as EventListener;
    props = { ...props, preroll: { ...preroll } }; render(); await pump();
    expect(window.removeEventListener).toHaveBeenCalledWith('lumora:consent-change', old);
    harness.storageGet.mockClear(); old(new Event('lumora:consent-change')); expect(harness.storageGet).not.toHaveBeenCalled();
    for (const slot of harness.slots) { slot?.cleanup?.(); if (slot) slot.cleanup = undefined; }
    harness.dirty = false; window.dispatchEvent(new Event('focus'));
    expect(harness.storageGet).not.toHaveBeenCalled(); expect(harness.dirty).toBe(false);
  });
});

describe('typed native party wiring', () => {
  const media = { kind: 'episode' as const, mediaId: '10000000-0000-4000-8000-000000000001', seasonNumber: 1, episodeNumber: 2 };

  it.each(['connected', 'reconnecting', 'idle'])('forwards the server identity and real registration callback while %s', async (phase) => {
    props = { ...props, title: { ...props.title, id: media.mediaId }, watchPartyConfigured: true, watchPartyMedia: media };
    harness.party.state.phase = phase; render(); await pump();
    expect(native().props.watchPartyMedia).toBe(media);
    expect(native().props.registerPartyPlayerPort).toBe(harness.party.registerPlayerPort);
    expect(native().props.watchPartyActive).toBe(phase === 'connected');
  });

  it('does not activate an unconfigured service or fabricate a UUID for virtual media', async () => {
    props = { ...props, title: { ...props.title, id: 'tmdb-tv-123' }, watchPartyConfigured: false };
    harness.party.state.phase = 'connected'; render(); await pump();
    expect(native().props.watchPartyActive).toBe(false);
    expect(native().props.watchPartyMedia).toBeNull();
  });

  it('does not mount a native party bridge before consent', async () => {
    const source = { ...direct, id: 'consented-native', consentRequired: true };
    props = { ...props, source, sources: [source], watchPartyConfigured: true, watchPartyMedia: media };
    render(); await pump();
    expect(native()).toBeUndefined(); expect(consent()).toBeDefined();
    consent().props.onLoad(); await pump(); expect(native().props.watchPartyMedia).toBe(media);
  });
});

describe('web shell fatal errors and explicit Retry', () => {
  it('renders a verified legacy next-episode target without accessing browser globals during SSR', () => {
    props = { ...props, episodeNavigationUrl: undefined,
      nextEpisode: { label: 'Next episode', name: 'Episode 3', season: 1, episode: 3 } };
    harness.slots = []; harness.effects = [];
    vi.stubGlobal('window', undefined);
    expect(() => render()).not.toThrow();
    expect(native().props.episodeNavigation?.next).toMatchObject({
      seasonNumber: 1, episodeNumber: 3, href: '/watch/tv/fixture?season=1&episode=3',
    });
  });

  it('keeps NativePlayer mounted on fatal errors, never selects an embed, and ignores late ready callbacks', async () => {
    const initial = native(); initial.props.onReady(); await pump();
    const active = native(); active.props.onError(); active.props.onError(); await pump();
    expect(unavailable()).toBeDefined(); expect(native()).toBeDefined(); expect(iframe()).toBeUndefined();
    expect(controls().props.selectedSourceId).toBe('native'); expect(native().key).toBe(initial.key);
    expect(native().props.onReady).toBe(initial.props.onReady); expect(native().props.onError).toBe(initial.props.onError);
    for (let index = 0; index < 5; index += 1) { active.props.onReady(); active.props.onError(); await pump(); }
    await vi.advanceTimersByTimeAsync(12_000); await pump();
    expect(unavailable()).toBeDefined(); expect(native().props.retryKey).toBe(0); expect(iframe()).toBeUndefined();
  });

  it('retries native playback once in place instead of remounting and resetting preferences', async () => {
    const initial = native(); initial.props.onError(); await pump();
    unavailable().props.onRetry(); await pump();
    expect(unavailable()).toBeUndefined(); expect(native().key).toBe(initial.key); expect(native().props.retryKey).toBe(1);
    expect(native().props.source.url).toBe(direct.url); expect(iframe()).toBeUndefined();
    expect(native().props.registerPartyPlayerPort).toBe(harness.party.registerPlayerPort);
    native().props.onError(); native().props.onReady(); await pump();
    expect(unavailable()).toBeDefined(); expect(native().props.retryKey).toBe(1);
  });

  it('does not pretend native media is ready after the shell loading timeout', async () => {
    expect(loading()).toBe(true);
    await vi.advanceTimersByTimeAsync(12_000); await pump();
    expect(loading()).toBe(true);
  });

  it('retains the same native key for catalog/source token and same-episode metadata replacements', async () => {
    const initial = native();
    props = { ...props, episodeId: 'metadata-new', title: { ...props.title, name: 'Updated fixture' },
      source: { ...direct, url: '/fixture.m3u8?token=two', streamCatalogUrl: '/catalog?token=two' } };
    render(); await pump();
    expect(native().key).toBe(initial.key); expect(native().props.retryKey).toBe(0);
    expect(native().props.source.url).toBe('/fixture.m3u8?token=two'); expect(native().props.onReady).toBe(initial.props.onReady);
  });

  it('keeps the last explicitly selected source through catalog-list churn rather than silently returning to the default', async () => {
    const alternate = { ...direct, id: 'alternate', label: 'Server 3', url: '/alternate.m3u8' };
    props = { ...props, sources: [direct, alternate, embedded] }; render(); await pump();
    controls().props.onSelectSource('alternate'); await pump();
    const selected = native(); expect(selected.props.source.url).toBe('/alternate.m3u8');
    props = { ...props, sources: [direct, embedded] }; render(); await pump();
    expect(native().props.source.url).toBe('/alternate.m3u8'); expect(native().key).toBe(selected.key);
    expect(controls().props.selectedSourceId).toBe('alternate');
    expect(controls().props.sources.some((source: PlaybackSource) => source.id === 'alternate')).toBe(true);
  });
});

describe('web shell embed failure and consent fences', () => {
  it('requires an explicit source choice and consent before mounting any external iframe after a native error', async () => {
    native().props.onError(); await pump(); expect(iframe()).toBeUndefined(); expect(consent()).toBeUndefined();
    controls().props.onSelectSource('embed'); await pump();
    expect(consent()).toBeDefined(); expect(iframe()).toBeUndefined(); expect(native()).toBeUndefined();
    consent().props.onLoad(); await pump(); expect(iframe()?.props.src).toBe(embedded.url);
  });

  it('never loops embeds on error; late load is ignored and user Retry remounts only the selected iframe', async () => {
    const second = { ...embedded, id: 'second', url: 'https://second.example/movie', consentRequired: false };
    props = { ...props, source: { ...embedded, consentRequired: false }, sources: [{ ...embedded, consentRequired: false }, second] };
    render(); await pump(); const initial = iframe(); expect(initial).toBeDefined();
    initial.props.onError(); initial.props.onError(); await pump();
    expect(unavailable()).toBeDefined(); expect(controls().props.selectedSourceId).toBe('embed');
    initial.props.onLoad(); await pump(); expect(unavailable()).toBeDefined();
    unavailable().props.onRetry(); await pump(); const retried = iframe();
    expect(retried.props.src).toBe(embedded.url); expect(retried.key).not.toBe(initial.key);
    initial.props.onError(); initial.props.onLoad(); await pump(); expect(unavailable()).toBeUndefined();
    retried.props.onError(); await pump(); expect(unavailable()).toBeDefined(); expect(controls().props.selectedSourceId).toBe('embed');
  });

  it('does not reuse embed consent across an origin replacement even if provider and source IDs remain unchanged', async () => {
    props = { ...props, source: embedded, sources: [embedded] }; render(); await pump();
    consent().props.onLoad(); await pump(); expect(iframe()).toBeDefined();
    const replaced = { ...embedded, url: 'https://replacement.example/movie' };
    props = { ...props, source: replaced, sources: [replaced] }; render(); await pump();
    expect(consent()).toBeDefined(); expect(iframe()).toBeUndefined();
  });
});

const EPISODE_URL = '/api/episode-navigation?type=tv&tmdbId=123&season=1&episode=2';
const AUTO_NEXT_KEY = 'lumora:player:auto-next:v1';
const episodeTarget = (episode: number) => ({ seasonNumber: 1, episodeNumber: episode,
  name: `Verified fixture ${episode}`, href: `/watch/tv/fixture?season=1&episode=${episode}` });
const verifiedNavigation: EpisodeNavigation = { previous: episodeTarget(1), next: episodeTarget(3) };
const navigationResponse = (body: unknown) => ({ ok: true, json: async () => body }) as Response;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
async function loadNavigation(body: unknown = verifiedNavigation) {
  harness.fetch.mockResolvedValue(navigationResponse(body));
  props = { ...props, episodeNavigationUrl: EPISODE_URL }; render(); await pump();
}
async function remountShell() {
  for (const slot of harness.slots) slot?.cleanup?.();
  harness.slots = []; harness.effects = []; harness.cursor = 0; harness.dirty = false;
  render(); await pump();
}

describe('verified web episode navigation', () => {
  it('fetches outside Native init and makes verified controls available without waiting for the stream', async () => {
    const initial = native(); await loadNavigation();
    expect(loading()).toBe(true); expect(native().key).toBe(initial.key);
    expect(controls().props.episodeNavigation.next).toEqual(verifiedNavigation.next);
    expect(harness.fetch).toHaveBeenCalledWith(EPISODE_URL, expect.objectContaining({ cache: 'no-store', credentials: 'same-origin', redirect: 'error', signal: expect.any(AbortSignal) }));
    expect(controls().props.episodeNavigation.onNavigate('next')).toBe(true); await pump();
    expect(harness.push).toHaveBeenCalledWith(verifiedNavigation.next!.href);
  });

  it('does not refetch or remount for late stream readiness, Retry, source-token refresh or same-episode metadata', async () => {
    await loadNavigation(); const initial = native();
    native().props.onReady(); await pump(); native().props.onError(); await pump(); unavailable().props.onRetry(); await pump();
    props = { ...props, episodeId: 'late-episode-id', title: { ...props.title, name: 'New label' }, source: { ...direct, url: '/fixture.m3u8?token=refreshed' } };
    render(); await pump();
    expect(harness.fetch).toHaveBeenCalledOnce(); expect(native().key).toBe(initial.key);
    expect(controls().props.episodeNavigation.previous).toEqual(verifiedNavigation.previous);
  });

  it('aborts an old episode lookup and synchronously excludes its late result on a real episode change', async () => {
    const old = deferred<Response>(); const current = deferred<Response>();
    harness.fetch.mockImplementationOnce(() => old.promise).mockImplementationOnce(() => current.promise);
    props = { ...props, episodeNavigationUrl: EPISODE_URL }; render(); await pump();
    const oldSignal = harness.fetch.mock.calls[0]![1].signal as AbortSignal;
    props = { ...props, episodeNumber: 3, episodeNavigationUrl: EPISODE_URL.replace('episode=2', 'episode=3') };
    render(); await pump(); expect(oldSignal.aborted).toBe(true); expect(controls().props.episodeNavigation).toBeUndefined();
    old.resolve(navigationResponse(verifiedNavigation)); await pump(); expect(controls().props.episodeNavigation).toBeUndefined();
    current.resolve(navigationResponse({ previous: episodeTarget(2), next: episodeTarget(4) })); await pump();
    expect(controls().props.episodeNavigation.next.episodeNumber).toBe(4);
  });

  it('bounds a pending response body and ignores it after timeout without delaying media', async () => {
    const body = deferred<unknown>();
    harness.fetch.mockResolvedValue({ ok: true, json: () => body.promise });
    props = { ...props, episodeNavigationUrl: EPISODE_URL }; render(); await pump();
    native().props.onReady(); await pump(); expect(loading()).toBe(false);
    await vi.advanceTimersByTimeAsync(10_001); await pump();
    expect(harness.fetch.mock.calls[0]![1].signal.aborted).toBe(true);
    body.resolve(verifiedNavigation); await pump(); expect(controls().props.episodeNavigation).toBeUndefined();
  });

  it('omits episode controls, Auto Next and the lookup for movies even if optional episode props are supplied', async () => {
    props = { ...props, title: { ...props.title, type: 'movie' }, seasonNumber: undefined, episodeNumber: undefined,
      episodeNavigationUrl: EPISODE_URL, nextEpisode: { season: 1, episode: 3, label: 'S1 E3', name: 'Verified fixture 3' } };
    render(); await pump();
    expect(harness.fetch).not.toHaveBeenCalled(); expect(controls().props.episodeNavigation).toBeUndefined();
    expect(native().props.onAutoNextChange).toBeUndefined(); expect(native().props.upNext).toBeUndefined();
    native().props.onContentEnded(); await pump(); expect(harness.push).not.toHaveBeenCalled();
  });

  it('never sends a navigation request to a different origin', async () => {
    props = { ...props, episodeNavigationUrl: 'https://untrusted.example/api/episode-navigation' }; render(); await pump();
    expect(harness.fetch).not.toHaveBeenCalled(); expect(controls().props.episodeNavigation).toBeUndefined();
  });

  it.each([
    ['other series', { ...verifiedNavigation, previous: null, next: { ...episodeTarget(3), href: '/watch/tv/other?season=1&episode=3' } }],
    ['other origin', { ...verifiedNavigation, next: { ...episodeTarget(3), href: 'https://other.example/watch/tv/fixture?season=1&episode=3' } }],
    ['wrong direction', { ...verifiedNavigation, next: episodeTarget(1) }],
    ['current episode', { ...verifiedNavigation, next: episodeTarget(2) }],
    ['mismatched coordinates', { ...verifiedNavigation, next: { ...episodeTarget(3), episodeNumber: 4 } }],
    ['duplicate query', { ...verifiedNavigation, next: { ...episodeTarget(3), href: '/watch/tv/fixture?season=1&episode=3&episode=4' } }],
    ['party injection', { ...verifiedNavigation, next: { ...episodeTarget(3), href: '/watch/tv/fixture?season=1&episode=3&party=code' } }],
    ['unreported name', { ...verifiedNavigation, next: { ...episodeTarget(3), name: '' } }],
    ['extra provider field', { ...verifiedNavigation, sourceUrl: 'https://provider.example/stream' }],
  ])('rejects %s rather than inventing or navigating an unverified episode', async (_label, body) => {
    await loadNavigation(body); expect(controls().props.episodeNavigation).toBeUndefined();
    expect(native().props.upNext).toBeUndefined(); expect(native().props.onNavigateEpisode('next')).toBe(false);
    expect(harness.push).not.toHaveBeenCalled();
  });

  it('uses explicit verified null boundaries rather than guessing the next episode', async () => {
    await loadNavigation({ previous: episodeTarget(1), next: null });
    expect(controls().props.episodeNavigation.next).toBeNull(); expect(native().props.upNext).toBeUndefined();
    expect(native().props.onNavigateEpisode('next')).toBe(false);
    expect(native().props.onNavigateEpisode('previous')).toBe(true); await pump();
    expect(harness.push).toHaveBeenCalledWith(episodeTarget(1).href);
  });

  it('uses verified specials and cross-season targets without assuming consecutive episodes', async () => {
    const previous = { seasonNumber: 0, episodeNumber: 8, name: 'Verified special', href: '/watch/tv/fixture?season=0&episode=8' };
    const next = { seasonNumber: 2, episodeNumber: 1, name: 'Verified season premiere', href: '/watch/tv/fixture?season=2&episode=1' };
    await loadNavigation({ previous, next });
    expect(controls().props.episodeNavigation.previous).toEqual(previous); expect(controls().props.episodeNavigation.next).toEqual(next);
    expect(controls().props.episodeNavigation.onNavigate('next')).toBe(true); await pump();
    expect(harness.push).toHaveBeenCalledWith(next.href);
  });

  it('flushes the native checkpoint before routing and latches one transition across repeated Next/Prev clicks', async () => {
    await loadNavigation(); const flushed = deferred<boolean>(); const events: string[] = [];
    const prepare = vi.fn(() => { events.push('checkpoint'); return flushed.promise; });
    harness.push.mockImplementation(() => events.push('navigate'));
    native().props.registerEpisodeTransition(prepare);
    const navigate = controls().props.episodeNavigation.onNavigate;
    expect(navigate('next')).toBe(true); expect(navigate('next')).toBe(false); expect(navigate('previous')).toBe(false);
    await pump(); expect(harness.push).not.toHaveBeenCalled(); expect(controls().props.episodeNavigation.pending).toBe(true);
    flushed.resolve(true); await pump();
    expect(prepare).toHaveBeenCalledOnce(); expect(harness.push).toHaveBeenCalledOnce(); expect(events).toEqual(['checkpoint', 'navigate']);
  });

  it('allows explicit retry after a rejected player transition or router failure', async () => {
    await loadNavigation(); const prepare = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    native().props.registerEpisodeTransition(prepare);
    controls().props.episodeNavigation.onNavigate('next'); await pump();
    expect(harness.push).not.toHaveBeenCalled(); expect(controls().props.episodeNavigation.pending).toBe(false);
    harness.push.mockImplementationOnce(() => { throw new Error('Router unavailable'); });
    controls().props.episodeNavigation.onNavigate('next'); await pump(); expect(controls().props.episodeNavigation.pending).toBe(false);
    controls().props.episodeNavigation.onNavigate('next'); await pump();
    expect(prepare).toHaveBeenCalledTimes(3); expect(harness.push).toHaveBeenCalledTimes(2);
  });

  it('rejects a pending transition and old callbacks after media changes or unmount', async () => {
    await loadNavigation(); const flushed = deferred<boolean>(); const oldNative = native();
    oldNative.props.registerEpisodeTransition(() => flushed.promise); oldNative.props.onAutoNextChange(true); await pump();
    const oldNavigate = controls().props.episodeNavigation.onNavigate;
    oldNavigate('next'); await pump();
    props = { ...props, episodeNumber: 3, episodeNavigationUrl: EPISODE_URL.replace('episode=2', 'episode=3') };
    render(); await pump(); flushed.resolve(true); await pump();
    expect(harness.push).not.toHaveBeenCalled(); expect(oldNavigate('next')).toBe(false);
    oldNative.props.onContentEnded(); await pump(); expect(harness.push).not.toHaveBeenCalled();
    for (const slot of harness.slots) slot?.cleanup?.();
    expect(native().props.onNavigateEpisode('previous')).toBe(false);
  });

  it('does not finish an awaited transition after a party joins', async () => {
    await loadNavigation(); const flushed = deferred<boolean>(); native().props.registerEpisodeTransition(() => flushed.promise);
    controls().props.episodeNavigation.onNavigate('next'); await pump();
    harness.party.state = { room: { id: 'party' }, participants: [], phase: 'connected' }; render(); await pump();
    flushed.resolve(true); await pump(); expect(harness.push).not.toHaveBeenCalled();
  });
});

describe('opt-in web Auto Next and party fences', () => {
  it('defaults OFF, persists explicit opt-in under a versioned key, and navigates once only on a content-ended signal', async () => {
    await loadNavigation(); expect(native().props.autoNext).toBe(false);
    native().props.onContentEnded(); native().props.onContentEnded(); await pump(); expect(harness.push).not.toHaveBeenCalled();
    native().props.onAutoNextChange(true); await pump();
    expect(harness.storageSet).toHaveBeenCalledWith(AUTO_NEXT_KEY, 'true'); expect(native().props.autoNext).toBe(true);
    const prepare = vi.fn(async () => true); native().props.registerEpisodeTransition(prepare);
    native().props.onContentEnded(); native().props.onContentEnded(); await pump();
    expect(prepare).toHaveBeenCalledOnce(); expect(harness.push).toHaveBeenCalledOnce();
  });

  it.each([null, 'true ', '1', 'false', 'invalid'])('keeps Auto Next OFF for non-opt-in storage value %s', async (value) => {
    harness.storageGet.mockReturnValue(value); props = { ...props, episodeNavigationUrl: EPISODE_URL };
    await remountShell(); expect(native().props.autoNext).toBe(false);
  });

  it('restores only the saved true value and honors an explicit uncheck before the next render', async () => {
    harness.storageGet.mockReturnValue('true'); harness.fetch.mockResolvedValue(navigationResponse(verifiedNavigation));
    props = { ...props, episodeNavigationUrl: EPISODE_URL }; await remountShell();
    expect(native().props.autoNext).toBe(true); expect(harness.storageGet).toHaveBeenCalledWith(AUTO_NEXT_KEY);
    native().props.onAutoNextChange(false); native().props.onContentEnded(); await pump();
    expect(harness.storageSet).toHaveBeenCalledWith(AUTO_NEXT_KEY, 'false'); expect(harness.push).not.toHaveBeenCalled();
  });

  it('keeps the explicit session choice usable when preference storage throws', async () => {
    await loadNavigation(); harness.storageSet.mockImplementation(() => { throw new Error('Storage blocked'); });
    native().props.onAutoNextChange(true); await pump(); expect(native().props.autoNext).toBe(true);
    native().props.onContentEnded(); await pump(); expect(harness.push).toHaveBeenCalledOnce();
  });

  it.each(['ticketing', 'connecting', 'reconnecting', 'connected'])('blocks independent manual/automatic navigation in party phase %s', async (phase) => {
    await loadNavigation(); native().props.onAutoNextChange(true); await pump();
    harness.party.state = { room: phase === 'connected' ? { id: 'party', hostParticipantId: 'other' } : null, participants: [], phase };
    render(); await pump(); expect(controls().props.episodeNavigation.disabled).toBe(true); expect(native().props.autoNext).toBe(false);
    expect(controls().props.episodeNavigation.onNavigate('next')).toBe(false);
    native().props.onAutoNextChange(false); native().props.onContentEnded(); await pump();
    expect(harness.push).not.toHaveBeenCalled(); expect(harness.storageSet).toHaveBeenCalledTimes(1);
  });
});

describe('account-scoped Auto Next preferences', () => {
  const accountA = '10000000-0000-4000-8000-000000000001';
  const accountB = '20000000-0000-4000-8000-000000000002';
  const snapshot = (accountId: string, enabled: boolean) => ({ accountId,
    settings: { ...DEFAULT_SETTINGS, autoplayNext: enabled }, hasSavedPreferences: true });
  async function mount(enabled = false) {
    props = { ...props, viewerKey: `account:${accountA}`, initialAccountPreferences: snapshot(accountA, enabled),
      nextEpisode: { label: 'Next', name: 'Next verified episode', season: 1, episode: 3 } };
    await remountShell();
  }

  it('applies the verified server preference during SSR without reading guest storage', async () => {
    await mount(true);
    harness.slots = []; harness.effects = []; harness.storageGet.mockClear();
    vi.stubGlobal('window', undefined);
    render(); expect(native().props.autoNext).toBe(true);
    expect(harness.storageGet).not.toHaveBeenCalled();
    expect(harness.preferenceSave).not.toHaveBeenCalled();
  });

  it('uses account preferences for profile-qualified viewer keys and navigates only at content end', async () => {
    await mount(true);
    props = { ...props, viewerKey: `account:${accountA}:profile:profile-one` }; render(); await pump();
    expect(native().props.autoNext).toBe(true); expect(harness.push).not.toHaveBeenCalled();
    native().props.onContentEnded(); await pump(); expect(harness.push).toHaveBeenCalledWith(episodeTarget(3).href);
  });

  it('never substitutes a guest or other account preference for an unavailable/mismatched account', async () => {
    harness.storageGet.mockReturnValue('true'); await mount(false); harness.storageGet.mockClear();
    for (const viewerKey of [`account:${accountB}`, 'unavailable']) {
      props = { ...props, viewerKey }; render(); await pump();
      expect(native().props.autoNext).toBe(false);
      native().props.onContentEnded(); await pump(); expect(harness.push).not.toHaveBeenCalled();
    }
    expect(harness.storageGet).not.toHaveBeenCalledWith(AUTO_NEXT_KEY);
  });

  it('persists only an account autoplay patch, never the guest key, and immediately honors uncheck', async () => {
    await mount(true); harness.storageSet.mockClear();
    native().props.onAutoNextChange(false); native().props.onContentEnded(); await pump();
    expect(harness.push).not.toHaveBeenCalled();
    expect(harness.preferenceSave).toHaveBeenCalledExactlyOnceWith(accountA, { autoplayNext: false });
    expect(harness.storageSet).not.toHaveBeenCalled();
    expect(native().props.autoNext).toBe(false);
    expect(nodes().some((node) => node.props?.children === 'Auto Next saved to your account.')).toBe(true);
  });

  it('serializes rapid changes so a delayed earlier save cannot overwrite the latest toggle', async () => {
    await mount(false);
    const first = deferred<any>(); harness.preferenceSave.mockImplementationOnce(() => first.promise);
    native().props.onAutoNextChange(true); native().props.onAutoNextChange(false); await pump();
    expect(harness.preferenceSave).toHaveBeenCalledTimes(1); expect(native().props.autoNext).toBe(false);
    first.resolve({ ok: true, snapshot: snapshot(accountA, true) }); await pump();
    expect(harness.preferenceSave.mock.calls).toEqual([[accountA, { autoplayNext: true }], [accountA, { autoplayNext: false }]]);
    expect(native().props.autoNext).toBe(false);
  });

  it('cancels an automatic transition disabled while the checkpoint is flushing, without blocking manual Next', async () => {
    await mount(true);
    const flushed = deferred<boolean>(); native().props.registerEpisodeTransition(() => flushed.promise);
    native().props.onContentEnded(); await pump();
    native().props.onAutoNextChange(false); flushed.resolve(true); await pump();
    expect(harness.push).not.toHaveBeenCalled();
    expect(native().props.onNavigateEpisode('next')).toBe(true); await pump();
    expect(harness.push).toHaveBeenCalledOnce();
  });

  it.each(['failed', 'thrown'])('retains an explicit session choice but truthfully reports a %s account save', async (failure) => {
    await mount(false);
    if (failure === 'failed') harness.preferenceSave.mockResolvedValue({ ok: false, reason: 'unavailable', message: 'synthetic error' });
    else harness.preferenceSave.mockRejectedValue(new Error('synthetic private detail'));
    native().props.onAutoNextChange(true); await pump();
    expect(native().props.autoNext).toBe(true);
    expect(nodes().some((node) => node.props?.role === 'alert' && String(node.props.children).includes('save was not confirmed'))).toBe(true);
    expect(harness.storageSet).not.toHaveBeenCalled();
  });

  it('fences old identity callbacks and pending saves, including returning to the first account', async () => {
    await mount(false);
    const oldSave = deferred<any>(); harness.preferenceSave.mockImplementationOnce(() => oldSave.promise);
    const oldNative = native(); oldNative.props.onAutoNextChange(true); await pump();
    props = { ...props, viewerKey: `account:${accountB}`, initialAccountPreferences: snapshot(accountB, false) };
    render(); expect(native().props.autoNext).toBe(false);
    oldNative.props.onAutoNextChange(true); oldNative.props.onContentEnded(); await pump();
    expect(harness.push).not.toHaveBeenCalled(); expect(harness.preferenceSave).toHaveBeenCalledTimes(1);
    props = { ...props, viewerKey: `account:${accountA}`, initialAccountPreferences: snapshot(accountA, false) }; render(); await pump();
    native().props.onAutoNextChange(true); await pump();
    expect(harness.preferenceSave).toHaveBeenCalledTimes(2);
    oldSave.resolve({ ok: false, reason: 'unavailable', message: 'stale failure' }); await pump();
    expect(nodes().some((node) => node.props?.children === 'Auto Next saved to your account.')).toBe(true);
  });

  it('keeps account Auto Next disabled in a connected party without changing the saved preference', async () => {
    await mount(true);
    harness.party.state = { phase: 'connected', room: { id: 'party' }, participants: [] }; render(); await pump();
    expect(native().props.autoNext).toBe(false);
    native().props.onAutoNextChange(false); native().props.onContentEnded(); await pump();
    expect(harness.preferenceSave).not.toHaveBeenCalled(); expect(harness.push).not.toHaveBeenCalled();
    harness.party.state = { phase: 'idle', room: null, participants: [] }; render(); await pump();
    expect(native().props.autoNext).toBe(true);
  });

  it('never saves unavailable identity choices as guest choices or as a guessed account', async () => {
    props = { ...props, viewerKey: `account:${accountA}`, initialAccountPreferences: null };
    render(); await pump(); native().props.onAutoNextChange(true); await pump();
    expect(native().props.autoNext).toBe(true); expect(harness.preferenceSave).not.toHaveBeenCalled();
    expect(harness.storageSet).not.toHaveBeenCalled();
    expect(nodes().some((node) => node.props?.role === 'alert' && String(node.props.children).includes('could not be loaded'))).toBe(true);
  });
});

describe('verified episode buttons', () => {
  it('renders real 44px buttons with exact targets and disabled null/party/pending guards', async () => {
    const { EpisodeControls } = await vi.importActual<typeof import('@/features/player/PlayerControlsBar')>('@/features/player/PlayerControlsBar');
    const navigate = vi.fn();
    const buttons = (configuration: Parameters<typeof EpisodeControls>[0]) => nodes(EpisodeControls(configuration)).filter((node) => node.type === 'button');
    const enabled = buttons({ ...verifiedNavigation, onNavigate: navigate });
    expect(enabled[0].props.className).toContain('min-h-11'); expect(enabled[1].props.className).toContain('min-w-11');
    expect(enabled[0].props['aria-label']).toBe('Previous episode (S1 E1)'); expect(enabled[1].props.title).toBe(verifiedNavigation.next!.name);
    enabled[0].props.onClick(); enabled[1].props.onClick(); expect(navigate.mock.calls).toEqual([['previous'], ['next']]);
    navigate.mockClear();
    for (const configuration of [{ ...verifiedNavigation, disabled: true }, { ...verifiedNavigation, pending: true }, { previous: null, next: null }]) {
      for (const button of buttons({ ...configuration, onNavigate: navigate })) { expect(button.props.disabled).toBeTruthy(); button.props.onClick(); }
    }
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('truthful report release gates', () => {
  it('fails closed before the initial report action even if a disabled callback is called directly', async () => {
    expect(controls().props.reportingAvailable).toBe(false);
    controls().props.onReportIssue(); await pump();
    props = { ...props, source: null, sources: [] }; render(); await pump();
    expect(unavailable().props.reportDisabled).toBe(true);
    unavailable().props.onReport(); await pump();
    expect(harness.report).not.toHaveBeenCalled(); expect(controls().props.reported).toBe(false);
  });

  it('waits for confirmed success and coalesces repeated clicks without exposing source tokens', async () => {
    const result = deferred<{ ok: boolean }>(); harness.report.mockReturnValue(result.promise);
    props = { ...props, reportingAvailable: true }; render(); await pump();
    const report = controls().props.onReportIssue;
    report(); report(); await pump();
    expect(harness.report).toHaveBeenCalledOnce(); expect(controls().props.reportPending).toBe(true);
    expect(controls().props.reported).toBe(false);
    expect(harness.report.mock.calls[0]![0]).toEqual({ titleId: 'fixture', serverLabel: 'Server 1', playerState: 'loading' });
    expect(JSON.stringify(harness.report.mock.calls)).not.toContain('token=');
    result.resolve({ ok: true }); await pump();
    expect(controls().props.reported).toBe(true); expect(controls().props.reportPending).toBe(false);
    controls().props.onReportIssue(); await pump(); expect(harness.report).toHaveBeenCalledOnce();
  });

  it.each(['failed result', 'rejected action'])('never acknowledges %s and leaves an explicit retry available', async (failure) => {
    if (failure === 'failed result') harness.report.mockResolvedValue({ ok: false });
    else harness.report.mockRejectedValue(new Error('private backend details'));
    props = { ...props, reportingAvailable: true }; render(); await pump();
    controls().props.onReportIssue(); await pump();
    expect(controls().props.reported).toBe(false); expect(controls().props.reportPending).toBe(false);
    expect(controls().props.reportError).toBe('Your report could not be sent. Please try again.');
    expect(controls().props.reportError).not.toContain('private');
    harness.report.mockResolvedValue({ ok: true }); controls().props.onReportIssue(); await pump();
    expect(controls().props.reported).toBe(true);
  });

  it.each(['Retry', 'episode change', 'source change', 'availability revoked', 'unmount'])('ignores a confirmed old action after %s', async (change) => {
    const result = deferred<{ ok: boolean }>(); harness.report.mockReturnValue(result.promise);
    props = { ...props, reportingAvailable: true }; render(); await pump();
    controls().props.onReportIssue(); await pump();
    if (change === 'Retry') { native().props.onError(); await pump(); unavailable().props.onRetry(); await pump(); }
    else if (change === 'episode change') { props = { ...props, episodeNumber: 3 }; render(); await pump(); }
    else if (change === 'source change') { controls().props.onSelectSource('embed'); await pump(); }
    else if (change === 'availability revoked') { props = { ...props, reportingAvailable: false }; render(); await pump(); }
    else { for (const slot of harness.slots) slot?.cleanup?.(); }
    result.resolve({ ok: true }); await pump();
    expect(controls().props.reported).toBe(false);
    expect(controls().props.reportError).toBeUndefined();
  });

  it('rejects an old report callback as soon as availability is revoked', async () => {
    props = { ...props, reportingAvailable: true }; render(); await pump(); const oldReport = controls().props.onReportIssue;
    props = { ...props, reportingAvailable: false }; render(); oldReport(); await pump();
    expect(harness.report).not.toHaveBeenCalled(); expect(controls().props.reported).toBe(false);
  });

  it.each(['guest', 'unavailable', 'account:viewer'])('forwards only configured party availability independently of viewer %s and source kind', async (viewerKey) => {
    for (const source of [direct, embedded, null]) {
      props = { ...props, source, sources: source ? [source] : [], viewerKey, watchPartyConfigured: true };
      render(); await pump(); expect(controls().props.watchParty.available).toBe(true);
      expect(harness.partyOptions.mock.lastCall?.[0]).toMatchObject({ configured: true });
      props = { ...props, watchPartyConfigured: false }; render(); await pump();
      expect(controls().props.watchParty.available).toBe(false);
    }
    expect(harness.fetch).not.toHaveBeenCalled();
  });
});
