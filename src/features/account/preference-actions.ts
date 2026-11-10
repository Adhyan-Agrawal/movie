'use server';

import { revalidatePath } from 'next/cache';
import { getVerifiedAccount } from '@/features/auth/verified-account';
import { getAccountPreferences } from './preference-queries';
import {
  ACCOUNT_PREFERENCE_METADATA_KEYS, accountPreferenceOwnerSchema, accountPreferencesPatchSchema,
  accountPreferencesSnapshot, PREFERENCE_ERRORS, type AccountPreferencesResult,
} from './preference-types';
import type { AccountSettings } from './types';

/** expectedAccountId fences a stale tab; it never selects or authorizes a user. */
export async function loadAccountPreferencesAction(expectedAccountId: string): Promise<AccountPreferencesResult> {
  if (!accountPreferenceOwnerSchema.safeParse(expectedAccountId).success) {
    return { ok: false, reason: 'invalid', message: PREFERENCE_ERRORS.invalid };
  }
  const result = await getAccountPreferences();
  if (result.ok && result.snapshot.accountId !== expectedAccountId) {
    return { ok: false, reason: 'account-changed', message: PREFERENCE_ERRORS['account-changed'] };
  }
  return result;
}

export async function saveAccountPreferencesAction(expectedAccountId: string, changes: unknown): Promise<AccountPreferencesResult> {
  const parsed = accountPreferencesPatchSchema.safeParse(changes);
  if (!accountPreferenceOwnerSchema.safeParse(expectedAccountId).success || !parsed.success) {
    return { ok: false, reason: 'invalid', message: PREFERENCE_ERRORS.invalid };
  }
  try {
    const account = await getVerifiedAccount();
    if (account.status !== 'authenticated') {
      return { ok: false, reason: account.status, message: PREFERENCE_ERRORS[account.status] };
    }
    if (account.user.id !== expectedAccountId) {
      return { ok: false, reason: 'account-changed', message: PREFERENCE_ERRORS['account-changed'] };
    }
    const data = Object.fromEntries(Object.entries(parsed.data).filter(([, value]) => value !== undefined)
      .map(([field, value]) => [ACCOUNT_PREFERENCE_METADATA_KEYS[field as keyof AccountSettings], value]));
    const result = await account.client.auth.updateUser({ data });
    const user = result.data.user;
    if (result.error || !user || user.id !== account.user.id
      || Object.entries(data).some(([key, value]) => !Object.hasOwn(user.user_metadata ?? {}, key) || user.user_metadata[key] !== value)) {
      return { ok: false, reason: 'unavailable', message: PREFERENCE_ERRORS.unavailable };
    }
    revalidatePath('/account/settings');
    return { ok: true, snapshot: accountPreferencesSnapshot(user.id, user.user_metadata) };
  } catch {
    return { ok: false, reason: 'unavailable', message: PREFERENCE_ERRORS.unavailable };
  }
}
