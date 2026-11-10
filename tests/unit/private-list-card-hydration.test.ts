import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthSessionMissingError, createClient, type User } from '@supabase/supabase-js';
import type { Database } from '@/lib/supabase/types';
import type { Title } from '@/features/catalog/types';

const mocks = vi.hoisted(() => ({
  features: { supabaseConfigured: true, tmdbConfigured: false },
  server: vi.fn(), publicClient: vi.fn(), profile: vi.fn(), activeProfile: vi.fn(), tmdb: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/env', () => ({ features: mocks.features }));
vi.mock('@/lib/supabase/server', () => ({ getSupabaseServerClient: mocks.server }));
vi.mock('@/lib/supabase/public', () => ({ getSupabasePublicClient: mocks.publicClient }));
vi.mock('@/features/account/active-profile', () => ({ resolveActiveProfileId: mocks.profile, getActiveProfileId: mocks.activeProfile }));
vi.mock('@/features/catalog/tmdb-catalog', () => ({ getTmdbTitle: mocks.tmdb }));

import { getTitleCardsByIds, MAX_TITLE_CARD_IDS, TITLE_CARD_SELECT, toTitleCard, type TitleCardRow } from '@/features/catalog/card-queries';
import { listWatchlistTitles } from '@/features/watchlist/queries';
import { listWatchHistory, listWatchHistoryWithTitles } from '@/features/playback/history-queries';
import { getContinueWatching } from '@/features/playback/progress-queries';

const uuid = (n: number) => `00000000-0000-0000-0000-${n.toString(16).padStart(12, '0')}`;
const A = uuid(1), B = uuid(2), DRAFT = uuid(3), PRIVATE = uuid(4), FUTURE = uuid(5), ARCHIVED = uuid(6), MISSING = uuid(7), C = uuid(8);
const OWNER = uuid(1001), OTHER = uuid(1002), PROFILE = uuid(2001), SECOND = uuid(2002), OTHER_PROFILE = uuid(2003);
const LIST = uuid(3001), SECOND_LIST = uuid(3002), OTHER_LIST = uuid(3003), EPISODE = uuid(4001);
const NOW = Date.parse('2026-11-10T06:00:00.000Z');
type Row = Record<string, unknown>;
type Lane = 'public' | 'private';
type Request = { lane: Lane; table: string; method: string; query: URLSearchParams; authorization: string | null; bytes: number };
let rows: Record<string, Row[]>;
let requests: Request[];
let failures: Set<string>;
let activeAccount: string;
let selectedProfiles: Map<string, string>;

function titleRow(id: string, extra: Row = {}): TitleCardRow & Row {
  return {
    id, type: 'movie', slug: `title-${id}`, name: `Title ${id}`, release_year: 2026,
    runtime_minutes: 123, maturity: 'PG', poster_url: 'https://art.example/poster.jpg',
    backdrop_url: 'https://art.example/backdrop.jpg', editorial_score: 81, tmdb_id: 1234, imdb_id: 'tt1234',
    status: 'published', visibility: 'public', published_at: null,
    synopsis: 'DETAIL_TEXT_NOT_FOR_CARDS '.repeat(4096), original_name: 'Detail original name',
    original_language: 'en', featured: true, trailer_url: 'https://trailer.example/full-detail',
    title_genres: [{ genres: { name: 'Detail genre' } }], private_notes: 'UNPROJECTED_ADMIN_FIELD', ...extra,
  };
}

function session(index: number, titleId = A, extra: Row = {}): Row {
  return {
    id: `session-${index}`, account_id: OWNER, profile_id: PROFILE, title_id: titleId,
    episode_id: null, state: 'ended', started_at: new Date(NOW - index * 1000).toISOString(),
    device: 'not-needed-for-history', provider_id: 'not-needed-for-history', ...extra,
  };
}

function progress(index: number, titleId = A, extra: Row = {}): Row {
  return {
    id: `progress-${index}`, account_id: OWNER, profile_id: PROFILE, title_id: titleId,
    episode_id: null, progress: 0.5, position_seconds: 50, completed: false,
    updated_at: new Date(NOW - index * 1000).toISOString(), duration_seconds: 100, ...extra,
  };
}

// Real PostgREST serialization with an offline boundary that applies both RLS
// and SELECT projection before measuring response bytes. Editor rows are wider.
function client(lane: Lane, account: string | null = OWNER) {
  const fetchFixture: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== 'https://card-fixture.example') throw new Error('Unexpected fixture destination');
    const table = url.pathname.split('/').at(-1)!;
    const request: Request = {
      lane, table, method: init?.method ?? 'GET', query: url.searchParams,
      authorization: new Headers(init?.headers).get('authorization'), bytes: 0,
    };
    requests.push(request);
    if (failures.has(`${lane}:${table}`)) return new Response(JSON.stringify({ message: 'fixture unavailable', code: 'fixture-error' }), { status: 400 });
    let matched = rows[table] ?? [];
    const isPublic = (row: Row) => row.status === 'published' && row.visibility === 'public'
      && (row.published_at == null || Date.parse(String(row.published_at)) <= NOW);
    if (lane === 'public' && table === 'titles') matched = matched.filter(isPublic);
    matched = matched.filter((row) => [...url.searchParams].every(([key, value]) => {
      if (['select', 'order', 'limit'].includes(key)) return true;
      if (key === 'or') return row.published_at == null || Date.parse(String(row.published_at)) <= NOW;
      if (value.startsWith('eq.')) return String(row[key]) === value.slice(3);
      if (value === 'is.null') return row[key] == null;
      if (value.startsWith('in.(')) return value.slice(4, -1).split(',').map((id) => id.replace(/^"|"$/g, '')).includes(String(row[key]));
      if (value.startsWith('gte.')) return typeof row[key] === 'number' ? row[key] >= Number(value.slice(4)) : String(row[key]) >= value.slice(4);
      throw new Error(`Unsupported fixture predicate ${key}`);
    }));
    const [order, direction] = (url.searchParams.get('order') ?? '').split('.');
    if (order) matched = [...matched].sort((a, b) => String(a[order]).localeCompare(String(b[order])) * (direction === 'desc' ? -1 : 1));
    const limit = url.searchParams.get('limit');
    if (limit) matched = matched.slice(0, Number(limit));
    const fields = (url.searchParams.get('select') ?? '*').split(',').map((field) => field.trim());
    const projected = fields.includes('*') ? matched : matched.map((row) => Object.fromEntries(fields.map((field) => [field, row[field]])));
    const object = new Headers(init?.headers).get('accept')?.includes('vnd.pgrst.object');
    const body = JSON.stringify(object ? projected[0] ?? null : projected);
    request.bytes = Buffer.byteLength(body);
    return new Response(body, { headers: { 'content-type': 'application/json' } });
  };
  const db = createClient<Database>('https://card-fixture.example', 'synthetic-anon-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: fetchFixture, ...(lane === 'private' ? { headers: { Authorization: 'Bearer synthetic-editor-token' } } : {}) },
  });
  const user: User | null = account ? { id: account, aud: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: new Date(NOW).toISOString() } : null;
  vi.spyOn(db.auth, 'getUser').mockResolvedValue(user
    ? { data: { user }, error: null }
    : { data: { user: null }, error: new AuthSessionMissingError() });
  return db;
}

const reads = (table: string, lane?: Lane) => requests.filter((request) => request.table === table && (!lane || request.lane === lane));
const queriedIds = (request: Request) => (request.query.get('id') ?? '').slice(4, -1).split(',').map((id) => id.replace(/^"|"$/g, ''));

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network is disabled in this suite'); }));
  mocks.features.supabaseConfigured = true;
  mocks.features.tmdbConfigured = false;
  requests = [];
  failures = new Set();
  activeAccount = OWNER;
  selectedProfiles = new Map([[OWNER, PROFILE], [OTHER, OTHER_PROFILE]]);
  rows = {
    titles: [titleRow(A), titleRow(B, { type: 'tv' }), titleRow(C), titleRow(DRAFT, { status: 'draft' }),
      titleRow(PRIVATE, { visibility: 'private' }), titleRow(FUTURE, { published_at: '2099-01-01T00:00:00Z' }), titleRow(ARCHIVED, { status: 'archived' })],
    watchlists: [
      { id: LIST, account_id: OWNER, profile_id: PROFILE, name: 'My list' },
      { id: SECOND_LIST, account_id: OWNER, profile_id: SECOND, name: 'My list' },
      { id: OTHER_LIST, account_id: OTHER, profile_id: OTHER_PROFILE, name: 'My list' },
    ],
    watchlist_items: [], playback_sessions: [], watch_progress: [],
    episodes: [{ id: EPISODE, season_number: 2, episode_number: 5, name: 'Exact episode', overview: 'UNPROJECTED_EPISODE_TEXT' }],
  };
  mocks.server.mockResolvedValue(client('private'));
  mocks.publicClient.mockImplementation(() => client('public'));
  mocks.profile.mockImplementation(async (_db, accountId: string) => selectedProfiles.get(accountId) ?? null);
  mocks.activeProfile.mockImplementation(async () => selectedProfiles.get(activeAccount) ?? null);
  mocks.tmdb.mockImplementation(async (type: 'movie' | 'tv', slug: string): Promise<Title> => ({
    id: `tmdb:${type}:${slug.split('-').at(-1)}`, type, slug, name: 'TMDB public title',
    synopsis: 'TMDB_DETAIL_TEXT', genres: ['Drama'], releaseYear: 2025, runtimeMinutes: 104,
    maturity: 'PG', posterUrl: 'https://art.example/tmdb-poster.jpg', backdropUrl: 'https://art.example/tmdb-backdrop.jpg',
    score: 90, tmdbId: slug.split('-').at(-1), imdbId: 'tt4321', originalName: 'Unneeded original name',
  }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('compact published title-card contract', () => {
  it('retains every actual card field without copying detail/admin fields', () => {
    expect(toTitleCard(titleRow(A))).toEqual({
      id: A, type: 'movie', slug: `title-${A}`, name: `Title ${A}`, releaseYear: 2026,
      runtimeMinutes: 123, maturity: 'PG', posterUrl: 'https://art.example/poster.jpg',
      backdropUrl: 'https://art.example/backdrop.jpg', score: 81, tmdbId: '1234', imdbId: 'tt1234', synopsis: '', genres: [],
    });
    expect(toTitleCard(titleRow(A, { release_year: null, runtime_minutes: null, maturity: 'NR', poster_url: null,
      backdrop_url: null, editorial_score: 0, tmdb_id: null, imdb_id: null }))).toEqual({
      id: A, type: 'movie', slug: `title-${A}`, name: `Title ${A}`, releaseYear: 0, maturity: 'PG-13', score: 0, synopsis: '', genres: [],
    });
  });

  it('deduplicates UUIDs into one exact-count anonymous query with a 12-column byte projection', async () => {
    const ids = [B, A, B, A] as const;
    const cards = await getTitleCardsByIds(ids);
    expect([...cards.keys()]).toEqual([B, A]);
    expect(ids).toEqual([B, A, B, A]);
    expect(reads('titles')).toHaveLength(1);
    const request = reads('titles')[0]!;
    expect(request.lane).toBe('public');
    expect(request.authorization).toBe('Bearer synthetic-anon-key');
    expect(queriedIds(request)).toEqual([B, A]);
    expect(request.query.get('limit')).toBe('2');
    expect(request.query.get('select')).toBe(TITLE_CARD_SELECT.replace(/ /g, ''));
    expect(request.query.get('select')?.split(',')).toEqual([
      'id', 'type', 'slug', 'name', 'release_year', 'runtime_minutes', 'maturity',
      'poster_url', 'backdrop_url', 'editorial_score', 'tmdb_id', 'imdb_id',
    ]);
    expect(request.bytes).toBeLessThan(1200);
    expect(request.bytes).toBeLessThan(Buffer.byteLength(JSON.stringify(rows.titles)) / 100);
    expect(JSON.stringify([...cards.values()])).not.toMatch(/DETAIL_TEXT|UNPROJECTED|title_genres|originalName|trailerUrl|featured/);
    expect(mocks.server).not.toHaveBeenCalled();
    expect(requests.every((request) => request.method === 'GET')).toBe(true);
  });

  it('normalizes UUID case and bounds the number of distinct identities', async () => {
    const id = uuid(0xabcd);
    rows.titles = [titleRow(id)];
    const cards = await getTitleCardsByIds([id.toUpperCase(), id]);
    expect(cards.get(id.toUpperCase())?.id).toBe(id);
    expect(queriedIds(reads('titles')[0]!)).toEqual([id]);
    expect(reads('titles')[0]?.query.get('limit')).toBe('1');
    requests = [];
    const ids = Array.from({ length: MAX_TITLE_CARD_IDS + 2 }, (_, index) => uuid(index + 10));
    rows.titles = ids.map((id) => titleRow(id));
    expect((await getTitleCardsByIds(ids)).size).toBe(MAX_TITLE_CARD_IDS);
    expect(reads('titles')).toHaveLength(1);
    expect(queriedIds(reads('titles')[0]!)).toHaveLength(MAX_TITLE_CARD_IDS);
    expect(reads('titles')[0]?.query.get('limit')).toBe(String(MAX_TITLE_CARD_IDS));
  });

  it('never inherits editor draft/private/future/archived visibility', async () => {
    const cards = await getTitleCardsByIds([A, DRAFT, PRIVATE, FUTURE, ARCHIVED, MISSING]);
    expect([...cards.keys()]).toEqual([A]);
    const request = reads('titles')[0]!;
    expect(request.query.get('status')).toBe('eq.published');
    expect(request.query.get('visibility')).toBe('eq.public');
    expect(request.query.get('or')).toMatch(/^\(published_at\.is\.null,published_at\.lte\./);
    expect(request.query.get('limit')).toBe('6');
    expect(reads('titles', 'private')).toEqual([]);
  });

  it('routes virtual TMDB identities directly and never sends them to a UUID query', async () => {
    mocks.features.tmdbConfigured = true;
    const cards = await getTitleCardsByIds([A, 'tmdb:movie:42', 'tmdb:tv:84', 'tmdb:movie:42', 'tmdb:episode:9', 'tmdb:tv:bad', '42']);
    expect(vi.mocked(console.warn).mock.calls.filter(([message]) => String(message).includes('TMDB card read failed'))).toEqual([]);
    expect(mocks.tmdb.mock.calls).toEqual([['movie', 'movie-42'], ['tv', 'tv-84']]);
    expect([...cards.keys()]).toEqual([A, 'tmdb:movie:42', 'tmdb:tv:84']);
    expect(queriedIds(reads('titles')[0]!)).toEqual([A]);
    expect(cards.get('tmdb:movie:42')).toMatchObject({ name: 'TMDB public title', runtimeMinutes: 104, score: 90, imdbId: 'tt4321', synopsis: '', genres: [] });
    expect(JSON.stringify([...cards.values()])).not.toContain('TMDB_DETAIL_TEXT');
  });

  it('keeps direct TMDB cards available without Supabase and does not read for empty/invalid IDs', async () => {
    expect((await getTitleCardsByIds(['not-a-uuid', 'tmdb:movie:0'])).size).toBe(0);
    expect((await getTitleCardsByIds([])).size).toBe(0);
    expect(mocks.publicClient).not.toHaveBeenCalled();
    mocks.features.supabaseConfigured = false;
    mocks.features.tmdbConfigured = true;
    expect([...(await getTitleCardsByIds([A, 'tmdb:movie:42'])).keys()]).toEqual(['tmdb:movie:42']);
    expect(mocks.publicClient).not.toHaveBeenCalled();
  });

  it('does not cache private inputs or negative/public cards across calls', async () => {
    expect((await getTitleCardsByIds([A])).get(A)?.name).toBe(`Title ${A}`);
    rows.titles = [titleRow(A, { name: 'Changed public card' }), titleRow(MISSING)];
    expect((await getTitleCardsByIds([A, MISSING])).get(A)?.name).toBe('Changed public card');
    expect((await getTitleCardsByIds([MISSING])).has(MISSING)).toBe(true);
    expect(reads('titles')).toHaveLength(3);
  });

  it('fails closed without a full-title or authenticated-client retry', async () => {
    failures.add('public:titles');
    expect((await getTitleCardsByIds([A])).size).toBe(0);
    expect(reads('titles')).toHaveLength(1);
    expect(mocks.server).not.toHaveBeenCalled();
    mocks.features.tmdbConfigured = true;
    mocks.tmdb.mockRejectedValueOnce(new Error('fixture TMDB unavailable'));
    expect((await getTitleCardsByIds(['tmdb:tv:84'])).size).toBe(0);
    expect(reads('titles')).toHaveLength(1);
  });
});

describe('private list bounded hydration', () => {
  it('keeps watchlist order and skips hidden/deleted cards with one UUID lookup', async () => {
    rows.watchlist_items = [B, A, B, MISSING, DRAFT].map((id, index) => ({ watchlist_id: LIST, title_id: id, added_at: new Date(NOW - index * 1000).toISOString() }));
    expect((await listWatchlistTitles()).map((title) => title.id)).toEqual([B, A, B]);
    expect(reads('titles')).toHaveLength(1);
    expect(queriedIds(reads('titles')[0]!)).toEqual([B, A, MISSING, DRAFT]);
    const list = reads('watchlists')[0]!, items = reads('watchlist_items')[0]!;
    expect(list.query.get('account_id')).toBe(`eq.${OWNER}`);
    expect(list.query.get('profile_id')).toBe(`eq.${PROFILE}`);
    expect(items.query.get('watchlist_id')).toBe(`eq.${LIST}`);
    expect(items.query.get('select')).toBe('title_id');
    expect(items.query.get('order')).toBe('added_at.desc');
    expect(items.query.get('limit')).toBe('100');
  });

  it('hydrates 50 ordered repeated history plays only once per distinct title', async () => {
    rows.playback_sessions = Array.from({ length: 60 }, (_, index) => session(index, index % 2 === 0 ? B : A));
    const history = await listWatchHistoryWithTitles(1000);
    expect(history).toHaveLength(50);
    expect(history.map(({ entry }) => entry.sessionId)).toEqual(Array.from({ length: 50 }, (_, index) => `session-${index}`));
    expect(history[0]?.title).toBe(history[2]?.title);
    expect(reads('titles')).toHaveLength(1);
    expect(reads('titles')[0]?.query.get('limit')).toBe('2');
    expect(reads('titles')[0]!.bytes).toBeLessThan(1200);
    const request = reads('playback_sessions')[0]!;
    expect(request.query.get('select')).toBe('id,title_id,started_at,state,episode_id');
    expect(request.query.get('account_id')).toBe(`eq.${OWNER}`);
    expect(request.query.get('profile_id')).toBe(`eq.${PROFILE}`);
    expect(request.query.get('limit')).toBe('50');
    expect(request.query.get('order')).toBe('started_at.desc');
    expect(JSON.stringify(history)).not.toMatch(/DETAIL_TEXT|UNPROJECTED|synopsis":"[^"\s]/);
  });

  it.each([[Infinity, 50], [Number.NaN, 50], [-10, 1], [2.9, 2]])('clamps the latest history limit %s to %s', async (limit, expected) => {
    await listWatchHistory(limit);
    expect(reads('playback_sessions')[0]?.query.get('limit')).toBe(String(expected));
    expect(reads('titles')).toEqual([]);
  });

  it('batches exact repeated episodes while retaining title-only fallback and repeated plays', async () => {
    const unknownEpisode = uuid(4002), invalidEpisode = uuid(4003);
    rows.episodes!.push({ id: invalidEpisode, season_number: null, episode_number: 3, name: 'Incomplete episode' });
    rows.playback_sessions = [session(0, B, { episode_id: EPISODE }), session(1, B, { episode_id: EPISODE }),
      session(2, A, { episode_id: unknownEpisode }), session(3, B, { episode_id: invalidEpisode }), session(4, DRAFT), session(5, MISSING)];
    const history = await listWatchHistoryWithTitles();
    expect(history).toHaveLength(4);
    expect(history[0]?.entry.episode).toEqual({ episodeId: EPISODE, seasonNumber: 2, episodeNumber: 5, name: 'Exact episode' });
    expect(history[1]?.entry.episode).toEqual(history[0]?.entry.episode);
    expect(history[2]?.entry.episode).toBeUndefined();
    expect(history[3]?.entry.episode).toBeUndefined();
    expect(reads('episodes')).toHaveLength(1);
    expect(queriedIds(reads('episodes')[0]!)).toEqual([EPISODE, unknownEpisode, invalidEpisode]);
    expect(reads('episodes')[0]?.query.get('select')).toBe('id,season_number,episode_number,name');
    expect(reads('titles')).toHaveLength(1);
  });

  it('hydrates the continue-watching progress/fallback union once and preserves eligibility/episodes', async () => {
    rows.watch_progress = [progress(0, A), progress(1, B, { episode_id: EPISODE }), progress(2, B),
      progress(3, DRAFT), progress(4, C, { progress: 0.99 }),
      progress(5, PRIVATE, { account_id: OTHER }), progress(6, FUTURE, { profile_id: SECOND })];
    rows.playback_sessions = [session(0, B), session(1, DRAFT), session(2, MISSING), session(3, C), session(4, C),
      session(5, PRIVATE, { account_id: OTHER }), session(6, FUTURE, { profile_id: null }), session(7, ARCHIVED, { profile_id: SECOND })];
    const entries = await getContinueWatching(5);
    expect(entries.map((entry) => entry.title.id)).toEqual([A, B, C]);
    expect(entries[0]?.progress?.positionSeconds).toBe(50);
    expect(entries[1]?.episode).toEqual({ episodeId: EPISODE, seasonNumber: 2, episodeNumber: 5, name: 'Exact episode' });
    expect(entries[2]?.progress).toBeUndefined();
    expect(reads('titles')).toHaveLength(1);
    expect(queriedIds(reads('titles')[0]!)).toEqual([A, B, DRAFT, MISSING, C]);
    expect(reads('titles')[0]?.query.get('limit')).toBe('5');
    expect(reads('episodes')).toHaveLength(1);
    for (const table of ['watch_progress', 'playback_sessions']) {
      const request = reads(table)[0]!;
      expect(request.query.get('account_id')).toBe(`eq.${OWNER}`);
      expect(request.query.get('profile_id')).toBe(`eq.${PROFILE}`);
    }
    expect(reads('watch_progress')[0]?.query.get('select')).toBe('title_id,progress,position_seconds,updated_at,episode_id');
    expect(reads('playback_sessions')[0]?.query.get('select')).toBe('title_id');
    expect(reads('playback_sessions')[0]?.query.get('limit')).toBe('200');
  });

  it('fills from later public sessions after many null titles without a second hydration query', async () => {
    const ids = Array.from({ length: 40 }, (_, index) => uuid(index + 20));
    const last = ids.at(-1)!;
    rows.titles = [titleRow(last)];
    rows.playback_sessions = ids.map((id, index) => session(index, id));
    const entries = await getContinueWatching(1);
    expect(entries.map((entry) => entry.title.id)).toEqual([last]);
    expect(entries[0]?.progress).toBeUndefined();
    expect(reads('titles')).toHaveLength(1);
    expect(reads('titles')[0]?.query.get('limit')).toBe('40');
  });

  it('clamps continue-watching output/progress reads while keeping the 200-session bound', async () => {
    rows.playback_sessions = Array.from({ length: 210 }, (_, index) => session(index, A));
    expect(await getContinueWatching(1000)).toHaveLength(1);
    expect(reads('watch_progress')[0]?.query.get('limit')).toBe('50');
    expect(reads('playback_sessions')[0]?.query.get('limit')).toBe('200');
    expect(reads('titles')[0]?.query.get('limit')).toBe('1');
  });

  it('isolates successive accounts/profiles and excludes unattributed rows without a global cache', async () => {
    rows.playback_sessions = [session(0, A), session(1, B, { profile_id: SECOND }),
      session(2, C, { account_id: OTHER, profile_id: OTHER_PROFILE }), session(3, PRIVATE, { profile_id: null })];
    rows.watchlist_items = [
      { watchlist_id: LIST, title_id: A }, { watchlist_id: SECOND_LIST, title_id: B }, { watchlist_id: OTHER_LIST, title_id: C },
    ];
    for (const [account, profileId, expected] of [[OWNER, PROFILE, A], [OWNER, SECOND, B], [OTHER, OTHER_PROFILE, C]] as const) {
      activeAccount = account;
      selectedProfiles.set(account, profileId);
      mocks.server.mockResolvedValue(client('private', account));
      expect((await listWatchHistoryWithTitles()).map(({ title }) => title.id)).toEqual([expected]);
      expect((await listWatchlistTitles()).map((title) => title.id)).toEqual([expected]);
      expect((await getContinueWatching()).map(({ title }) => title.id)).toEqual([expected]);
    }
    expect(reads('titles')).toHaveLength(9);
    expect(reads('titles', 'private')).toEqual([]);
    expect(requests.every((request) => request.method === 'GET')).toBe(true);
  });

  it('keeps concurrent history account scopes separate', async () => {
    rows.playback_sessions = [session(0, A), session(1, C, { account_id: OTHER, profile_id: OTHER_PROFILE })];
    mocks.server.mockResolvedValueOnce(client('private', OWNER)).mockResolvedValueOnce(client('private', OTHER));
    const [first, second] = await Promise.all([listWatchHistoryWithTitles(), listWatchHistoryWithTitles()]);
    expect(first.map(({ title }) => title.id)).toEqual([A]);
    expect(second.map(({ title }) => title.id)).toEqual([C]);
    expect(reads('titles')).toHaveLength(2);
    expect(reads('playback_sessions').map((request) => request.query.get('account_id'))).toEqual([`eq.${OWNER}`, `eq.${OTHER}`]);
  });

  it('keeps honest empty/fallback results on list, progress, episode and catalog read failures', async () => {
    rows.playback_sessions = [session(0, B, { episode_id: EPISODE })];
    rows.watchlist_items = [{ watchlist_id: LIST, title_id: B }];
    failures.add('private:episodes');
    expect((await listWatchHistoryWithTitles())[0]?.entry.episode).toBeUndefined();
    failures.add('private:watch_progress');
    expect((await getContinueWatching())[0]?.title.id).toBe(B);
    failures.add('public:titles');
    expect(await listWatchlistTitles()).toEqual([]);
    expect(await listWatchHistoryWithTitles()).toEqual([]);
    failures.add('private:playback_sessions');
    expect(await listWatchHistoryWithTitles()).toEqual([]);
    expect(reads('titles', 'private')).toEqual([]);
  });

  it('does not hydrate or read private rows for anonymous viewers or absent owned profiles', async () => {
    mocks.server.mockResolvedValue(client('private', null));
    expect(await listWatchHistoryWithTitles()).toEqual([]);
    expect(await listWatchlistTitles()).toEqual([]);
    expect(await getContinueWatching()).toEqual([]);
    expect(requests).toEqual([]);
    mocks.server.mockResolvedValue(client('private'));
    selectedProfiles.delete(OWNER);
    expect(await listWatchHistoryWithTitles()).toEqual([]);
    expect(await listWatchlistTitles()).toEqual([]);
    expect(await getContinueWatching()).toEqual([]);
    expect(requests).toEqual([]);
    expect(mocks.publicClient).not.toHaveBeenCalled();
  });
});
