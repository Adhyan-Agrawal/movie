import { createClient } from '@supabase/supabase-js';
import { createElement, type AnchorHTMLAttributes } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database, Tables } from '@/lib/supabase/types';

const mocks = vi.hoisted(() => ({ account: vi.fn(), revalidate: vi.fn(), noStore: vi.fn(), service: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate, unstable_noStore: mocks.noStore }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('next/link', () => ({ default: (props: AnchorHTMLAttributes<HTMLAnchorElement>) => createElement('a', props) }));
vi.mock('@/features/auth/verified-account', () => ({ getVerifiedAccount: mocks.account }));
vi.mock('@/lib/supabase/service', () => ({ getSupabaseServiceClient: mocks.service }));

import { listAccountNotifications } from '@/features/account/notifications';
import { markAllNotificationsReadAction, markNotificationReadAction } from '@/features/account/notification-actions';
import NotificationsPage from '@/app/account/notifications/page';

const owner = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const firstId = '10000000-0000-4000-8000-000000000001';
const secret = 'synthetic-private-metadata-never-render';
const notice = (index = 1, account_id = owner): Tables<'notifications'> => ({
  id: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`, account_id,
  profile_id: index % 2 ? null : '20000000-0000-4000-8000-000000000001',
  kind: 'system', title: `Notice ${index}`, body: `Account notice ${index}.`,
  data: { private: secret, provider: 'internal-provider' }, read_at: null,
  created_at: '2026-11-08T03:00:00.123456+00:00',
});
let rows: Tables<'notifications'>[];
let requests: { method: string; params: URLSearchParams; body: Record<string, unknown> | null }[];
let readError: boolean;
let writeError: boolean;
let leakExtraFields: boolean;
let beforeWrite: (() => void) | undefined;
const unexpectedFetch = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.clearAllMocks();
  rows = [notice(), notice(2), notice(3, other)];
  requests = []; readError = false; writeError = false; leakExtraFields = false; beforeWrite = undefined;
  unexpectedFetch.mockReset().mockRejectedValue(new Error('Live HTTP is forbidden.'));
  vi.stubGlobal('fetch', unexpectedFetch);
  mocks.service.mockImplementation(() => { throw new Error('No service-role notification reads or mark-read writes.'); });
  const client = createClient<Database>('https://notifications.example.invalid', 'synthetic-anon-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.origin !== 'https://notifications.example.invalid' || url.pathname !== '/rest/v1/notifications') {
        throw new Error('Unexpected synthetic endpoint.');
      }
      const params = url.searchParams;
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      requests.push({ method, params, body });
      if ((method === 'GET' && readError) || (method === 'PATCH' && writeError)) {
        return Response.json({ message: secret }, { status: 500 });
      }
      if (method === 'PATCH') beforeWrite?.();
      let selected = rows.filter((row) =>
        (!params.has('account_id') || params.get('account_id') === `eq.${row.account_id}`)
        && (!params.has('id') || params.get('id') === `eq.${row.id}`)
        && (params.get('read_at') !== 'is.null' || row.read_at === null));
      const cursor = params.get('or')?.match(/^\(created_at\.lt\.([^,]+),and\(created_at\.eq\.([^,]+),id\.lt\.([0-9a-f-]+)\)\)$/i);
      if (params.has('or') && !cursor) throw new Error('Invalid cursor reached the database.');
      if (cursor) selected = selected.filter((row) =>
        row.created_at < cursor[1]! || (row.created_at === cursor[2] && row.id < cursor[3]!));
      selected.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
      if (params.has('limit')) selected = selected.slice(0, Number(params.get('limit')));
      if (method === 'PATCH') selected.forEach((row) => Object.assign(row, body));
      const columns = params.get('select')?.split(',').map((value) => value.trim()) ?? [];
      const projected = selected.map((row) => leakExtraFields ? { ...row }
        : Object.fromEntries(columns.map((column) => [column, row[column as keyof typeof row]])));
      const single = new Headers(init?.headers).get('accept')?.includes('object+json');
      return Response.json(single ? projected[0] ?? null : projected);
    } },
  });
  mocks.account.mockResolvedValue({ status: 'authenticated', user: { id: owner }, client });
});

afterEach(() => {
  expect(unexpectedFetch).not.toHaveBeenCalled();
  expect(mocks.service).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe('verified account notification feed', () => {
  it('filters by verified account in PostgREST and projects only safe display fields', async () => {
    const result = await listAccountNotifications();
    expect(result).toMatchObject({ status: 'ready', notifications: [{ id: notice(2).id }, { id: firstId }], older: null, isOlderPage: false });
    expect(mocks.noStore).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(1);
    const params = requests[0]!.params;
    expect(params.get('account_id')).toBe(`eq.${owner}`);
    expect(params.has('profile_id')).toBe(false);
    expect(params.get('select')).toBe('id,kind,title,body,read_at,created_at');
    expect(params.get('order')).toBe('created_at.desc,id.desc');
    expect(params.get('limit')).toBe('21');
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain('account_id');
  });

  it('does not serialize unexpected extra fields even if a backend returns them', async () => {
    leakExtraFields = true;
    const result = await listAccountNotifications();
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain('profile_id');
    expect(JSON.stringify(result)).not.toContain('internal-provider');
  });

  it('pages with full timestamp precision and UUID tie-breaking without losing same-time notices', async () => {
    rows = Array.from({ length: 23 }, (_, index) => notice(index + 1));
    const first = await listAccountNotifications();
    if (first.status !== 'ready') throw new Error('Expected a ready feed.');
    expect(first.notifications).toHaveLength(20);
    expect(first.older).toBe(`${notice(4).created_at}|${notice(4).id}`);
    const second = await listAccountNotifications(first.older!);
    if (second.status !== 'ready') throw new Error('Expected an older page.');
    expect(second.notifications.map((row) => row.id)).toEqual([notice(3).id, notice(2).id, notice(1).id]);
    expect(second.older).toBeNull(); expect(second.isOlderPage).toBe(true);
    expect(new Set([...first.notifications, ...second.notifications].map((row) => row.id)).size).toBe(23);
    expect(requests[1]!.params.get('account_id')).toBe(`eq.${owner}`);
  });

  it.each(['', 'invalid', `${notice().created_at}|${firstId}),account_id.eq.${other}`, '2026-99-99T03:00:00Z|' + firstId, '2026-11-08T03:00:00Z|not-a-uuid']) (
    'rejects malformed or injected pagination before database access: %s', async (cursor) => {
      expect(await listAccountNotifications(cursor)).toMatchObject({ status: 'error' });
      expect(requests).toEqual([]);
    },
  );

  it.each(['unauthenticated', 'unverified', 'unavailable'])('does not fetch data for %s accounts', async (status) => {
    mocks.account.mockResolvedValue({ status });
    expect(await listAccountNotifications()).toEqual({ status });
    expect(requests).toEqual([]);
  });

  it('distinguishes database failure from an empty account without leaking diagnostics', async () => {
    readError = true;
    const result = await listAccountNotifications();
    expect(result).toMatchObject({ status: 'error' });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('returns an honest empty feed', async () => {
    rows = [notice(3, other)];
    expect(await listAccountNotifications()).toEqual({ status: 'ready', notifications: [], older: null, isOlderPage: false });
  });

  it('does not cache one account feed for a later identity', async () => {
    await listAccountNotifications();
    const account = await mocks.account.mock.results[0]!.value;
    mocks.account.mockResolvedValue({ ...account, user: { id: other } });
    const result = await listAccountNotifications();
    expect(result).toMatchObject({ status: 'ready', notifications: [{ id: notice(3).id }] });
    expect(requests.map((request) => request.params.get('account_id'))).toEqual([`eq.${owner}`, `eq.${other}`]);
  });
});

describe('ownership-scoped mark-read actions', () => {
  it('updates only the selected owned unread row and preserves every other field', async () => {
    const before = { ...rows[0]! };
    expect(await markNotificationReadAction(firstId)).toEqual({ ok: true });
    expect(rows[0]!.read_at).toEqual(expect.any(String));
    expect({ ...rows[0], read_at: null }).toEqual(before);
    expect(rows[1]!.read_at).toBeNull(); expect(rows[2]!.read_at).toBeNull();
    const request = requests[0]!;
    expect(request.method).toBe('PATCH');
    expect(request.params.get('account_id')).toBe(`eq.${owner}`);
    expect(request.params.get('id')).toBe(`eq.${firstId}`);
    expect(request.params.get('read_at')).toBe('is.null');
    expect(Object.keys(request.body!)).toEqual(['read_at']);
    expect(mocks.revalidate).toHaveBeenCalledWith('/account/notifications');
  });

  it('does not read or mark another account notification, even with a valid UUID', async () => {
    expect((await markNotificationReadAction(notice(3).id)).ok).toBe(false);
    expect(rows[2]!.read_at).toBeNull();
    expect(requests.every((request) => request.params.get('account_id') === `eq.${owner}`)).toBe(true);
    expect(requests[1]!.params.get('select')).toBe('id,read_at');
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });

  it('is idempotent without changing the original read time', async () => {
    rows[0]!.read_at = '2026-11-07T01:00:00Z';
    expect(await markNotificationReadAction(firstId)).toEqual({ ok: true });
    expect(rows[0]!.read_at).toBe('2026-11-07T01:00:00Z');
    expect(requests).toHaveLength(2);
  });

  it('accepts a concurrent read but preserves its timestamp', async () => {
    beforeWrite = () => { rows[0]!.read_at = '2026-11-07T02:00:00Z'; };
    expect(await markNotificationReadAction(firstId)).toEqual({ ok: true });
    expect(rows[0]!.read_at).toBe('2026-11-07T02:00:00Z');
  });

  it('marks unread notices across all owned profiles, not other accounts', async () => {
    rows[0]!.read_at = '2026-11-07T01:00:00Z';
    expect(await markAllNotificationsReadAction()).toEqual({ ok: true });
    expect(rows[0]!.read_at).toBe('2026-11-07T01:00:00Z');
    expect(rows[1]!.read_at).toEqual(expect.any(String)); expect(rows[2]!.read_at).toBeNull();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.params.get('account_id')).toBe(`eq.${owner}`);
    expect(requests[0]!.params.get('read_at')).toBe('is.null');
    expect(requests[0]!.params.has('profile_id')).toBe(false);
    expect(Object.keys(requests[0]!.body!)).toEqual(['read_at']);
  });

  it.each([undefined, null, '', {}, [firstId], 'not-a-uuid', firstId + ',account_id.eq.' + other])(
    'does not turn an invalid individual id into mark-all: %j', async (id) => {
      expect((await markNotificationReadAction(id as string)).ok).toBe(false);
      expect(requests).toEqual([]);
    },
  );

  it.each(['unauthenticated', 'unverified', 'unavailable'])('rejects both mark operations for %s accounts', async (status) => {
    mocks.account.mockResolvedValue({ status });
    expect((await markNotificationReadAction(firstId)).ok).toBe(false);
    expect((await markAllNotificationsReadAction()).ok).toBe(false);
    expect(requests).toEqual([]);
  });

  it.each([false, true])('reports write errors without changing local state (all: %s)', async (all) => {
    writeError = true;
    const result = all ? await markAllNotificationsReadAction() : await markNotificationReadAction(firstId);
    expect(result.ok).toBe(false); expect(JSON.stringify(result)).not.toContain(secret);
    expect(rows.every((row) => row.read_at === null)).toBe(true);
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });

  it('handles thrown account-verification failures without a write or raw error', async () => {
    mocks.account.mockRejectedValue(new Error(secret));
    const result = await markAllNotificationsReadAction();
    expect(result.ok).toBe(false); expect(JSON.stringify(result)).not.toContain(secret);
    expect(requests).toEqual([]);
  });
});

describe('notifications page', () => {
  it('renders actual persisted notices and read state with escaped content, not metadata', async () => {
    rows[0]!.body = '<script>window.stolen = true</script>';
    rows[0]!.read_at = '2026-11-07T01:00:00Z';
    const html = renderToStaticMarkup(await NotificationsPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain('Notice 1'); expect(html).toContain('Notice 2'); expect(html).not.toContain('Notice 3');
    expect(html).toContain('Unread'); expect(html).toContain('Read');
    expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('<script>');
    expect(html).not.toContain(secret); expect(html).not.toContain('internal-provider');
    expect(html).toContain('not sent by email');
  });

  it.each([
    ['unauthenticated', 'Sign in to continue'], ['unverified', 'Confirm your email'], ['unavailable', 'Accounts are unavailable'],
  ])('gates the page independently of the layout: %s', async (status, label) => {
    mocks.account.mockResolvedValue({ status });
    const html = renderToStaticMarkup(await NotificationsPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain(label); expect(html).not.toContain('Mark all as read'); expect(requests).toEqual([]);
  });

  it('renders error/retry instead of the empty state on database failure', async () => {
    readError = true;
    const html = renderToStaticMarkup(await NotificationsPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain('Notifications are unavailable'); expect(html).toContain('Try again');
    expect(html).not.toContain('No notifications yet'); expect(html).not.toContain(secret);
  });

  it('rejects multiple cursor query parameters without selecting arbitrary input', async () => {
    const html = renderToStaticMarkup(await NotificationsPage({ searchParams: Promise.resolve({ before: ['a', 'b'] }) }));
    expect(html).toContain('notifications page is invalid'); expect(requests).toEqual([]);
  });
});
