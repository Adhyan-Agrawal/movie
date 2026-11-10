import 'server-only';

import { getVerifiedAccount } from '@/features/auth/verified-account';
import { getRenderAccount } from '@/features/auth/render-account';
import { accountPreferencesSnapshot, PREFERENCE_ERRORS, type AccountPreferencesResult } from './preference-types';

async function readPreferences(loadAccount: typeof getVerifiedAccount): Promise<AccountPreferencesResult> {
  try {
    const account = await loadAccount();
    if (account.status !== 'authenticated') {
      return { ok: false, reason: account.status, message: PREFERENCE_ERRORS[account.status] };
    }
    return { ok: true, snapshot: accountPreferencesSnapshot(account.user.id, account.user.user_metadata) };
  } catch {
    return { ok: false, reason: 'unavailable', message: PREFERENCE_ERRORS.unavailable };
  }
}

/** Actions retain fresh verification, including reads immediately after a save. */
export function getAccountPreferences(): Promise<AccountPreferencesResult> {
  return readPreferences(getVerifiedAccount);
}

/** RSC-only: share the current render's verified account with shell/layout readers. */
export function getRenderAccountPreferences(): Promise<AccountPreferencesResult> {
  return readPreferences(getRenderAccount);
}
