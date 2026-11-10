import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  features: { supabaseConfigured: true }, verified: vi.fn(), from: vi.fn(), insert: vi.fn(),
}));
vi.mock('@/lib/env', () => ({ features: state.features }));
vi.mock('@/features/auth/verified-account', () => ({ getVerifiedAccount: state.verified }));

import { submitTitleRequestAction } from '@/features/catalog/requests-actions';
import { REQUEST_INITIAL_STATE } from '@/features/catalog/request-state';
import { ACCOUNT_SERVICES_UNAVAILABLE } from '@/features/account/availability';
import { AUTH_EMAIL_UNVERIFIED } from '@/features/auth/state';

function form() {
  const value = new FormData();
  value.set('title_name', 'Requested title'); value.set('media_type', 'movie');
  value.set('year', '2024'); value.set('note', 'Original release');
  value.set('account_id', 'forged-other-account');
  return value;
}

beforeEach(() => {
  vi.resetAllMocks();
  state.features.supabaseConfigured = true;
  state.from.mockReturnValue({ insert: state.insert });
  state.insert.mockResolvedValue({ error: null });
  state.verified.mockResolvedValue({ status: 'authenticated', user: { id: 'verified-account' }, client: { from: state.from } });
});

describe('title request verified-account boundary', () => {
  it.each([
    ['unauthenticated', 'Sign in to request a title.'],
    ['unverified', AUTH_EMAIL_UNVERIFIED],
    ['unavailable', ACCOUNT_SERVICES_UNAVAILABLE],
  ])('does not insert for %s callers', async (status, message) => {
    state.verified.mockResolvedValue({ status });
    expect(await submitTitleRequestAction(REQUEST_INITIAL_STATE, form())).toEqual({ status: 'error', message });
    expect(state.from).not.toHaveBeenCalled();
  });

  it('uses only the verified user and user-scoped client for an acknowledged insert', async () => {
    expect(await submitTitleRequestAction(REQUEST_INITIAL_STATE, form())).toMatchObject({ status: 'ok' });
    expect(state.from).toHaveBeenCalledWith('title_requests');
    expect(state.insert).toHaveBeenCalledWith({ account_id: 'verified-account', title_name: 'Requested title', media_type: 'movie', year: 2024, note: 'Original release' });
  });

  it('does not attempt account access when service configuration is missing', async () => {
    state.features.supabaseConfigured = false;
    expect(await submitTitleRequestAction(REQUEST_INITIAL_STATE, form())).toEqual({ status: 'error', message: ACCOUNT_SERVICES_UNAVAILABLE });
    expect(state.verified).not.toHaveBeenCalled();
  });

  it('keeps authentication and database failures private and never acknowledges failure', async () => {
    state.verified.mockRejectedValueOnce(new Error('PRIVATE auth details'));
    const authFailure = await submitTitleRequestAction(REQUEST_INITIAL_STATE, form());
    expect(authFailure.status).toBe('error'); expect(JSON.stringify(authFailure)).not.toContain('PRIVATE');
    state.insert.mockResolvedValueOnce({ error: { message: 'PRIVATE database details' } });
    const dbFailure = await submitTitleRequestAction(REQUEST_INITIAL_STATE, form());
    expect(dbFailure.status).toBe('error'); expect(JSON.stringify(dbFailure)).not.toContain('PRIVATE');
  });

  it.each([['title_name', ''], ['media_type', 'invalid'], ['year', '2101']])('rejects invalid %s without backend work', async (name, value) => {
    const input = form(); input.set(name, value);
    expect(await submitTitleRequestAction(REQUEST_INITIAL_STATE, input)).toMatchObject({ status: 'error' });
    expect(state.verified).not.toHaveBeenCalled();
    expect(state.insert).not.toHaveBeenCalled();
  });
});
