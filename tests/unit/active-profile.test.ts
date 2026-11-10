import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js';
import type { Database } from '@/lib/supabase/types';

const mocks = vi.hoisted(() => ({ account: vi.fn(), server: vi.fn(), get: vi.fn(), set: vi.fn(), remove: vi.fn(), revalidate: vi.fn(), title: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: mocks.get, set: mocks.set, delete: mocks.remove }) }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }));
vi.mock('@/lib/env', () => ({ features: { supabaseConfigured: true } }));
vi.mock('@/features/auth/verified-account', () => ({ getVerifiedAccount: mocks.account }));
vi.mock('@/lib/supabase/server', () => ({ getSupabaseServerClient: mocks.server }));
vi.mock('@/features/catalog/card-queries', () => ({
  getTitleCardsByIds: async (ids: readonly string[]) => new Map(await Promise.all(ids.map(async (id) => [id, await mocks.title(id)] as const))),
}));

import { ACTIVE_PROFILE_COOKIE, getActiveProfileId, resolveActiveProfileId } from '@/features/account/active-profile';
import { deleteProfileAction, renameProfileAction, selectProfileAction } from '@/features/account/profile-actions';
import { getDefaultProfileId, isInWatchlist, listWatchlistTitles } from '@/features/watchlist/queries';
import { getContinueWatching, getPlaybackContext } from '@/features/playback/progress-queries';
import { reportProgressAction } from '@/features/playback/progress-actions';
import { listWatchHistory } from '@/features/playback/history-queries';

const OWNER = '10000000-0000-4000-8000-000000000001';
const FIRST = '20000000-0000-4000-8000-000000000001';
const SECOND = '20000000-0000-4000-8000-000000000002';
const FOREIGN = '20000000-0000-4000-8000-000000000003';
type Row = Record<string, unknown>;
let rows: Record<string, Row[]>;
let selected: string | undefined;
let failure: string | undefined;
let client: SupabaseClient<Database>;
let requests: Array<{ table: string; method: string; query: URLSearchParams; body: Row | undefined }>;

beforeEach(() => {
  vi.clearAllMocks();
  selected = SECOND;
  failure = undefined;
  requests = [];
  const now = new Date().toISOString();
  rows = {
    profiles: [
      { id: FIRST, account_id: OWNER, name: 'First', avatar: null, is_kids: false, maturity_ceiling: 'adults', created_at: '2025-01-01' },
      { id: SECOND, account_id: OWNER, name: 'Second', avatar: null, is_kids: false, maturity_ceiling: 'adults', created_at: '2025-02-01' },
      { id: FOREIGN, account_id: 'another-account', name: 'Foreign', avatar: null, is_kids: false, maturity_ceiling: 'adults', created_at: '2024-01-01' },
    ],
    watchlists: [{ id: 'list-a', account_id: OWNER, profile_id: FIRST, name: 'My list' }, { id: 'list-b', account_id: OWNER, profile_id: SECOND, name: 'My list' }],
    watchlist_items: [{ watchlist_id: 'list-a', title_id: 'title-a' }, { watchlist_id: 'list-b', title_id: 'title-b' }],
    watch_progress: [
      { id: 'progress-a', account_id: OWNER, profile_id: FIRST, title_id: 'title-b', episode_id: null, position_seconds: 12, progress: 0.12, completed: false, updated_at: now },
      { id: 'progress-b', account_id: OWNER, profile_id: SECOND, title_id: 'title-b', episode_id: null, position_seconds: 77, progress: 0.77, completed: false, updated_at: now },
    ],
    playback_sessions: [
      { id: 'session-a', account_id: OWNER, profile_id: FIRST, title_id: 'title-a', episode_id: null, state: 'ended', started_at: now },
      { id: 'session-b', account_id: OWNER, profile_id: SECOND, title_id: 'title-b', episode_id: null, state: 'ended', started_at: now },
      { id: 'unattributed', account_id: OWNER, profile_id: null, title_id: 'title-old', episode_id: null, state: 'ended', started_at: now },
    ],
  };
  const fetchFixture: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== 'https://profile-fixture.example') throw new Error('Unexpected fixture destination');
    const table = url.pathname.split('/').at(-1)!;
    const method = init?.method ?? 'GET';
    const body: Row | undefined = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    requests.push({ table, method, query: url.searchParams, body });
    if (failure === table) return new Response(JSON.stringify({ code: 'fixture-error', message: 'unavailable' }), { status: 400 });
    let matched = (rows[table] ?? []).filter((row) => [...url.searchParams].every(([key, filter]) => {
      if (['select', 'order', 'limit', 'on_conflict'].includes(key)) return true;
      if (filter.startsWith('eq.')) return String(row[key]) === filter.slice(3);
      if (filter === 'is.null') return row[key] == null;
      if (filter.startsWith('gte.')) return String(row[key]) >= filter.slice(4);
      return false;
    }));
    const order = url.searchParams.get('order');
    if (order) {
      const [key, direction] = order.split('.');
      matched = [...matched].sort((a, b) => String(a[key!]).localeCompare(String(b[key!])) * (direction === 'desc' ? -1 : 1));
    }
    const limit = url.searchParams.get('limit');
    if (limit) matched = matched.slice(0, Number(limit));
    if (method === 'PATCH') for (const row of matched) Object.assign(row, body);
    if (method === 'DELETE') rows[table] = (rows[table] ?? []).filter((row) => !matched.includes(row));
    const accept = new Headers(init?.headers).get('accept') ?? '';
    return new Response(JSON.stringify(accept.includes('vnd.pgrst.object') ? matched[0] ?? null : matched), {
      headers: { 'content-type': 'application/json' },
    });
  };
  client = createClient<Database>('https://profile-fixture.example', 'synthetic-public-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: fetchFixture },
  });
  const user: User = { id: OWNER, aud: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: now, email: 'viewer@example.test', email_confirmed_at: now };
  vi.spyOn(client.auth, 'getUser').mockResolvedValue({ data: { user }, error: null });
  mocks.account.mockResolvedValue({ status: 'authenticated', client, user });
  mocks.server.mockResolvedValue(client);
  mocks.get.mockImplementation(() => selected ? { value: selected } : undefined);
  mocks.set.mockImplementation((_name, value) => { selected = value; });
  mocks.remove.mockImplementation(() => { selected = undefined; });
  mocks.title.mockImplementation(async (id) => ({ id, title: id, type: 'movie' }));
});

describe('active profile ownership and persistence', () => {
  it('selects an owned profile using a host-only HttpOnly cookie', async () => {
    expect(await selectProfileAction(SECOND)).toEqual({ ok: true });
    expect(mocks.set).toHaveBeenCalledWith(ACTIVE_PROFILE_COOKIE, SECOND, expect.objectContaining({ httpOnly: true, sameSite: 'lax', path: '/', maxAge: 2592000 }));
    expect(requests[0]?.query.get('account_id')).toBe(`eq.${OWNER}`);
    expect(mocks.revalidate).toHaveBeenCalledWith('/account', 'layout');
    expect(await getActiveProfileId()).toBe(SECOND);
    expect(await getDefaultProfileId()).toBe(SECOND);
  });

  it.each(['', 'not-a-profile', FOREIGN, '20000000-0000-4000-8000-000000000099'])('refuses the unavailable or malformed selection %s', async (id) => {
    expect((await selectProfileAction(id)).ok).toBe(false);
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it.each(['unverified', 'unauthenticated', 'unavailable'])('does not select a profile for an %s account', async (status) => {
    mocks.account.mockResolvedValue({ status });
    expect((await selectProfileAction(SECOND)).ok).toBe(false);
    expect(await getActiveProfileId()).toBeNull();
    expect(requests).toEqual([]);
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it.each([undefined, 'invalid', FOREIGN, '20000000-0000-4000-8000-000000000099'])('falls back only within the verified account for cookie %s', async (value) => {
    selected = value;
    expect(await getActiveProfileId()).toBe(FIRST);
    expect(requests.every((request) => request.query.get('account_id') === `eq.${OWNER}`)).toBe(true);
  });

  it('fails closed on cookie or database failure without silently switching to another profile', async () => {
    failure = 'profiles';
    expect(await getActiveProfileId()).toBeNull();
    expect(requests).toHaveLength(1);
    await expect(resolveActiveProfileId(client, OWNER)).rejects.toThrow('temporarily unavailable');
    failure = undefined;
    mocks.get.mockImplementation(() => { throw new Error('cookie unavailable'); });
    expect(await getActiveProfileId()).toBeNull();
  });

  it('refuses cross-account rename and delete without altering the selection', async () => {
    expect((await renameProfileAction(FOREIGN, 'Replacement')).ok).toBe(false);
    expect((await deleteProfileAction(FOREIGN)).ok).toBe(false);
    expect(rows.profiles?.find((row) => row.id === FOREIGN)?.name).toBe('Foreign');
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it('clears a deleted active selection and retains the remaining owned profile', async () => {
    expect(await deleteProfileAction(SECOND)).toEqual({ ok: true });
    expect(mocks.account).toHaveBeenCalledTimes(1);
    expect(requests.find((request) => request.table === 'profiles' && request.method === 'GET')?.query.get('select')).toBe('id');
    expect(requests.find((request) => request.table === 'profiles' && request.method === 'GET')?.query.get('limit')).toBe('2');
    expect(mocks.remove).toHaveBeenCalledWith(ACTIVE_PROFILE_COOKIE);
    expect(await getActiveProfileId()).toBe(FIRST);
    expect((await deleteProfileAction(FIRST)).ok).toBe(false);
  });
});

describe('selected-profile data boundaries', () => {
  it('isolates membership and title lists to the selected profile default list', async () => {
    expect(await isInWatchlist('title-a')).toBe(false);
    expect(await isInWatchlist('title-b')).toBe(true);
    expect((await listWatchlistTitles()).map((title) => title.id)).toEqual(['title-b']);
    expect(requests.filter((request) => request.table === 'watchlist_items').every((request) => request.query.get('watchlist_id') === 'eq.list-b')).toBe(true);
  });

  it('loads and writes only the selected profile and refuses a stale player scope', async () => {
    const key = `account:${OWNER}:profile:${SECOND}`;
    expect(await getPlaybackContext('title-b')).toMatchObject({ viewerKey: key, resumePosition: { positionSeconds: 77 } });
    expect(await reportProgressAction({ titleId: 'title-b', positionSeconds: 78, durationSeconds: 100, viewerKey: `account:${OWNER}:profile:${FIRST}` })).toEqual({ ok: false });
    expect(requests.some((request) => request.method === 'PATCH')).toBe(false);
    expect(await reportProgressAction({ titleId: 'title-b', positionSeconds: 78, durationSeconds: 100, viewerKey: key })).toEqual({ ok: true });
    expect(rows.watch_progress?.find((row) => row.id === 'progress-a')?.position_seconds).toBe(12);
    expect(rows.watch_progress?.find((row) => row.id === 'progress-b')?.position_seconds).toBe(78);
  });

  it('isolates history and continue-watching rather than mixing other or unattributed profiles', async () => {
    expect((await listWatchHistory()).map((entry) => entry.sessionId)).toEqual(['session-b']);
    expect((await getContinueWatching()).map((entry) => entry.title.id)).toEqual(['title-b']);
    expect(requests.filter((request) => request.table === 'playback_sessions').every((request) => request.query.get('profile_id') === `eq.${SECOND}`)).toBe(true);
  });
});
