import { existsSync, readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContinueEntry, HomeData, Title } from '../../mobile/src/lib/types';

type Bridge = Pick<typeof import('../../mobile/src/lib/catalog-bridge'), 'fetchHome' | 'getCachedHome'>;
type Node = { type: unknown; props: Record<string, unknown> };
const canonical = new URL('../../../lumora-mobile/src/', import.meta.url);
const variants = [{ name: 'mirror', root: new URL('../../mobile/src/', import.meta.url) },
  ...(existsSync(canonical) ? [{ name: 'canonical', root: canonical }] : [])];
const title: Title = { id: 'tmdb:movie:123', type: 'movie', tmdbId: '123', slug: 'film-123', name: 'Public film',
  synopsis: 'Real public synopsis', releaseYear: 2026, maturity: 'PG-13', genres: ['Drama'], originCountries: ['IN'] };
const wire = (item: Title | null = title) => ({ hero: item, heroTitles: item ? [item] : [],
  rows: item ? [{ id: 'trending', heading: 'Trending now', titles: [item] }] : [], collections: [],
  signedIn: false, continueWatching: [], forYou: null, degraded: false });
const json = (value: unknown = wire(), headers: Record<string, string> = {}, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'public, s-maxage=60', ...headers },
});
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }

function load(file: URL, dependencies: Record<string, unknown>, fetch: typeof globalThis.fetch): Record<string, unknown> {
  const exports: Record<string, unknown> = {};
  const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  runInNewContext(code, { exports, fetch, URL, URLSearchParams, AbortController, Response, Request, Headers, Date, Promise, setTimeout, clearTimeout,
    require: (id: string) => { if (!(id in dependencies)) throw new Error(`Unexpected dependency: ${id}`); return dependencies[id]; },
  }, { filename: file.pathname });
  return exports;
}

function bridge(root: URL) {
  const runtime = { WEB_URL: 'https://catalog.example', webRuntimeConfig: { available: true } };
  const legacy = { fetchHome: vi.fn<() => Promise<HomeData>>().mockResolvedValue({ hero: [], rows: [] }),
    listTitles: vi.fn(), searchTitles: vi.fn(), getTitleBySlug: vi.fn(), listSeasons: vi.fn(), listCast: vi.fn(),
    currentUser: vi.fn<() => Promise<{ id: string } | null>>().mockResolvedValue(null),
    fetchContinueWatching: vi.fn<() => Promise<ContinueEntry[]>>().mockResolvedValue([]), listAllGenres: vi.fn().mockResolvedValue([]) };
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => json());
  const api = load(new URL('lib/catalog-bridge.ts', root), { './api': legacy, './runtime-config': runtime }, fetch) as Bridge;
  return { api, fetch, legacy, runtime, root };
}

function screen(subject: ReturnType<typeof bridge>) {
  type Hook = { value?: unknown; deps?: unknown[]; callback?: unknown; cleanup?: () => void };
  const hooks: Hook[] = [];
  const effects: Array<() => void> = [];
  let cursor = 0;
  let dirty = false;
  let tree: unknown;
  let focus!: () => () => void;
  let blur: (() => void) | undefined;
  const changed = (previous: unknown[] | undefined, next: unknown[]) => !previous || next.some((value, index) => value !== previous[index]);
  const react = {
    useState: (initial: unknown) => {
      const index = cursor++;
      if (!hooks[index]) hooks[index] = { value: typeof initial === 'function' ? initial() : initial };
      return [hooks[index].value, (value: unknown) => {
        const next = typeof value === 'function' ? value(hooks[index].value) : value;
        if (next !== hooks[index].value) { hooks[index].value = next; dirty = true; }
      }];
    },
    useRef: (initial: unknown) => { const index = cursor++; hooks[index] ??= { value: { current: initial } }; return hooks[index].value; },
    useCallback: (callback: unknown, deps: unknown[]) => {
      const index = cursor++;
      if (changed(hooks[index]?.deps, deps)) hooks[index] = { callback, deps };
      return hooks[index].callback;
    },
    useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
      const index = cursor++;
      if (changed(hooks[index]?.deps, deps)) {
        const previous = hooks[index]?.cleanup;
        hooks[index] = { deps };
        effects.push(() => { previous?.(); hooks[index].cleanup = effect() || undefined; });
      }
    },
  };
  const element = (type: unknown, props: Record<string, unknown>) => ({ type, props });
  const guest = vi.fn<() => Promise<ContinueEntry[]>>().mockResolvedValue([]);
  const components = Object.fromEntries(['EmptyState', 'FilterChip', 'IconButton', 'Notice', 'Screen', 'SectionTitle'].map((name) => [name, name]));
  const exports = load(new URL('screens/HomeScreen.tsx', subject.root), {
    react, 'react/jsx-runtime': { jsx: element, jsxs: element, Fragment: 'Fragment' },
    'react-native': { RefreshControl: 'RefreshControl', ScrollView: 'ScrollView', Text: 'Text', View: 'View', StyleSheet: { create: (styles: unknown) => styles } },
    '@react-navigation/native': { useNavigation: () => ({ navigate: vi.fn() }), useFocusEffect: (callback: typeof focus) => { focus = callback; } },
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) },
    '../theme': { colors: { primary: '#fff', surfaceRaised: '#222', contentMuted: '#aaa' }, spacing: (size: number) => size * 4, type: { h1: {}, small: {} } },
    '../components/ui': components, '../components/Skeletons': { Skeletons: 'Skeletons' },
    '../components/layout': { BROWSE_GAP: 8, useBrowseLayout: () => ({ gutter: 16, width: 390, cardWidth: 100 }) },
    '../components/Hero': { Hero: 'Hero' }, '../components/Row': { Row: 'Row' }, '../components/MediaCard': { MediaCard: 'MediaCard' },
    '../ads/AdMobProvider': { HomeAdMobBanner: 'HomeAdMobBanner' }, '../lib/api': subject.legacy,
    '../lib/catalog-bridge': subject.api, '../lib/guest': { readGuestEntries: guest },
  }, subject.fetch);
  function render() { cursor = 0; dirty = false; tree = (exports.default as () => unknown)(); effects.splice(0).forEach((effect) => effect()); }
  async function flush() { for (let index = 0; index < 30; index++) { await Promise.resolve(); if (dirty) render(); } }
  function find(type: string, node: unknown = tree): Node | null {
    if (Array.isArray(node)) return node.map((item) => find(type, item ?? null)).find(Boolean) ?? null;
    if (!node || typeof node !== 'object' || !('type' in node) || !('props' in node)) return null;
    const item = node as Node;
    return item.type === type ? item : find(type, item.props.children ?? null);
  }
  return { guest, find, flush, serialized: () => JSON.stringify(tree),
    mount: async () => { render(); blur = focus(); await flush(); },
    blur: () => { blur?.(); blur = undefined; },
    refocus: async () => { blur?.(); blur = focus(); await flush(); },
    refresh: async () => {
      const control = find('ScrollView')!.props.refreshControl as Node;
      (control.props.onRefresh as () => void)(); await flush();
    },
    unmount: () => { blur?.(); blur = undefined; hooks.forEach((hook) => hook.cleanup?.()); },
  };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-04T12:00:00Z')); });
afterEach(() => vi.useRealTimers());

it.runIf(existsSync(canonical))('keeps the canonical public-home bridge and HomeScreen mirror byte-synchronized', () => {
  for (const path of ['lib/catalog-bridge.ts', 'screens/HomeScreen.tsx']) {
    expect(readFileSync(new URL(path, canonical), 'utf8')).toBe(readFileSync(new URL(path, variants[0].root), 'utf8'));
  }
});

describe.each(variants)('$name successful anonymous home caching', ({ root }) => {
  it('reduces repeated public loads to one network call within 30s and never renews TTL on a read', async () => {
    const subject = bridge(root);
    const first = await subject.api.fetchHome();
    expect(subject.api.getCachedHome()).toEqual(first);
    expect(subject.api.getCachedHome()).not.toBeInstanceOf(Promise);
    await subject.api.fetchHome();
    await vi.advanceTimersByTimeAsync(29_999);
    await subject.api.fetchHome();
    expect(subject.fetch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(subject.api.getCachedHome()).toBeNull();
    await subject.api.fetchHome();
    expect(subject.fetch).toHaveBeenCalledTimes(2);
    expect(subject.fetch.mock.calls[0][0]).toBe('https://catalog.example/api/catalog?view=home');
    expect(subject.fetch.mock.calls[0][1]).toMatchObject({ method: 'GET', credentials: 'omit', redirect: 'error' });
    expect(subject.fetch.mock.calls[0][1]?.headers).toBeUndefined();
  });

  it('bypasses both settled and HTTP cache on explicit refresh and rejects mutation of returned DTOs', async () => {
    const subject = bridge(root);
    const first = await subject.api.fetchHome();
    first.hero[0].name = 'Private caller mutation';
    expect(subject.api.getCachedHome()?.hero[0].name).toBe(title.name);
    subject.fetch.mockImplementation(async () => json(wire({ ...title, name: 'Fresh public film' })));
    expect((await subject.api.fetchHome({ refresh: true })).hero[0].name).toBe('Fresh public film');
    expect(subject.fetch).toHaveBeenCalledTimes(2);
    expect(subject.fetch.mock.calls[1][1]?.cache).toBe('no-store');
    expect(subject.api.getCachedHome()?.hero[0].name).toBe('Fresh public film');
  });

  it('bounds settled home payloads to three configured origins and 256000 encoded characters', async () => {
    const subject = bridge(root);
    for (let index = 0; index < 4; index++) { subject.runtime.WEB_URL = `https://catalog-${index}.example`; await subject.api.fetchHome(); }
    subject.runtime.WEB_URL = 'https://catalog-0.example';
    expect(subject.api.getCachedHome()).toBeNull();
    await subject.api.fetchHome();
    expect(subject.fetch).toHaveBeenCalledTimes(5);
    subject.runtime.WEB_URL = 'https://catalog-3.example';
    expect(subject.api.getCachedHome()).not.toBeNull();
    subject.runtime.WEB_URL = 'https://oversize.example';
    subject.fetch.mockImplementation(async () => json(wire({ ...title, synopsis: 'x'.repeat(256_000) })));
    await subject.api.fetchHome();
    expect(subject.api.getCachedHome()).toBeNull();
  });

  it.each(['signedIn', 'degraded', 'continueWatching', 'forYou'] as const)('does not cache when explicit public proof %s is missing', async (field) => {
    const subject = bridge(root);
    const incomplete: Record<string, unknown> = wire(); delete incomplete[field];
    subject.fetch.mockImplementation(async () => json(incomplete));
    await subject.api.fetchHome(); await subject.api.fetchHome();
    expect(subject.api.getCachedHome()).toBeNull();
    expect(subject.fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    { ...wire(), degraded: true }, { ...wire(), signedIn: true }, { ...wire(), continueWatching: [{ accountId: 'private' }] },
    { ...wire(), forYou: { accountId: 'private' } }, { ...wire(), accountId: 'private' },
    wire({ ...title, id: '00000000-0000-4000-8000-000000000000' }), wire({ ...title, status: 'draft' } as Title),
    wire({ ...title, originCountries: [{ accountId: 'private' }] } as unknown as Title),
    { ...wire(), rows: [{ ...wire().rows[0], editor: 'private' }] },
  ])('does not retain viewer, draft, editor, UUID fallback or malformed nested payloads', async (home) => {
    const subject = bridge(root);
    subject.fetch.mockImplementation(async () => json(home));
    await subject.api.fetchHome(); await subject.api.fetchHome();
    expect(subject.api.getCachedHome()).toBeNull();
    expect(subject.fetch).toHaveBeenCalledTimes(2);
  });

  it.each([{ 'set-cookie': 'account=private' }, { 'cache-control': 'private, max-age=30' }, { 'cache-control': 'no-store' },
    { 'cache-control': '' }, { vary: 'Cookie' }, { vary: 'Authorization' }, { vary: '*' }])('rejects private/cookie-dependent response caching %j', async (headers) => {
    const subject = bridge(root);
    subject.fetch.mockImplementation(async () => json(wire(), headers));
    await subject.api.fetchHome(); await subject.api.fetchHome();
    expect(subject.api.getCachedHome()).toBeNull();
    expect(subject.fetch).toHaveBeenCalledTimes(2);
  });

  it('does not cache network errors or successful legacy fallback data, and immediately retries public loading', async () => {
    const subject = bridge(root);
    subject.fetch.mockResolvedValueOnce(json({ error: 'private upstream error' }, {}, 503));
    subject.legacy.fetchHome.mockResolvedValue({ hero: [{ ...title, id: 'private-editor-id' }], rows: [] });
    expect((await subject.api.fetchHome()).hero[0].id).toBe('private-editor-id');
    expect(subject.api.getCachedHome()).toBeNull();
    expect((await subject.api.fetchHome()).hero[0].id).toBe(title.id);
    expect(subject.fetch).toHaveBeenCalledTimes(2);
    expect(subject.legacy.currentUser).not.toHaveBeenCalled();
    expect(subject.legacy.fetchContinueWatching).not.toHaveBeenCalled();
  });

  it('never shares pending request promises or allows an older reply to overwrite explicit refresh', async () => {
    const subject = bridge(root);
    const old = deferred<Response>();
    subject.fetch.mockImplementationOnce(() => old.promise);
    const pending = subject.api.fetchHome();
    expect(subject.api.getCachedHome()).toBeNull();
    subject.fetch.mockImplementation(async () => json(wire({ ...title, name: 'Refreshed public film' })));
    await subject.api.fetchHome({ refresh: true });
    expect(subject.fetch).toHaveBeenCalledTimes(2);
    old.resolve(json(wire({ ...title, name: 'Obsolete public film' })));
    await pending;
    expect(subject.api.getCachedHome()?.hero[0].name).toBe('Refreshed public film');
  });

  it('binds a completed public reply to the origin that issued it, not a later runtime URL', async () => {
    const subject = bridge(root);
    const first = deferred<Response>();
    subject.fetch.mockImplementationOnce(() => first.promise);
    const pending = subject.api.fetchHome();
    subject.runtime.WEB_URL = 'https://other-catalog.example';
    first.resolve(json()); await pending;
    expect(subject.api.getCachedHome()).toBeNull();
    subject.runtime.WEB_URL = 'https://catalog.example';
    expect(subject.api.getCachedHome()?.hero[0].id).toBe(title.id);
  });

  it('retains the 8s body deadline and never caches a late settled reply after failure', async () => {
    const subject = bridge(root);
    const body = deferred<unknown>();
    subject.fetch.mockResolvedValueOnce({ ok: true, status: 200, redirected: false, headers: json().headers, json: () => body.promise } as Response);
    const pending = subject.api.fetchHome();
    await vi.advanceTimersByTimeAsync(8000);
    expect(await pending).toEqual({ hero: [], rows: [] });
    expect(subject.api.getCachedHome()).toBeNull();
    expect(subject.fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
    body.resolve(wire());
    await Promise.resolve();
    expect(subject.api.getCachedHome()).toBeNull();
    await subject.api.fetchHome();
    expect(subject.fetch).toHaveBeenCalledTimes(2);
  });
});

describe.each(variants)('$name HomeScreen public focus and private history separation', ({ root }) => {
  it('uses one public network call across back navigation, rereads guest history, refreshes explicitly, and expires after 30s', async () => {
    const subject = bridge(root);
    const view = screen(subject);
    await view.mount(); await view.refocus(); await view.refocus();
    expect(subject.fetch).toHaveBeenCalledOnce();
    expect(subject.legacy.currentUser).toHaveBeenCalledTimes(3);
    expect(view.guest).toHaveBeenCalledTimes(3);
    expect(view.find('Hero')).not.toBeNull();
    await view.refresh();
    expect(subject.fetch).toHaveBeenCalledTimes(2);
    expect(subject.fetch.mock.calls[1][1]?.cache).toBe('no-store');
    await vi.advanceTimersByTimeAsync(30_000); await view.refocus();
    expect(subject.fetch).toHaveBeenCalledTimes(3);
    view.unmount();
  });

  it('shows cached public content immediately even when the account identity read never settles', async () => {
    const subject = bridge(root);
    await subject.api.fetchHome();
    subject.legacy.currentUser.mockImplementation(() => new Promise(() => {}));
    const view = screen(subject); await view.mount();
    expect(view.find('Hero')).not.toBeNull();
    expect(view.find('Skeletons')).toBeNull();
    expect(subject.fetch).toHaveBeenCalledOnce();
    expect(subject.legacy.fetchContinueWatching).not.toHaveBeenCalled();
    view.unmount();
  });

  it('never reuses an account shelf or publishes late history after back navigation changes the viewer', async () => {
    const subject = bridge(root);
    const old = deferred<ContinueEntry[]>();
    subject.legacy.currentUser.mockResolvedValueOnce({ id: 'account-a' }).mockResolvedValue({ id: 'account-b' });
    subject.legacy.fetchContinueWatching.mockImplementationOnce(() => old.promise).mockResolvedValue([{ title: { ...title, name: 'Account B history' } }]);
    const view = screen(subject); await view.mount(); view.blur(); await view.refocus();
    old.resolve([{ title: { ...title, name: 'Private account A history' } }]); await view.flush();
    expect(view.serialized()).toContain('Account B history');
    expect(view.serialized()).not.toContain('Private account A history');
    expect(subject.legacy.fetchContinueWatching).toHaveBeenCalledTimes(2);
    expect(subject.fetch).toHaveBeenCalledOnce();
    expect(JSON.stringify(subject.api.getCachedHome())).not.toContain('history');
    view.unmount();
  });

  it('preserves truthful initial failure and last-loaded refresh-failure presentation instead of caching an error', async () => {
    const subject = bridge(root);
    subject.fetch.mockRejectedValue(new Error('unknown network state'));
    subject.legacy.fetchHome.mockRejectedValue(new Error('unknown catalog state'));
    const view = screen(subject); await view.mount();
    expect(view.serialized()).toContain('Your next watch is a moment away');
    expect(view.find('Hero')).toBeNull();
    subject.fetch.mockImplementation(async () => json()); await view.refresh();
    expect(view.find('Hero')).not.toBeNull();
    subject.fetch.mockRejectedValue(new Error('unknown network state')); await view.refresh();
    expect(view.serialized()).toContain("You're viewing the last loaded titles");
    expect(view.find('Hero')).not.toBeNull();
    expect(subject.api.getCachedHome()).toBeNull();
    view.unmount();
  });
});
