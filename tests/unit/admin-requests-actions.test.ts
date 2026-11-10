import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ permission: vi.fn(), server: vi.fn(), service: vi.fn(), revalidate: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }));
vi.mock('@/lib/permissions/check', () => ({ requirePermission: mocks.permission }));
vi.mock('@/lib/supabase/server', () => ({ getSupabaseServerClient: mocks.server }));
vi.mock('@/lib/supabase/service', () => ({ getSupabaseServiceClient: mocks.service }));
vi.mock('@/lib/env', () => ({ serverEnv: () => ({
  TMDB_API_BASE_URL: 'https://tmdb.fixture/3', TMDB_API_KEY: 'synthetic-test-only',
}) }));

import { importRequestedTitleAction, rejectRequestedTitleAction } from '@/features/admin/requests-actions';

const requestId = '00000000-0000-4000-8000-000000000001';
const titleId = '00000000-0000-4000-8000-000000000002';
const accountId = '00000000-0000-4000-8000-000000000003';
const pendingRequest = {
  id: requestId, account_id: accountId, title_name: 'Dune', media_type: 'movie', year: 2021,
  status: 'pending', updated_at: '2026-01-01T00:00:00.000Z',
};
const movieResult = { id: 2, title: 'Dune', original_title: 'Dune', release_date: '2021-09-15' };
const tvResult = { id: 2, name: 'Dune', original_name: 'Dune', first_air_date: '2021-09-15' };
const movieDetail = { ...movieResult, overview: 'A fixture synopsis.', genres: [] };
const tvDetail = { ...tvResult, overview: 'A fixture synopsis.', genres: [], seasons: [] };
const fetchMock = vi.fn<typeof fetch>();

type Row = Record<string, unknown>;
type DbResult = { data?: unknown; error: { message: string } | null };
let requestRow: Row | null;
let storedTitle: Row | null;
let confirmation: Row | null | undefined;
let searchResults: unknown[];
let searchMetadata: Row;
let detail: unknown;
let errors: Record<string, string>;
let beforeStatusWrite: (() => void) | undefined;
let events: string[];
let writes: { table: string; rows: Row[] }[];
let statusPatches: { patch: Row; filters: [string, unknown][] }[];
let requestProjections: string[];
let notifications: Row[];
let notificationAttempts: Row[];
let notificationCommittedBeforeError: boolean;

function database() {
  return {
    from: vi.fn((table: string) => {
      let operation = 'read';
      let columns = '';
      let rows: Row[] = [];
      let patch: Row = {};
      const filters: [string, unknown][] = [];
      const result = (single: boolean): DbResult => {
        const event = table === 'titles' && single && columns.includes('release_year')
          ? 'titles.confirm' : `${table}.${operation}`;
        events.push(event);
        const error = errors[event] ? { message: errors[event]! } : null;
        if (operation === 'upsert') {
          writes.push({ table, rows });
          if (!error && table === 'titles') storedTitle = { ...rows[0], id: titleId };
          return { error };
        }
        if (table === 'title_requests') {
          requestProjections.push(columns);
          if (operation === 'update') {
            beforeStatusWrite?.();
            statusPatches.push({ patch, filters });
            if (error || !requestRow || !filters.every(([key, value]) => requestRow![key] === value)) {
              return { data: null, error };
            }
            requestRow = { ...requestRow, ...patch };
            return { data: Object.fromEntries(columns.split(',').map((key) => [key.trim(), requestRow![key.trim()]])), error: null };
          }
          return { data: requestRow ? { ...requestRow } : null, error };
        }
        if (table === 'titles') {
          if (single) return { data: event === 'titles.confirm' && confirmation !== undefined ? confirmation : storedTitle, error };
          return { data: storedTitle ? [storedTitle] : [], error };
        }
        if (!['genres', 'seasons', 'title_people'].includes(table)) throw new Error(`Unexpected table: ${table}`);
        return { data: [], error };
      };
      const query = {
        select: vi.fn((value: string) => { columns = value; return query; }),
        eq: vi.fn((key: string, value: unknown) => { filters.push([key, value]); return query; }),
        in: vi.fn(() => query),
        upsert: vi.fn((value: Row[]) => { operation = 'upsert'; rows = value; return query; }),
        update: vi.fn((value: Row) => { operation = 'update'; patch = value; return query; }),
        maybeSingle: vi.fn(async () => result(true)),
        then: (resolve: (value: DbResult) => unknown) => Promise.resolve(result(false)).then(resolve),
      };
      return query;
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  requestRow = { ...pendingRequest };
  storedTitle = null;
  confirmation = undefined;
  searchResults = [movieResult];
  searchMetadata = { page: 1, total_pages: 1 };
  detail = movieDetail;
  errors = {};
  beforeStatusWrite = undefined;
  events = [];
  writes = [];
  statusPatches = [];
  requestProjections = []; notifications = []; notificationAttempts = []; notificationCommittedBeforeError = false;
  mocks.permission.mockResolvedValue(undefined);
  mocks.server.mockResolvedValue(database());
  mocks.service.mockImplementation(() => ({ from: (table: string) => {
    if (table !== 'notifications') throw new Error('Request imports must use the RLS client.');
    return { insert: (row: Row) => ({ abortSignal: async () => {
      events.push('notifications.insert');
      notificationAttempts.push(row);
      const error = errors['notifications.insert'] ? { message: errors['notifications.insert']! } : null;
      if (!error || notificationCommittedBeforeError) notifications.push({ ...row, id: 'fixture-notification', read_at: null });
      return { error };
    } }) };
  } }));
  fetchMock.mockReset().mockImplementation(async (input) => {
    const url = new URL(String(input));
    if (url.origin !== 'https://tmdb.fixture') throw new Error('Unmocked HTTP origin.');
    if (url.pathname === '/3/search/movie' || url.pathname === '/3/search/tv') {
      return Response.json({ total_results: searchResults.length, ...searchMetadata, results: searchResults });
    }
    if (url.pathname === '/3/movie/2' || url.pathname === '/3/tv/2') return Response.json(detail);
    throw new Error(`Unmocked HTTP path: ${url.pathname}`);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function expectUnchanged() {
  expect(requestRow?.status).toBe('pending');
  expect(statusPatches).toEqual([]);
  expect(mocks.revalidate).not.toHaveBeenCalled();
  expect(mocks.service).not.toHaveBeenCalled();
  expect(notifications).toEqual([]);
}

describe('request-specific TMDB import', () => {
  it('imports only the exact movie/year, not the top-ranked remake or a fuzzy title', async () => {
    searchResults = [
      { ...movieResult, id: 1, release_date: '1984-12-14' },
      { ...movieResult, id: 3, title: 'Dune Part Two', original_title: 'Dune Part Two' },
      movieResult,
    ];
    expect(await importRequestedTitleAction(requestId)).toEqual({ ok: true });
    const urls = fetchMock.mock.calls.map(([url]) => new URL(String(url)));
    expect(urls.map((url) => url.pathname)).toEqual(['/3/search/movie', '/3/movie/2']);
    expect(urls[0]!.searchParams.get('year')).toBe('2021');
    expect(urls[0]!.searchParams.has('first_air_date_year')).toBe(false);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ table: 'titles', rows: [{ type: 'movie', tmdb_id: 2, release_year: 2021 }] });
    expect(writes[0]!.rows).toHaveLength(1);
    expect(events.indexOf('titles.confirm')).toBeLessThan(events.indexOf('title_requests.update'));
    expect(statusPatches[0]!.filters).toEqual([
      ['id', requestId], ['status', 'pending'], ['updated_at', pendingRequest.updated_at],
    ]);
    expect(Object.keys(statusPatches[0]!.patch).sort()).toEqual(['status', 'updated_at']);
    expect(requestRow?.status).toBe('imported');
    expect(mocks.permission).toHaveBeenCalledWith('catalog.create');
    expect(mocks.service).toHaveBeenCalledOnce();
    expect(mocks.revalidate).toHaveBeenCalledWith('/admin/requests');
  });

  it('searches and imports only TV using the first-air year', async () => {
    requestRow!.media_type = 'tv'; searchResults = [tvResult]; detail = tvDetail;
    expect(await importRequestedTitleAction(requestId)).toEqual({ ok: true });
    const urls = fetchMock.mock.calls.map(([url]) => new URL(String(url)));
    expect(urls.map((url) => url.pathname)).toEqual(['/3/search/tv', '/3/tv/2']);
    expect(urls[0]!.searchParams.get('first_air_date_year')).toBe('2021');
    expect(urls[0]!.searchParams.has('year')).toBe(false);
    expect(writes[0]).toMatchObject({ table: 'titles', rows: [{ type: 'tv', tmdb_id: 2, release_year: 2021 }] });
  });

  it('accepts an exact original-name match with case/whitespace normalization', async () => {
    requestRow!.title_name = '  DUNE  ';
    searchResults = [{ ...movieResult, title: 'Localized Name' }];
    detail = { ...movieDetail, title: 'Localized Name' };
    expect(await importRequestedTitleAction(requestId)).toEqual({ ok: true });
    expect(writes[0]!.rows[0]!.name).toBe('Localized Name');
  });

  it('deduplicates repeated results for the same TMDB identity', async () => {
    searchResults = [movieResult, movieResult];
    expect(await importRequestedTitleAction(requestId)).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(writes[0]!.rows).toHaveLength(1);
  });

  it('allows an omitted year only for a unique exact-name identity', async () => {
    requestRow!.year = null;
    expect(await importRequestedTitleAction(requestId)).toEqual({ ok: true });
    expect(new URL(String(fetchMock.mock.calls[0]![0])).searchParams.has('year')).toBe(false);
  });

  it('does not guess between remakes when the request has no year', async () => {
    requestRow!.year = null;
    searchResults = [{ ...movieResult, id: 1, release_date: '1984-12-14' }, movieResult];
    expect((await importRequestedTitleAction(requestId)).ok).toBe(false);
    expectUnchanged(); expect(writes).toEqual([]); expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    ['no match', []],
    ['wrong year', [{ ...movieResult, release_date: '1984-12-14' }]],
    ['fuzzy name', [{ ...movieResult, title: 'Dune Part Two', original_title: 'Dune Part Two' }]],
    ['same-year ambiguity', [movieResult, { ...movieResult, id: 3 }]],
    ['unresolved year on a second name match', [movieResult, { ...movieResult, id: 3, release_date: '' }]],
    ['wrong kind', [{ ...movieResult, media_type: 'tv' }]],
    ['wrong kind shape', [tvResult]],
    ['invalid id', [{ ...movieResult, id: 0 }]],
    ['invalid row', [null]],
  ])('preserves the request without importing on %s', async (_label, results) => {
    searchResults = results as unknown[];
    expect((await importRequestedTitleAction(requestId)).ok).toBe(false);
    expectUnchanged(); expect(writes).toEqual([]); expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    { total_pages: 2 }, { total_pages: undefined }, { total_results: 2 }, { page: 2 },
  ])('refuses to infer uniqueness from incomplete pagination: %j', async (metadata) => {
    searchMetadata = { ...searchMetadata, ...metadata };
    expect((await importRequestedTitleAction(requestId)).ok).toBe(false);
    expectUnchanged(); expect(writes).toEqual([]); expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    { ...movieDetail, id: 3 },
    { ...movieDetail, release_date: '1984-12-14' },
    { ...movieDetail, title: 'Another Title', original_title: 'Another Title' },
    { ...movieDetail, overview: '' },
    tvDetail,
    null,
  ])('rechecks the detail identity before any database import: %j', async (payload) => {
    detail = payload;
    expect((await importRequestedTitleAction(requestId)).ok).toBe(false);
    expectUnchanged(); expect(writes).toEqual([]);
  });

  it('does not overwrite a same-slug title belonging to a different media identity', async () => {
    storedTitle = { id: titleId, type: 'tv', tmdb_id: 2, slug: 'dune-2' };
    expect((await importRequestedTitleAction(requestId)).ok).toBe(false);
    expectUnchanged(); expect(writes).toEqual([]);
  });

  it('can reimport the same existing identity', async () => {
    storedTitle = { id: titleId, type: 'movie', tmdb_id: 2, slug: 'dune-2' };
    expect(await importRequestedTitleAction(requestId)).toEqual({ ok: true });
    expect(writes[0]!.rows).toHaveLength(1);
  });

  it.each(['titles.read', 'titles.upsert', 'titles.confirm'])('leaves status pending when %s fails', async (event) => {
    errors[event] = 'Mocked database failure';
    expect((await importRequestedTitleAction(requestId)).ok).toBe(false);
    expectUnchanged();
  });

  it.each([
    null,
    { id: titleId, type: 'tv', tmdb_id: 2, slug: 'dune-2', release_year: 2021 },
    { id: titleId, type: 'movie', tmdb_id: 3, slug: 'dune-2', release_year: 2021 },
    { id: titleId, type: 'movie', tmdb_id: 2, slug: 'dune-2', release_year: 1984 },
  ])('requires a persisted matching identity after upsert: %j', async (row) => {
    confirmation = row;
    expect((await importRequestedTitleAction(requestId)).ok).toBe(false);
    expect(writes).toHaveLength(1); expectUnchanged();
  });

  it('leaves the request pending when TMDB is unreachable', async () => {
    fetchMock.mockRejectedValueOnce(new Error('Mocked network failure'));
    expect((await importRequestedTitleAction(requestId)).ok).toBe(false);
    expectUnchanged(); expect(writes).toEqual([]);
  });
});

describe('request status boundary', () => {
  it('checks permission before reading or importing', async () => {
    mocks.permission.mockRejectedValueOnce(new Error('Denied'));
    expect((await importRequestedTitleAction(requestId)).ok).toBe(false);
    expect(mocks.server).not.toHaveBeenCalled(); expect(fetchMock).not.toHaveBeenCalled(); expectUnchanged();
  });

  it('rejects invalid request ids before database access', async () => {
    expect((await importRequestedTitleAction('not-a-uuid')).ok).toBe(false);
    expect(mocks.server).not.toHaveBeenCalled(); expect(fetchMock).not.toHaveBeenCalled(); expectUnchanged();
  });

  it.each(['imported', 'rejected'])('does not import a %s request again', async (status) => {
    requestRow!.status = status;
    expect((await importRequestedTitleAction(requestId)).ok).toBe(false);
    expect(requestRow!.status).toBe(status); expect(fetchMock).not.toHaveBeenCalled(); expect(writes).toEqual([]);
  });

  it.each([{ title_name: '' }, { media_type: 'both' }, { year: 1700 }, { year: 2021.5 }, { year: '2021' }])(
    'refuses malformed stored request identity: %j', async (values) => {
      requestRow = { ...pendingRequest, ...values };
      expect((await importRequestedTitleAction(requestId)).ok).toBe(false);
      expectUnchanged(); expect(fetchMock).not.toHaveBeenCalled(); expect(writes).toEqual([]);
    },
  );

  it('reports a failed status write instead of a completed request', async () => {
    errors['title_requests.update'] = 'Mocked status write failure';
    expect(await importRequestedTitleAction(requestId)).toMatchObject({ ok: false, error: expect.stringContaining('Could not mark') });
    expect(requestRow!.status).toBe('pending'); expect(mocks.revalidate).not.toHaveBeenCalled();
    expect(mocks.service).not.toHaveBeenCalled(); expect(notifications).toEqual([]);
  });

  it.each(['status', 'updated_at'])('does not overwrite a concurrent request %s change', async (field) => {
    beforeStatusWrite = () => { requestRow![field] = field === 'status' ? 'rejected' : '2026-01-02T00:00:00.000Z'; };
    expect(await importRequestedTitleAction(requestId)).toMatchObject({ ok: false, error: expect.stringContaining('changed') });
    expect(requestRow!.status).toBe(field === 'status' ? 'rejected' : 'pending');
    expect(mocks.revalidate).not.toHaveBeenCalled();
    expect(mocks.service).not.toHaveBeenCalled(); expect(notifications).toEqual([]);
  });
});

describe('persisted request-status notifications', () => {
  it('notifies the requesting account only after the confirmed catalog import and status transition', async () => {
    requestRow!.note = 'synthetic-internal-note-with-provider-and-credentials';
    expect(await importRequestedTitleAction(requestId)).toEqual({ ok: true });
    expect(events.indexOf('titles.confirm')).toBeLessThan(events.indexOf('title_requests.update'));
    expect(events.indexOf('title_requests.update')).toBeLessThan(events.indexOf('notifications.insert'));
    expect(notifications).toHaveLength(1);
    expect(notificationAttempts[0]).toEqual({
      account_id: accountId, profile_id: null, kind: 'import', title: 'Your requested title was imported',
      body: 'Your request for "Dune" was added to the catalog. Playback availability can vary.',
      data: { request_id: requestId, status: 'imported' },
    });
    expect(JSON.stringify(notifications)).not.toContain('synthetic-internal');
    expect(requestProjections.every((columns) => !columns.includes('*') && !columns.includes('note'))).toBe(true);
    expect(mocks.revalidate).toHaveBeenCalledWith('/account/notifications');
    expect(mocks.revalidate).toHaveBeenCalledWith('/request');
  });

  it('notifies a real pending-to-rejected transition without importing or exposing notes', async () => {
    requestRow!.note = 'synthetic-private-provider';
    expect(await rejectRequestedTitleAction(requestId)).toEqual({ ok: true });
    expect(mocks.permission).toHaveBeenCalledWith('catalog.create');
    expect(requestRow!.status).toBe('rejected'); expect(fetchMock).not.toHaveBeenCalled();
    expect(statusPatches[0]!.filters).toEqual([['id', requestId], ['status', 'pending']]);
    expect(notifications).toHaveLength(1);
    expect(notificationAttempts[0]).toMatchObject({ account_id: accountId, profile_id: null, kind: 'moderation',
      body: 'Your request for "Dune" was not approved.', data: { request_id: requestId, status: 'rejected' } });
    expect(JSON.stringify(notifications)).not.toContain('synthetic-private');
  });

  it.each(['import', 'reject'])('does not duplicate a notice when the %s action is retried or the other status is requested', async (kind) => {
    const action = kind === 'import' ? importRequestedTitleAction : rejectRequestedTitleAction;
    expect(await action(requestId)).toEqual({ ok: true });
    expect((await action(requestId)).ok).toBe(false);
    expect((await (kind === 'import' ? rejectRequestedTitleAction : importRequestedTitleAction)(requestId)).ok).toBe(false);
    expect(notifications).toHaveLength(1); expect(notificationAttempts).toHaveLength(1);
    expect(requestRow!.status).toBe(kind === 'import' ? 'imported' : 'rejected');
  });

  it.each(['import', 'reject'])('emits only one notice for concurrent %s transitions', async (kind) => {
    const action = kind === 'import' ? importRequestedTitleAction : rejectRequestedTitleAction;
    const results = await Promise.all([action(requestId), action(requestId)]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(notifications).toHaveLength(1); expect(notificationAttempts).toHaveLength(1);
  });

  it.each(['imported', 'rejected'])('does not announce a reject for an already %s request', async (status) => {
    requestRow!.status = status;
    expect((await rejectRequestedTitleAction(requestId)).ok).toBe(false);
    expect(requestRow!.status).toBe(status);
    expect(mocks.service).not.toHaveBeenCalled(); expect(notifications).toEqual([]);
  });

  it('does not announce a missing request or a failed rejection', async () => {
    requestRow = null;
    expect((await rejectRequestedTitleAction(requestId)).ok).toBe(false);
    requestRow = { ...pendingRequest }; errors['title_requests.update'] = 'Mocked failure';
    expect((await rejectRequestedTitleAction(requestId)).ok).toBe(false);
    expect(requestRow!.status).toBe('pending');
    expect(mocks.service).not.toHaveBeenCalled(); expect(notifications).toEqual([]);
  });

  it('keeps rejection permission and UUID validation ahead of any data or service access', async () => {
    mocks.permission.mockRejectedValueOnce(new Error('Denied'));
    expect((await rejectRequestedTitleAction(requestId)).ok).toBe(false);
    expect((await rejectRequestedTitleAction('invalid')).ok).toBe(false);
    expect(mocks.server).not.toHaveBeenCalled(); expect(mocks.service).not.toHaveBeenCalled();
    expect(notificationAttempts).toEqual([]);
  });

  it.each(['import', 'reject'])('reports partial success truthfully when notification configuration is unavailable: %s', async (kind) => {
    mocks.service.mockImplementation(() => { throw new Error('synthetic-private-configuration'); });
    const result = await (kind === 'import' ? importRequestedTitleAction : rejectRequestedTitleAction)(requestId);
    expect(result).toMatchObject({ ok: false, requestUpdated: true, error: expect.stringContaining('request status is saved') });
    expect(result.error).not.toContain('synthetic-private');
    expect(requestRow!.status).toBe(kind === 'import' ? 'imported' : 'rejected');
    expect(mocks.revalidate).toHaveBeenCalledWith('/admin/requests');
    expect(mocks.revalidate).toHaveBeenCalledWith('/request');
    expect(notifications).toEqual([]);
  });

  it.each(['import', 'reject'])('does not pretend a failed notification write rolled back the %s transition', async (kind) => {
    errors['notifications.insert'] = 'synthetic-private-database-diagnostic';
    const action = kind === 'import' ? importRequestedTitleAction : rejectRequestedTitleAction;
    const result = await action(requestId);
    expect(result).toMatchObject({ ok: false, requestUpdated: true, error: expect.stringContaining('could not be confirmed') });
    expect(result.error).not.toContain('synthetic-private');
    expect(requestRow!.status).toBe(kind === 'import' ? 'imported' : 'rejected');
    expect(notifications).toEqual([]);
    expect((await action(requestId)).ok).toBe(false);
    expect(notificationAttempts).toHaveLength(1);
  });

  it('does not duplicate a committed notification after its acknowledgement was lost', async () => {
    errors['notifications.insert'] = 'Mocked lost response'; notificationCommittedBeforeError = true;
    expect(await rejectRequestedTitleAction(requestId)).toMatchObject({ ok: false, requestUpdated: true });
    expect(notifications).toHaveLength(1); expect(requestRow!.status).toBe('rejected');
    expect((await rejectRequestedTitleAction(requestId)).ok).toBe(false);
    expect(notifications).toHaveLength(1); expect(notificationAttempts).toHaveLength(1);
  });

  it('does not use a malformed database recipient for privileged insertion', async () => {
    requestRow!.account_id = 'not-an-account-uuid';
    expect(await rejectRequestedTitleAction(requestId)).toMatchObject({ ok: false, requestUpdated: true });
    expect(requestRow!.status).toBe('rejected'); expect(mocks.service).not.toHaveBeenCalled();
    expect(notificationAttempts).toEqual([]);
  });
});
