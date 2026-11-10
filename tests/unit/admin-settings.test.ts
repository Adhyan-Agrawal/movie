import { createClient } from '@supabase/supabase-js';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminSiteSettingRow } from '@/features/admin/types';
import type { Json } from '@/lib/supabase/types';

const mocks = vi.hoisted(() => ({ server: vi.fn(), permission: vi.fn(), keys: [] as string[] }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/supabase/server', () => ({ getSupabaseServerClient: mocks.server }));
vi.mock('@/lib/permissions/check', () => ({ requirePermission: mocks.permission }));
vi.mock('@/features/catalog/repository', () => ({ repoListTitlesPaged: vi.fn() }));
vi.mock('@/features/admin/setting-keys', () => ({ GENERIC_SITE_SETTING_KEYS: mocks.keys }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { getEmailSettings, listSiteSettings } from '@/features/admin/queries';
import { saveEmailSettingsAction } from '@/features/admin/email-settings-actions';
import { updateFeatureFlagAction, updateSiteSettingAction } from '@/features/admin/settings-actions';
import { SettingsEditor } from '@/features/admin/SettingsEditor';
import AdminSettingsPage from '@/app/admin/settings/page';

const deployedPolicy = await vi.importActual<typeof import('@/features/admin/setting-keys')>('@/features/admin/setting-keys');
const actor = '00000000-0000-4000-8000-000000000001';
const secret = 'synthetic-private-password-never-generic';
const publicKey = 'test.generic';
const privateKey = 'test.private';
const row = (key: string, value: Json, is_public = false): AdminSiteSettingRow => ({
  key, value, is_public, description: 'Synthetic setting', updated_by: actor, updated_at: '2026-01-01T00:00:00Z',
});

let rows: AdminSiteSettingRow[];
let requests: Array<{ method: string; table: string; params: URLSearchParams; body: any }>;
let valueReads: string[];
let metadataError: boolean;
let writeError: boolean;
let privatizeAfterRead: boolean;
let getUser: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.keys.splice(0, mocks.keys.length, ...deployedPolicy.GENERIC_SITE_SETTING_KEYS);
  mocks.permission.mockResolvedValue(undefined);
  requests = [];
  valueReads = [];
  metadataError = writeError = privatizeAfterRead = false;
  rows = [
    row(publicKey, 'Public label', true), row(privateKey, secret),
    // Even a wrongly public reserved row must be excluded by key, not just visibility.
    row('smtp.pass', secret, true), row('smtp.host', 'smtp.example.invalid'),
    row('smtp.port', 587), row('smtp.user', 'operator'), row('smtp.from', 'mail@example.invalid'),
    row('email.templates', { reset: { subject: 'Private template' } }),
    row('playback_vast', { tagUrl: 'https://ads.example.invalid/?token=synthetic-private-vast' }, true),
    row('unknown.public', 'Not registered', true),
  ];

  // Real PostgREST query builder, in-process HTTP responses only. Projection
  // records exactly whose value is fetched, not just what the UI later hides.
  const client = createClient('https://settings.example.invalid', 'synthetic-anon-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (input, init) => {
      const url = new URL(String(input));
      const table = url.pathname.split('/').pop()!;
      const params = url.searchParams;
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      requests.push({ method, table, params, body });
      if (!['site_settings', 'feature_flags'].includes(table)) throw new Error('Unexpected test request');
      const columns = params.get('select')?.split(',').map((column) => column.trim()) ?? [];
      if ((metadataError && method === 'GET') || (writeError && method !== 'GET')) {
        return Response.json({ message: secret }, { status: 500 });
      }
      if (table === 'feature_flags') {
        return Response.json(method === 'GET' ? [{ key: 'fixture.flag', enabled: false, description: '' }] : []);
      }
      const key = params.get('key');
      let selected = rows.filter((setting) => {
        if (key?.startsWith('eq.') && setting.key !== key.slice(3)) return false;
        if (key?.startsWith('in.(') && !key.slice(4, -1).split(',').map((k) => k.replaceAll('"', '')).includes(setting.key)) return false;
        return params.get('is_public') !== 'eq.true' || setting.is_public;
      });
      if (method === 'PATCH') {
        selected.forEach((setting) => Object.assign(setting, body));
      } else if (method === 'POST') {
        const inserted = Array.isArray(body) ? body : [body];
        for (const value of inserted) {
          const existing = rows.find((setting) => setting.key === value.key);
          if (existing && !params.has('on_conflict')) {
            return Response.json({ message: secret }, { status: 409 });
          }
          if (existing) Object.assign(existing, value);
          else rows.push({ ...row(value.key, null), ...value });
        }
        selected = [];
      }
      const projected = selected.map((setting) => {
        if (columns.includes('*') || columns.includes('value')) valueReads.push(setting.key);
        return columns.includes('*') ? { ...setting } : Object.fromEntries(columns.map((column) => [column, setting[column as keyof AdminSiteSettingRow]]));
      });
      if (privatizeAfterRead && method === 'GET') {
        const setting = rows.find((item) => item.key === publicKey)!;
        setting.is_public = false;
      }
      return Response.json(projected);
    } },
  });
  getUser = vi.fn().mockResolvedValue({ data: { user: { id: actor } }, error: null });
  mocks.server.mockResolvedValue({ from: client.from.bind(client), auth: { getUser } });
});

describe('generic settings admission', () => {
  it('ships deny-by-default with no invented generic consumers and makes no settings read', async () => {
    expect(deployedPolicy.GENERIC_SITE_SETTING_KEYS).toEqual([]);
    expect(Object.isFrozen(deployedPolicy.GENERIC_SITE_SETTING_KEYS)).toBe(true);
    expect(await listSiteSettings()).toEqual([]);
    expect(mocks.server).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
  });

  it('filters admitted keys and public visibility in the database before reading values', async () => {
    // Test-only reviewed-key fixtures exercise the nonempty-policy branch.
    // They are never added to the deployed registry or to a real database.
    mocks.keys.push(publicKey, privateKey);
    expect(await listSiteSettings()).toEqual([rows[0]]);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.params.get('key')).toBe(`in.(${publicKey},${privateKey})`);
    expect(requests[0]!.params.get('is_public')).toBe('eq.true');
    expect(requests[0]!.params.get('select')).not.toContain('*');
    expect(valueReads).toEqual([publicKey]);
  });

  it.each([
    'smtp.pass', 'smtp.host', 'smtp.port', 'smtp.user', 'smtp.from', 'email.templates', 'playback_vast',
    'commerce.plan', 'billing.secret', 'stripe.secret_key', 'unknown.public', '__proto__', 'constructor',
    'prototype', `${publicKey},smtp.pass`, `${publicKey}\0`, `${publicKey}.smtp.pass`,
    'Test.generic', ` ${publicKey}`, `${publicKey} `, 'smtp%2epass', 'key.eq.smtp.pass', '*', '', null, {}, [publicKey], 123,
  ])('rejects an unregistered or malformed key before settings access: %j', async (key) => {
    mocks.keys.push(publicKey);
    const result = await updateSiteSettingAction(key as string, 'attacker value');
    expect(result.ok).toBe(false);
    expect(mocks.permission).toHaveBeenCalledWith('settings.manage');
    expect(mocks.server).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
    expect(rows.find((setting) => setting.key === 'smtp.pass')!.value).toBe(secret);
  });

  it('keeps the settings.manage gate ahead of any read or write', async () => {
    mocks.keys.push(publicKey);
    mocks.permission.mockRejectedValue(new Error('denied'));
    expect(await updateSiteSettingAction(publicKey, 'Changed')).toEqual({ ok: false, error: expect.stringContaining('settings.manage') });
    expect(mocks.server).not.toHaveBeenCalled();
  });

  it('denies a private allowlisted row without fetching its existing value', async () => {
    mocks.keys.push(privateKey);
    expect((await updateSiteSettingAction(privateKey, 'Changed')).ok).toBe(false);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.params.get('select')).toBe('key,is_public');
    expect(valueReads).toEqual([]);
    expect(getUser).not.toHaveBeenCalled();
    expect(rows.find((setting) => setting.key === privateKey)!.value).toBe(secret);
  });

  it('updates an admitted public value without loading it or changing visibility/description', async () => {
    mocks.keys.push(publicKey);
    expect(await updateSiteSettingAction(publicKey, { label: 'Changed', enabled: true })).toEqual({ ok: true });
    expect(valueReads).toEqual([]);
    const write = requests.find((request) => request.method === 'PATCH')!;
    expect(write.params.get('key')).toBe(`eq.${publicKey}`);
    expect(write.params.get('is_public')).toBe('eq.true');
    expect(write.body).toEqual({ value: { label: 'Changed', enabled: true }, updated_by: actor, updated_at: expect.any(String) });
    expect(rows[0]).toMatchObject({ is_public: true, description: 'Synthetic setting' });
  });

  it('cannot overwrite a setting made private between the metadata read and update', async () => {
    mocks.keys.push(publicKey);
    privatizeAfterRead = true;
    expect((await updateSiteSettingAction(publicKey, 'Changed')).ok).toBe(false);
    expect(rows[0]!.value).toBe('Public label');
    expect(valueReads).toEqual([]);
  });

  it('creates only an admitted public key when it is missing', async () => {
    mocks.keys.push(publicKey);
    rows = rows.filter((setting) => setting.key !== publicKey);
    expect(await updateSiteSettingAction(publicKey, 3)).toEqual({ ok: true });
    expect(requests.find((request) => request.method === 'POST')!.body).toEqual({
      key: publicKey, value: 3, is_public: true, updated_by: actor, updated_at: expect.any(String),
    });
    expect(valueReads).toEqual([]);
  });

  it.each([undefined, Number.NaN, new Date('2026-01-01T00:00:00Z')])('rejects a non-JSON value before data access', async (value) => {
    mocks.keys.push(publicKey);
    expect((await updateSiteSettingAction(publicKey, value as Json)).ok).toBe(false);
    expect(mocks.server).not.toHaveBeenCalled();
  });

  it('does not turn a failed metadata check into an insert or echo database details', async () => {
    mocks.keys.push(publicKey);
    metadataError = true;
    const result = await updateSiteSettingAction(publicKey, 'Changed');
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(requests.every((request) => request.method === 'GET')).toBe(true);
  });

  it('does not report a failed write as success or echo database details', async () => {
    mocks.keys.push(publicKey);
    writeError = true;
    const result = await updateSiteSettingAction(publicKey, 'Changed');
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});

describe('dedicated panels and presentation', () => {
  it('preserves dedicated SMTP redaction and blank-password preservation', async () => {
    expect(await getEmailSettings()).toEqual({ host: 'smtp.example.invalid', port: '587', user: 'operator', from: 'mail@example.invalid', hasPassword: true });
    const data = new FormData();
    for (const [key, value] of Object.entries({ host: 'smtp.example.invalid', port: '587', user: 'operator', from: 'mail@example.invalid', password: '' })) data.set(key, value);
    const result = await saveEmailSettingsAction({ status: 'idle', message: '' }, data);
    expect(result.status).toBe('ok');
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(rows.find((setting) => setting.key === 'smtp.pass')).toMatchObject({ value: secret, is_public: false });
    expect(mocks.permission).toHaveBeenCalledWith('settings.manage');
  });

  it('preserves permission-gated feature flag saves without touching site settings', async () => {
    expect(await updateFeatureFlagAction('fixture.flag', true)).toEqual({ ok: true });
    expect(requests.every((request) => request.table === 'feature_flags')).toBe(true);
    expect(mocks.permission).toHaveBeenCalledWith('settings.manage');
  });

  it('keeps reserved/private rows out of inputs even if a caller passes unexpected DTOs', () => {
    mocks.keys.push(publicKey, privateKey);
    const html = renderToStaticMarkup(createElement(SettingsEditor, { settings: rows, flags: [] }));
    expect(html).toContain('Public label');
    expect(html).toContain(`aria-label="${publicKey}"`);
    expect(html).not.toContain(secret);
    expect(html).not.toContain('synthetic-private-vast');
    expect(html).not.toContain('smtp.pass');
    expect(html).not.toContain('playback_vast');
  });

  it('renders honest generic-empty copy and dedicated destinations without reading private settings', async () => {
    const html = renderToStaticMarkup(await AdminSettingsPage());
    expect(html).toContain('No generic site settings available');
    expect(html).toContain('href="/admin/email"');
    expect(html).toContain('href="/admin/email/templates"');
    expect(html).toContain('href="/admin/ads"');
    expect(html).toContain('fixture.flag');
    expect(html).not.toContain(secret);
    expect(requests.every((request) => request.table === 'feature_flags')).toBe(true);
  });
});
