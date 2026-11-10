import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@/features/account/types';
import { ACCOUNT_PREFERENCE_METADATA_KEYS as keys, accountPreferencesSnapshot } from '@/features/account/preference-types';
import { readAccountSettings, settingsStorageKey, writeAccountSettings } from '@/features/account/settings-store';

const mocks = vi.hoisted(() => ({ verify: vi.fn(), update: vi.fn(), revalidate: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/features/auth/verified-account', () => ({ getVerifiedAccount: mocks.verify }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }));
import { getAccountPreferences } from '@/features/account/preference-queries';
import { loadAccountPreferencesAction, saveAccountPreferencesAction } from '@/features/account/preference-actions';

const accountA = '10000000-0000-4000-8000-000000000001';
const accountB = '20000000-0000-4000-8000-000000000002';
let user: { id: string; user_metadata: Record<string, unknown> };

beforeEach(() => {
  vi.clearAllMocks();
  user = { id: accountA, user_metadata: { private_note: 'synthetic-private', role: 'admin', maturity: 'adults', [keys.autoplayNext]: false } };
  mocks.verify.mockImplementation(async () => ({ status: 'authenticated', user, client: { auth: { updateUser: mocks.update } } }));
  mocks.update.mockImplementation(async ({ data }) => {
    Object.assign(user.user_metadata, data);
    return { data: { user: { ...user, user_metadata: { ...user.user_metadata } } }, error: null };
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('verified account preference persistence', () => {
  it('projects only bounded non-security preferences from the verified user', async () => {
    expect(await getAccountPreferences()).toEqual({ ok: true, snapshot: {
      accountId: accountA, settings: { ...DEFAULT_SETTINGS, autoplayNext: false }, hasSavedPreferences: true,
    } });
    expect(JSON.stringify(await getAccountPreferences())).not.toMatch(/synthetic-private|maturity|admin/);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('normalizes malformed metadata fields independently, with explicit absent/default state', () => {
    expect(accountPreferencesSnapshot(accountA, null)).toEqual({ accountId: accountA, settings: DEFAULT_SETTINGS, hasSavedPreferences: false });
    expect(accountPreferencesSnapshot(accountA, { [keys.language]: 'invalid', [keys.autoplayNext]: 'true', [keys.captions]: false }).settings)
      .toEqual({ ...DEFAULT_SETTINGS, captions: false });
    expect(accountPreferencesSnapshot(accountA, Object.create({ [keys.autoplayNext]: false })).hasSavedPreferences).toBe(false);
  });

  it.each(['unauthenticated', 'unverified', 'unavailable'])('does not read or save using %s identity or editable role claims', async (status) => {
    mocks.verify.mockResolvedValue({ status, user });
    expect(await getAccountPreferences()).toMatchObject({ ok: false, reason: status });
    expect(await saveAccountPreferencesAction(accountA, { autoplayNext: true })).toMatchObject({ ok: false, reason: status });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('rejects a stale account on read and save instead of choosing an owner from input', async () => {
    expect(await loadAccountPreferencesAction(accountB)).toMatchObject({ ok: false, reason: 'account-changed' });
    expect(await saveAccountPreferencesAction(accountB, { autoplayNext: true })).toMatchObject({ ok: false, reason: 'account-changed' });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it.each([
    {}, null, [], 'true', { autoplayNext: 'true' }, { captions: 1 }, { language: 'xx' }, { reducedMotion: null },
    { maturity: 'kids' }, { role: 'admin' }, { email_verified: true }, { app_metadata: { role: 'admin' } },
    { profileId: accountB }, { billing: 'paid' }, { data: { autoplayNext: true } },
    JSON.parse('{"autoplayNext":true,"__proto__":{"role":"admin"}}'),
  ])('rejects malformed or non-preference input without an update: %j', async (value) => {
    expect(await saveAccountPreferencesAction(accountA, value)).toMatchObject({ ok: false, reason: 'invalid' });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it.each(['', 'guest', accountA + ':profile:other'])('rejects malformed expected identity %s', async (identity) => {
    expect(await loadAccountPreferencesAction(identity)).toMatchObject({ ok: false, reason: 'invalid' });
    expect(await saveAccountPreferencesAction(identity, { autoplayNext: false })).toMatchObject({ ok: false, reason: 'invalid' });
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it('writes only supplied namespaced fields through updateUser and preserves unrelated metadata', async () => {
    const result = await saveAccountPreferencesAction(accountA, { autoplayNext: true });
    expect(mocks.update).toHaveBeenCalledExactlyOnceWith({ data: { [keys.autoplayNext]: true } });
    expect(user.user_metadata).toMatchObject({ private_note: 'synthetic-private', maturity: 'adults', role: 'admin' });
    expect(result).toMatchObject({ ok: true, snapshot: { accountId: accountA, settings: { autoplayNext: true } } });
    expect(JSON.stringify(result)).not.toMatch(/synthetic-private|maturity|admin/);
    expect(mocks.revalidate).toHaveBeenCalledWith('/account/settings');
  });

  it('does not overwrite a different preference changed since the verified read', async () => {
    mocks.update.mockImplementation(async ({ data }) => ({ data: { user: {
      ...user, user_metadata: { ...user.user_metadata, [keys.language]: 'fr', ...data },
    } }, error: null }));
    expect(await saveAccountPreferencesAction(accountA, { autoplayNext: true })).toMatchObject({ ok: true, snapshot: { settings: { language: 'fr', autoplayNext: true } } });
    expect(mocks.update.mock.calls[0]![0]).toEqual({ data: { [keys.autoplayNext]: true } });
  });

  it.each(['error', 'throw', 'missing user', 'different user', 'unapplied'])('does not falsely confirm %s or disclose backend details', async (failure) => {
    if (failure === 'throw') mocks.update.mockRejectedValue(new Error('synthetic-private'));
    else mocks.update.mockResolvedValue({ error: failure === 'error' ? { message: 'synthetic-private' } : null,
      data: { user: failure === 'missing user' ? null : { ...user, id: failure === 'different user' ? accountB : accountA } } });
    const result = await saveAccountPreferencesAction(accountA, { autoplayNext: true });
    expect(result).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(JSON.stringify(result)).not.toContain('synthetic-private');
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });

  it('reports an unavailable verified read instead of manufacturing defaults for an account', async () => {
    mocks.verify.mockRejectedValue(new Error('synthetic-private'));
    expect(await getAccountPreferences()).toEqual({ ok: false, reason: 'unavailable', message: expect.not.stringContaining('synthetic-private') });
  });
});

describe('legacy per-account browser cache', () => {
  function storage() {
    const values = new Map<string, string>();
    const store = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) };
    vi.stubGlobal('window', { localStorage: store });
    return { values, store };
  }

  it('has no browser access on the server and never aliases the guest player key', () => {
    vi.stubGlobal('window', undefined);
    expect(readAccountSettings(accountA)).toBeNull();
    expect(writeAccountSettings(accountA, DEFAULT_SETTINGS)).toBe(false);
    expect(settingsStorageKey(accountA)).not.toBe('lumora:player:auto-next:v1');
  });

  it('preserves each legacy account separately and drops maturity/unknown fields', () => {
    const { values } = storage();
    values.set(settingsStorageKey(accountA), JSON.stringify({ autoplayNext: false, maturity: 'kids', role: 'admin' }));
    expect(readAccountSettings(accountA)).toEqual({ ...DEFAULT_SETTINGS, autoplayNext: false });
    expect(readAccountSettings(accountB)).toBeNull();
    expect(writeAccountSettings(accountB, DEFAULT_SETTINGS)).toBe(true);
    expect(readAccountSettings(accountA)?.autoplayNext).toBe(false);
    expect(values.has('lumora:player:auto-next:v1')).toBe(false);
  });

  it.each(['null', '[]', 'false', 'invalid'])('rejects unusable stored JSON %s', (raw) => {
    const { values } = storage(); values.set(settingsStorageKey(accountA), raw);
    expect(readAccountSettings(accountA)).toBeNull();
  });

  it('truthfully reports blocked or silently unsuccessful writes and rejects empty owners', () => {
    const { store } = storage();
    store.setItem = () => { throw new Error('blocked'); };
    expect(writeAccountSettings(accountA, DEFAULT_SETTINGS)).toBe(false);
    store.setItem = () => new Map();
    expect(writeAccountSettings(accountA, DEFAULT_SETTINGS)).toBe(false);
    expect(readAccountSettings('guest')).toBeNull();
    expect(writeAccountSettings('', DEFAULT_SETTINGS)).toBe(false);
  });
});
