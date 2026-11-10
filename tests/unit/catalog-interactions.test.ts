import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { createElement, type AnchorHTMLAttributes, type ImgHTMLAttributes } from 'react';
import { renderToString } from 'react-dom/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Season, Title } from '@/features/catalog/types';
import type { PersonSearchResult } from '@/features/people/types';

const publicSearch = vi.hoisted(() => ({
  titles: vi.fn(), people: vi.fn(), syncImport: vi.fn(), supabaseImport: vi.fn(),
  autoImport: vi.fn(), adminImport: vi.fn(), adminSync: vi.fn(), client: vi.fn(), mutation: vi.fn(),
}));
vi.mock('@/features/catalog/queries', () => ({ listTitles: publicSearch.titles }));
vi.mock('@/features/people/queries', () => ({ searchPeople: publicSearch.people }));
vi.mock('@/lib/env', () => ({ features: { supabaseConfigured: true, tmdbConfigured: true } }));
vi.mock('@/features/catalog/tmdb-sync', () => {
  publicSearch.syncImport();
  return { importTitlesForSearch: publicSearch.autoImport, importTitleForRequest: publicSearch.adminImport,
    syncCatalogFromTmdb: publicSearch.adminSync };
});
vi.mock('@/lib/supabase/server', () => {
  publicSearch.supabaseImport();
  return { getSupabaseServerClient: publicSearch.client };
});
vi.mock('@/lib/supabase/service', () => {
  publicSearch.supabaseImport();
  return { getSupabaseServiceClient: publicSearch.client };
});
vi.mock('@/lib/supabase/public', () => {
  publicSearch.supabaseImport();
  return { getSupabasePublicClient: publicSearch.client };
});

vi.mock('next/link', () => ({ default: ({ prefetch: _prefetch, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { prefetch?: boolean }) => createElement('a', props) }));
vi.mock('next/image', () => ({ default: ({ fill: _fill, priority: _priority, unoptimized: _unoptimized, ...props }: ImgHTMLAttributes<HTMLImageElement> & { fill?: boolean; priority?: boolean; unoptimized?: boolean }) => createElement('img', props) }));
vi.mock('next/navigation', () => ({ usePathname: () => '/search', useRouter: () => ({ replace: vi.fn() }), useSearchParams: () => new URLSearchParams() }));
vi.mock('@/app/search/actions', () => ({ searchTitlesAction: vi.fn(), searchPeopleAction: vi.fn() }));
vi.mock('@/features/trailers/client', () => ({ loadTrailer: vi.fn() }));
vi.mock('@/features/playback/guest-watch', () => ({ readGuestEntries: vi.fn(() => []) }));
vi.mock('@/features/catalog/requests-actions', () => ({ submitTitleRequestAction: vi.fn() }));
vi.mock('@/features/catalog/components/TrailerPreview', () => ({ TrailerPreview: () => null }));

import { SearchClient } from '@/features/catalog/components/SearchClient';
import { TrailerButton } from '@/features/catalog/components/TrailerButton';
import { ResumePlayButton } from '@/features/catalog/components/ResumePlayButton';
import { RequestForm } from '@/features/catalog/components/RequestForm';

const project = fileURLToPath(new URL('../../', import.meta.url));
const boundaries: Record<string, string> = {
  'next/link': `export default function Link({prefetch, ...props}) {
    return <a {...props} onClick={event => { event.preventDefault(); window.__catalogue.links.push(props.href); }} />;
  }`,
  'next/image': 'export default function Image({fill, priority, unoptimized, ...props}) { return <img {...props} />; }',
  'next/navigation': `
    const router = {replace: (href, options) => window.__catalogue.navigation.push({href, options})};
    export const useRouter = () => router;
    export const usePathname = () => window.__catalogue.pathname;
    export const useSearchParams = () => new URLSearchParams(window.__catalogue.query);
  `,
  '@/app/search/actions': `
    export const searchTitlesAction = query => window.__catalogue.request('titles', query);
    export const searchPeopleAction = query => window.__catalogue.request('people', query);
  `,
  '@/features/trailers/client': "export const loadTrailer = (query, signal) => window.__catalogue.request('trailer', query, signal);",
  '@/features/playback/guest-watch': 'export const readGuestEntries = () => window.__catalogue.guestEntries;',
  '../requests-actions': "export const submitTitleRequestAction = (_state, data) => window.__catalogue.request('request', Object.fromEntries(data));",
  './TrailerPreview': 'export const TrailerPreview = () => null;',
};

// Actual components and React DOM; only framework, actions and guest data are synthetic.
// The browser has a fresh profile and every HTTP request is fulfilled locally or blocked.
const entry = `
  import {createElement} from 'react';
  import {createRoot, hydrateRoot} from 'react-dom/client';
  import {flushSync} from 'react-dom';
  import {SearchClient} from '@/features/catalog/components/SearchClient';
  import {SeasonEpisodeList} from '@/features/catalog/components/SeasonEpisodeList';
  import {TrailerButton} from '@/features/catalog/components/TrailerButton';
  import {HeroCarousel} from '@/features/catalog/components/HeroCarousel';
  import {FilterBar} from '@/features/catalog/components/FilterBar';
  import {DiscoveryFilters} from '@/features/catalog/components/DiscoveryFilters';
  import {ShareButton} from '@/features/catalog/components/ShareButton';
  import {ResumePlayButton} from '@/features/catalog/components/ResumePlayButton';
  import {RequestForm} from '@/features/catalog/components/RequestForm';
  const components = {search: SearchClient, seasons: SeasonEpisodeList, trailer: TrailerButton,
    carousel: HeroCarousel, filters: FilterBar, discovery: DiscoveryFilters, share: ShareButton, resume: ResumePlayButton, request: RequestForm};
  const fixture = window.__catalogue = {requests: [], navigation: [], links: [], errors: [], guestEntries: [],
    pathname: '/search', query: '', request(kind, query, signal) {
      return new Promise((resolve, reject) => this.requests.push({kind, query, signal, resolve, reject, done: false}));
    }};
  const reportError = console.error.bind(console);
  console.error = (...args) => { fixture.errors.push(args.map(value => value?.message ?? String(value)).join(' ')); reportError(...args); };
  window.addEventListener('error', event => fixture.errors.push(event.message));
  window.addEventListener('unhandledrejection', event => fixture.errors.push(String(event.reason)));
  let root;
  const options = {onRecoverableError: error => fixture.errors.push(error.message),
    onUncaughtError: error => fixture.errors.push(error.message)};
  fixture.render = (name, props, hydrate = false) => {
    const children = name === 'carousel' ? [1, 2].map(n => createElement('a', {key: n, href: '#slide-' + n}, 'Title ' + n)) : undefined;
    const element = createElement(components[name], props, children);
    if (hydrate) { root = hydrateRoot(document.getElementById('root'), element, options); return; }
    root ??= createRoot(document.getElementById('root'), options);
    flushSync(() => root.render(element));
  };
`;

declare global {
  interface Window { __catalogue: any }
}

let browser: Browser;
let context: BrowserContext;
let page: Page;
let bundle: string;

beforeAll(async () => {
  const result = await build({
    absWorkingDir: project, stdin: { contents: entry, loader: 'tsx', resolveDir: project },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"development"' },
    plugins: [{ name: 'catalogue-test-boundaries', setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => {
        if (boundaries[args.path]) return { path: args.path, namespace: 'fixture' };
        if (/^(next\/|server-only|@supabase\/|@opennextjs\/)/.test(args.path)) throw new Error(`Unmocked framework boundary: ${args.path}`);
      });
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: boundaries[args.path]!, loader: 'tsx', resolveDir: project }));
    } }],
  });
  bundle = result.outputFiles[0]!.text;
  browser = await chromium.launch({ headless: true });
}, 30_000);

beforeEach(async () => {
  context = await browser.newContext({ viewport: { width: 1280, height: 720 }, reducedMotion: 'no-preference', serviceWorkers: 'block' });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === 'https://catalogue-ui.invalid' && url.pathname === '/') {
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="en"><body><div id="root"></div><button id="outside">Outside</button></body></html>' });
    }
    if (url.origin === 'https://catalogue-ui.invalid' && url.pathname === '/broken-trailer.mp4') {
      return route.fulfill({ contentType: 'video/mp4', body: 'Synthetic undecodable media' });
    }
    return route.abort();
  });
  page = await context.newPage();
  page.setDefaultTimeout(2000);
  await page.goto('https://catalogue-ui.invalid/');
  await page.clock.install();
  await page.addScriptTag({ content: bundle });
});
afterEach(async () => { await context?.close(); });
afterAll(async () => { await browser?.close(); });

async function render(name: string, props: Record<string, unknown> = {}) {
  await page.evaluate(({ name, props }) => window.__catalogue.render(name, props), { name, props });
}
async function settleSearch(query: string, titles: Title[] = [], rejectKind?: string) {
  await page.evaluate(({ query, titles, rejectKind }) => {
    for (const request of window.__catalogue.requests.filter((item: any) => item.query === query && !item.done)) {
      request.done = true;
      if (request.kind === rejectKind) request.reject(new Error('Synthetic search transport failure'));
      else request.resolve(request.kind === 'titles' ? titles : []);
    }
  }, { query, titles, rejectKind });
}
async function requested(query: string) {
  await expect.poll(() => page.evaluate(query => window.__catalogue.requests.filter((item: any) => item.query === query).length, query)).toBe(2);
}
const title: Title = { id: 'fixture', slug: 'fixture', name: 'Synthetic result', synopsis: '', type: 'movie', releaseYear: 2026, maturity: 'PG', genres: [] };
const seasons: Season[] = [1, 2, 3].map(number => ({ id: `season-${number}`, seasonNumber: number, name: `Season ${number}`, overview: '', airDate: null, episodeCount: 1,
  episodes: number === 2 ? [] : [{ id: `episode-${number}`, seasonNumber: number, episodeNumber: 1, name: `Opening ${number}`, overview: '', airDate: '2026-01-01', runtimeMinutes: 40, stillUrl: null }] }));

describe('read-only public search actions and callers', () => {
  let actions: typeof import('@/app/search/actions');
  const person: PersonSearchResult = { id: 'tmdb:123', name: 'Synthetic person', knownFor: 'Acting', profileUrl: null };
  const network = vi.fn<typeof fetch>();

  beforeEach(async () => {
    vi.clearAllMocks();
    publicSearch.titles.mockResolvedValue([]);
    publicSearch.people.mockResolvedValue([person]);
    publicSearch.autoImport.mockResolvedValue([]);
    publicSearch.client.mockReturnValue({ from: publicSearch.mutation });
    network.mockImplementation(() => { throw new Error('Network is disabled in public search fixtures'); });
    vi.stubGlobal('fetch', network);
    // Execute the real server actions, not the browser's usual action stubs.
    actions = await vi.importActual<typeof import('@/app/search/actions')>('@/app/search/actions');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const spy of [publicSearch.syncImport, publicSearch.supabaseImport, publicSearch.autoImport,
      publicSearch.adminImport, publicSearch.adminSync, publicSearch.client, publicSearch.mutation, network]) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it.each(['', ' \t\n '])('rejects blank input without reading or importing (%j)', async query => {
    expect(await actions.searchTitlesAction(query)).toEqual([]);
    expect(await actions.searchPeopleAction(query)).toEqual([]);
    expect(publicSearch.titles).not.toHaveBeenCalled();
    expect(publicSearch.people).not.toHaveBeenCalled();
  });

  it('trims the query and returns public title DTOs unchanged from one bounded read', async () => {
    const found = [title];
    publicSearch.titles.mockResolvedValue(found);
    expect(await actions.searchTitlesAction('  Synthetic result  ')).toBe(found);
    expect(publicSearch.titles).toHaveBeenCalledExactlyOnceWith({ query: 'Synthetic result', sort: 'score', limit: 24 });
  });

  it('keeps an empty result empty even when Supabase is configured', async () => {
    expect(await actions.searchTitlesAction('missing')).toEqual([]);
    expect(publicSearch.titles).toHaveBeenCalledExactlyOnceWith({ query: 'missing', sort: 'score', limit: 24 });
  });

  it('propagates a read failure to the existing UI error path without importing', async () => {
    const failure = new Error('Synthetic public metadata failure');
    publicSearch.titles.mockRejectedValue(failure);
    await expect(actions.searchTitlesAction('missing')).rejects.toBe(failure);
    expect(publicSearch.titles).toHaveBeenCalledOnce();
  });

  it('preserves trimmed people search, the eight-result bound and person DTOs', async () => {
    const found = [person];
    publicSearch.people.mockResolvedValue(found);
    expect(await actions.searchPeopleAction('  Synthetic person  ')).toBe(found);
    expect(publicSearch.people).toHaveBeenCalledExactlyOnceWith('Synthetic person', 8);
    expect(publicSearch.titles).not.toHaveBeenCalled();
  });

  it.each(['empty', 'failure'])('typing and explicit public submit only read metadata after an %s result', async outcome => {
    if (outcome === 'failure') publicSearch.titles.mockRejectedValue(new Error('Synthetic public metadata failure'));
    await page.exposeFunction('__publicSearch', (kind: string, query: string) => kind === 'titles'
      ? actions.searchTitlesAction(query) : actions.searchPeopleAction(query));
    await page.evaluate(() => {
      window.__catalogue.request = (kind: string, query: string) => {
        window.__catalogue.requests.push({ kind, query });
        return (window as any).__publicSearch(kind, query);
      };
    });
    await render('search', { initialQuery: '' });
    const input = page.getByRole('searchbox');
    await input.fill('discarded partial');
    await page.clock.runFor(249);
    await input.fill('  typed query  ');
    await page.clock.runFor(249);
    expect(publicSearch.titles).not.toHaveBeenCalled();
    expect(publicSearch.people).not.toHaveBeenCalled();
    await page.clock.runFor(1);
    await expect.poll(() => publicSearch.titles.mock.calls.length).toBe(1);
    await expect.poll(() => publicSearch.people.mock.calls.length).toBe(1);
    expect(publicSearch.titles).toHaveBeenLastCalledWith({ query: 'typed query', sort: 'score', limit: 24 });
    expect(publicSearch.people).toHaveBeenLastCalledWith('typed query', 8);
    await expect.poll(() => outcome === 'failure' ? page.getByRole('alert').count() : page.getByText(/No results for/).count()).toBe(1);

    await input.fill('  submitted query  ');
    await input.press('Enter');
    await expect.poll(() => publicSearch.titles.mock.calls.length).toBe(2);
    await expect.poll(() => publicSearch.people.mock.calls.length).toBe(2);
    await page.clock.runFor(300);
    expect(publicSearch.titles).toHaveBeenCalledTimes(2);
    expect(publicSearch.people).toHaveBeenCalledTimes(2);
    expect(publicSearch.titles).toHaveBeenLastCalledWith({ query: 'submitted query', sort: 'score', limit: 24 });
    expect(publicSearch.people).toHaveBeenLastCalledWith('submitted query', 8);
    expect(await page.evaluate(() => window.__catalogue.navigation.at(-1))).toEqual({ href: '/search?q=submitted+query', options: { scroll: false } });
    if (outcome === 'empty') {
      await expect.poll(() => page.getByRole('link', { name: 'Request this title' }).count()).toBe(1);
      expect(await page.getByRole('link', { name: 'Request this title' }).getAttribute('href')).toBe('/request');
      expect(await page.getByRole('link', { name: /Synthetic person/ }).getAttribute('href')).toBe('/person/tmdb:123');
    } else {
      await expect.poll(() => page.getByRole('alert').count()).toBe(1);
      expect(await input.inputValue()).toBe('  submitted query  ');
      expect(await page.getByText(/No results for/).count()).toBe(0);
    }
    expect(await page.evaluate(() => window.__catalogue.errors)).toEqual([]);
  });
});

describe('catalogue query interactions', () => {
  it('follows later query props from same-route navigation and retires old results', async () => {
    await render('search', { initialQuery: 'first' }); await requested('first');
    await render('search', { initialQuery: 'second' }); await requested('second');
    await settleSearch('second', [title]); await settleSearch('first');
    expect(await page.getByRole('searchbox').inputValue()).toBe('second');
    await expect.poll(() => page.getByRole('link', { name: /Synthetic result/ }).count()).toBe(1);
    expect(await page.evaluate(() => window.__catalogue.errors)).toEqual([]);
  });

  it('shows the latest settled results even while a superseded search is still pending', async () => {
    await render('search', { initialQuery: 'slow' }); await requested('slow');
    await page.getByRole('searchbox').fill('latest'); await page.clock.runFor(260); await requested('latest');
    await settleSearch('latest', [title]);
    await expect.poll(() => page.getByRole('link', { name: /Synthetic result/ }).count()).toBe(1);
    // The router acknowledges our own URL update without repeating a server-action pair.
    await render('search', { initialQuery: 'latest' });
    expect(await page.evaluate(() => window.__catalogue.requests.filter((item: any) => item.query === 'latest').length)).toBe(2);
  });

  it('keeps failure distinct from no matches and retries without dropping the query', async () => {
    await render('search', { initialQuery: 'retry me' }); await requested('retry me');
    await settleSearch('retry me', [], 'people');
    await expect.poll(() => page.getByRole('alert').count()).toBe(1);
    expect(await page.getByRole('searchbox').inputValue()).toBe('retry me');
    expect(await page.getByText(/No results for/).count()).toBe(0);
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect.poll(() => page.evaluate(() => window.__catalogue.requests.length)).toBe(4);
    await settleSearch('retry me');
    await expect.poll(() => page.getByText(/No results for/).count()).toBe(1);
    expect(await page.getByRole('alert').count()).toBe(0);
    expect(await page.evaluate(() => window.__catalogue.errors)).toEqual([]);
  });

  it('returns focus to the input when clearing and ignores a late response', async () => {
    await render('search', { initialQuery: 'pending' }); await requested('pending');
    await page.getByRole('button', { name: 'Clear search' }).click();
    expect(await page.getByRole('searchbox').evaluate(node => node === document.activeElement)).toBe(true);
    await settleSearch('pending', [title]);
    expect(await page.getByRole('searchbox').inputValue()).toBe('');
    expect(await page.getByRole('link', { name: /Synthetic result/ }).count()).toBe(0);
    expect(await page.evaluate(() => window.__catalogue.navigation.at(-1))).toEqual({ href: '/search', options: { scroll: false } });
  });

  it('preserves browse dimensions, resets pagination and retains the locked route', async () => {
    await page.evaluate(() => { window.__catalogue.pathname = '/movies'; window.__catalogue.query = 'genre=Drama&originalLanguage=hi&country=IN&page=4'; });
    await render('filters', { genres: ['Drama', 'Comedy'], lockType: 'movie' });
    expect(await page.getByLabel('Type', { exact: true }).count()).toBe(0);
    await page.getByRole('combobox', { name: /^Sort\b/ }).selectOption('score');
    const navigation = await page.evaluate(() => window.__catalogue.navigation.at(-1));
    const target = new URL(navigation.href, 'https://catalogue-ui.invalid');
    expect(target.pathname).toBe('/movies');
    expect(Object.fromEntries(target.searchParams)).toEqual({ genre: 'Drama', originalLanguage: 'hi', country: 'IN', sort: 'score' });
    await page.getByRole('button', { name: 'Reset all' }).click();
    expect(await page.evaluate(() => window.__catalogue.navigation.at(-1).href)).toBe('/movies');
  });

  it('keeps discovery-language changes scoped to the current query and sort', async () => {
    await page.evaluate(() => { window.__catalogue.pathname = '/browse'; window.__catalogue.query = 'q=story&country=IN&sort=score&page=2'; });
    await render('discovery');
    await page.getByRole('combobox', { name: /^Original language\b/ }).selectOption('ta|te|ml|kn');
    const href = await page.evaluate(() => window.__catalogue.navigation.at(-1).href);
    expect(Object.fromEntries(new URL(href, 'https://catalogue-ui.invalid').searchParams)).toEqual({ q: 'story', country: 'IN', sort: 'score', originalLanguage: 'ta|te|ml|kn' });
  });

  it.each(['validation error', 'transport rejection'])('retains request-form values and focuses feedback after a %s', async failure => {
    await render('request');
    await page.getByLabel('Title', { exact: true }).fill('Synthetic request');
    await page.getByLabel('Type', { exact: true }).selectOption('tv');
    await page.getByLabel('Year', { exact: false }).fill('2101');
    await page.getByLabel('Note', { exact: false }).fill('Synthetic note');
    await page.getByRole('button', { name: 'Request title', exact: true }).click();
    expect(await page.getByRole('button', { name: /Submitting/ }).isDisabled()).toBe(true);
    expect(await page.evaluate(() => window.__catalogue.requests[0].query)).toEqual({ title_name: 'Synthetic request', media_type: 'tv', year: '2101', note: 'Synthetic note' });
    await page.evaluate(failure => {
      const request = window.__catalogue.requests[0];
      if (failure === 'validation error') request.resolve({ status: 'error', message: 'Year must be between 1878 and 2100.' });
      else request.reject(new Error('Synthetic transport rejection'));
    }, failure);
    await expect.poll(() => page.getByRole('alert').count()).toBe(1);
    expect(await page.getByLabel('Title', { exact: true }).inputValue()).toBe('Synthetic request');
    expect(await page.getByLabel('Type', { exact: true }).inputValue()).toBe('tv');
    expect(await page.getByLabel('Year', { exact: false }).inputValue()).toBe('2101');
    expect(await page.getByLabel('Note', { exact: false }).inputValue()).toBe('Synthetic note');
    expect(await page.getByRole('alert').evaluate(node => node === document.activeElement)).toBe(true);
    expect(await page.getByRole('status').count()).toBe(0);
    expect(await page.evaluate(() => window.__catalogue.errors)).toEqual([]);
    await page.getByLabel('Year', { exact: false }).fill('2026');
    await page.getByRole('button', { name: 'Request title', exact: true }).click();
    expect(await page.evaluate(() => window.__catalogue.requests.at(-1).query)).toEqual({ title_name: 'Synthetic request', media_type: 'tv', year: '2026', note: 'Synthetic note' });
    await page.evaluate(() => window.__catalogue.requests.at(-1).resolve({ status: 'ok', message: 'Synthetic retry acknowledged.' }));
    await expect.poll(() => page.getByRole('status').textContent()).toBe('Synthetic retry acknowledged.');
    expect(await page.getByLabel('Title', { exact: true }).inputValue()).toBe('');
    expect(await page.getByRole('alert').count()).toBe(0);
  });

  it('clears request fields only after the action acknowledges success', async () => {
    await render('request');
    await page.getByLabel('Title', { exact: true }).fill('Synthetic request');
    await page.getByLabel('Type', { exact: true }).selectOption('tv');
    await page.getByRole('button', { name: 'Request title', exact: true }).click();
    expect(await page.getByLabel('Title', { exact: true }).inputValue()).toBe('Synthetic request');
    expect(await page.getByLabel('Title', { exact: true }).isDisabled()).toBe(true);
    expect(await page.getByRole('status').count()).toBe(0);
    await page.evaluate(() => window.__catalogue.requests[0].resolve({ status: 'ok', message: 'Synthetic request acknowledged.' }));
    await expect.poll(() => page.getByRole('status').textContent()).toBe('Synthetic request acknowledged.');
    expect(await page.getByLabel('Title', { exact: true }).inputValue()).toBe('');
    expect(await page.getByLabel('Type', { exact: true }).inputValue()).toBe('movie');
    expect(await page.getByRole('button', { name: 'Request title', exact: true }).isEnabled()).toBe(true);
  });
});

describe('title and spotlight controls', () => {
  it('moves tab focus with arrows/Home/End and keeps an empty season reachable', async () => {
    await render('seasons', { seasons, titleSlug: 'synthetic-tv', titleName: 'Synthetic TV' });
    await page.getByRole('tab', { name: 'Season 1', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => page.getByRole('tab', { name: 'Season 2', exact: true }).getAttribute('aria-selected')).toBe('true');
    expect(await page.getByRole('tab', { name: 'Season 2', exact: true }).evaluate(node => node === document.activeElement)).toBe(true);
    await page.keyboard.press('Tab');
    expect(await page.getByRole('tabpanel').evaluate(node => node === document.activeElement)).toBe(true);
    expect(await page.getByRole('tabpanel').textContent()).toContain('details haven');
    await page.getByRole('tab', { name: 'Season 2', exact: true }).focus();
    await page.keyboard.press('End');
    expect(await page.getByRole('tab', { name: 'Season 3', exact: true }).evaluate(node => node === document.activeElement)).toBe(true);
    expect(await page.getByRole('link', { name: 'Play episode 1, Opening 3' }).getAttribute('href')).toBe('/watch/tv/synthetic-tv?season=3&episode=1');
    await page.keyboard.press('ArrowRight');
    expect(await page.getByRole('tab', { name: 'Season 1', exact: true }).evaluate(node => node === document.activeElement)).toBe(true);
    await page.keyboard.press('End'); await page.keyboard.press('Home');
    expect(await page.getByRole('tab', { name: 'Season 1', exact: true }).getAttribute('tabindex')).toBe('0');
  });

  it('does not lose the entire episode section if refreshed seasons remove the selected index', async () => {
    await render('seasons', { seasons, titleSlug: 'synthetic-tv', titleName: 'Synthetic TV' });
    await page.getByRole('tab', { name: 'Season 3', exact: true }).click();
    await render('seasons', { seasons: [seasons[0]], titleSlug: 'synthetic-tv', titleName: 'Synthetic TV' });
    expect(await page.getByRole('tab', { name: 'Season 1', exact: true }).count()).toBe(1);
    expect(await page.getByRole('link', { name: 'Play episode 1, Opening 1' }).getAttribute('href')).toBe('/watch/tv/synthetic-tv?season=1&episode=1');
  });

  it('closes a pending trailer with Escape, aborts the lookup and restores trigger focus', async () => {
    await render('trailer', { titleName: 'Synthetic trailer', imdbId: 'tt9000001' });
    expect(await page.evaluate(() => window.__catalogue.requests.length)).toBe(0);
    await page.getByRole('button', { name: 'Trailer', exact: true }).click();
    expect(await page.getByRole('dialog').count()).toBe(1);
    expect(await page.getByRole('status').textContent()).toContain('Finding trailer');
    await page.keyboard.press('Escape');
    await expect.poll(() => page.getByRole('dialog').count()).toBe(0);
    expect(await page.getByRole('button', { name: 'Trailer', exact: true }).evaluate(node => node === document.activeElement)).toBe(true);
    expect(await page.evaluate(() => window.__catalogue.requests[0].signal.aborted)).toBe(true);
    await page.evaluate(() => window.__catalogue.requests[0].resolve({ url: '/broken-trailer.mp4' }));
    expect(await page.locator('video').count()).toBe(0);
  });

  it.each([false, true])('replaces failed native trailer media with an honest fallback (YouTube=%s)', async youtube => {
    await render('trailer', { titleName: 'Synthetic trailer', imdbId: 'tt9000001', ...(youtube ? { trailerUrl: 'https://www.youtube.com/watch?v=qaFixture01' } : {}) });
    await page.getByRole('button', { name: 'Trailer', exact: true }).click();
    await page.evaluate(() => window.__catalogue.requests[0].resolve({ url: 'https://catalogue-ui.invalid/broken-trailer.mp4' }));
    if (youtube) await expect.poll(() => page.locator('iframe').getAttribute('src')).toBe('https://www.youtube-nocookie.com/embed/qaFixture01?autoplay=1&rel=0');
    else await expect.poll(() => page.getByRole('status').textContent()).toContain('Trailer unavailable');
    expect(await page.locator('video').count()).toBe(0);
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    expect(await page.getByRole('dialog').count()).toBe(0);
  });

  it('never restarts autoplay on pointer exit while keyboard focus is inside the carousel', async () => {
    await render('carousel');
    await page.getByRole('button', { name: 'Start slideshow' }).click();
    await page.locator('#outside').focus(); await page.mouse.move(1200, 700);
    await page.clock.runFor(6100);
    await expect.poll(() => page.getByRole('group', { name: '2 of 2', exact: true }).count()).toBe(1);
    await page.getByRole('link', { name: 'Title 2', exact: true }).focus();
    await page.getByRole('region', { name: 'Trending titles' }).hover(); await page.mouse.move(1200, 700);
    await page.clock.runFor(6100);
    expect(await page.getByRole('group', { name: '2 of 2', exact: true }).count()).toBe(1);
    expect(await page.getByRole('link', { name: 'Title 2', exact: true }).evaluate(node => node === document.activeElement)).toBe(true);
  });

  it.each(['throws', 'returns false', 'returns true'])('cleans up clipboard fallback and reports its real outcome when it %s', async outcome => {
    await page.evaluate(outcome => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
      document.execCommand = () => {
        if (outcome === 'throws') throw new Error('Synthetic clipboard denial');
        return outcome === 'returns true';
      };
    }, outcome);
    await render('share', { titleName: 'Synthetic title', url: 'https://catalogue-ui.invalid/title/movie/fixture' });
    const button = page.getByRole('button', { name: 'Copy share link for Synthetic title' });
    await button.click();
    expect(await page.getByRole('status').textContent()).toContain(outcome === 'returns true' ? 'Link copied to clipboard' : 'copy automatically');
    expect(await page.locator('textarea').count()).toBe(0);
    expect(await button.evaluate(node => node === document.activeElement)).toBe(true);
  });

  it('does not resume a different media type with the same slug', async () => {
    await page.evaluate(() => { window.__catalogue.guestEntries = [{ type: 'tv', slug: 'shared-slug', seasonNumber: 2, episodeNumber: 4, progress: 0.3 }]; });
    await render('resume', { baseHref: '/watch/movie/shared-slug', playable: true, signedIn: false });
    expect(await page.getByRole('link').getAttribute('href')).toBe('/watch/movie/shared-slug');
    expect(await page.getByRole('link').textContent()).toContain('Play');
  });

  it('keeps exact guest episode resume, signed-in precedence and unavailable Play semantics', async () => {
    await page.evaluate(() => { window.__catalogue.guestEntries = [{ type: 'tv', slug: 'fixture', seasonNumber: 2, episodeNumber: 4, progress: 0.3 }]; });
    await render('resume', { baseHref: '/watch/tv/fixture', playable: true, signedIn: false });
    expect(await page.getByRole('link', { name: 'Resume S2 E4', exact: true }).getAttribute('href')).toBe('/watch/tv/fixture?season=2&episode=4');
    await render('resume', { baseHref: '/watch/tv/fixture', playable: true, signedIn: true, serverResume: { href: '/watch/tv/fixture?season=1&episode=3', label: 'Resume S1 E3' } });
    expect(await page.getByRole('link', { name: 'Resume S1 E3', exact: true }).getAttribute('href')).toBe('/watch/tv/fixture?season=1&episode=3');
    await render('resume', { baseHref: '/watch/tv/fixture', playable: false, signedIn: false });
    expect(await page.getByRole('button', { name: 'Play (unavailable)', exact: true }).isDisabled()).toBe(true);
    expect(await page.getByRole('link').count()).toBe(0);
  });
});

describe('changed-component first render', () => {
  it('keeps query loading, closed trailers and guest Play deterministic during SSR and hydration', async () => {
    expect(typeof window).toBe('undefined');
    const cases = [
      { name: 'search', props: { initialQuery: 'synthetic query' }, element: createElement(SearchClient, { initialQuery: 'synthetic query' }) },
      { name: 'trailer', props: { titleName: 'Synthetic trailer', imdbId: 'tt9000001' }, element: createElement(TrailerButton, { titleName: 'Synthetic trailer', imdbId: 'tt9000001' }) },
      { name: 'resume', props: { baseHref: '/watch/movie/fixture', playable: true, signedIn: false }, element: createElement(ResumePlayButton, { baseHref: '/watch/movie/fixture', playable: true, signedIn: false }) },
      { name: 'request', props: {}, element: createElement(RequestForm) },
    ];
    for (const fixture of cases) {
      const markup = renderToString(fixture.element);
      expect(markup).not.toMatch(/<video|<iframe|<dialog/);
      const tab = await context.newPage();
      await tab.goto('https://catalogue-ui.invalid/');
      await tab.locator('#root').evaluate((node, markup) => { node.innerHTML = markup; }, markup);
      await tab.addScriptTag({ content: bundle });
      await tab.evaluate(({ name, props }) => window.__catalogue.render(name, props, true), { name: fixture.name, props: fixture.props });
      await tab.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      expect(await tab.evaluate(() => window.__catalogue.errors)).toEqual([]);
      await tab.close();
    }
  });
});
