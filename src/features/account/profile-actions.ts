'use server';

import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { getVerifiedAccount } from '@/features/auth/verified-account';
import { MATURITY_LEVELS } from './types';
import { ACTIVE_PROFILE_COOKIE, isProfileId } from './active-profile';

/**
 * Profile management actions (Spec Section 8: profiles, avatars, maturity).
 * All run as the signed-in viewer through the RLS-scoped client — profiles are
 * scoped to `account_id = auth.uid()`, so a signed-out caller gets a clean
 * error and can never touch another account's rows. Only async functions are
 * exported from this 'use server' module.
 */

export interface ProfileActionResult {
  ok: boolean;
  error?: string;
}

function validName(name: string): string | null {
  if (typeof name !== 'string') return 'Enter a profile name.';
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 30) {
    return 'Profile name must be 1–30 characters.';
  }
  return null;
}

/** Select an owned profile for this browser without granting any account permissions. */
export async function selectProfileAction(profileId: string): Promise<ProfileActionResult> {
  if (!isProfileId(profileId)) return { ok: false, error: 'Choose a valid profile.' };
  const account = await getVerifiedAccount();
  if (account.status !== 'authenticated') return { ok: false, error: 'Sign in with a verified account to choose a profile.' };
  try {
    const { data, error } = await account.client.from('profiles').select('id')
      .eq('id', profileId).eq('account_id', account.user.id).maybeSingle();
    if (error || !data) return { ok: false, error: 'Profile not found on your account.' };
    (await cookies()).set(ACTIVE_PROFILE_COOKIE, data.id, {
      httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: 60 * 60 * 24 * 30,
    });
    revalidatePath('/account', 'layout');
    revalidatePath('/watch', 'layout');
    revalidatePath('/');
    return { ok: true };
  } catch {
    return { ok: false, error: 'Could not switch profiles. Please try again.' };
  }
}

/** Create a profile on the signed-in account. */
export async function createProfileAction(input: {
  name: string;
  isKids: boolean;
  maturityCeiling: string;
}): Promise<ProfileActionResult> {
  if (!input || typeof input.isKids !== 'boolean') return { ok: false, error: 'Enter valid profile details.' };
  const nameError = validName(input.name);
  if (nameError) return { ok: false, error: nameError };
  // Ceiling is stored as the semantic level (see types.ts MATURITY_LEVELS);
  // kids profiles are always capped at 'kids'.
  const ceiling = input.isKids
    ? 'kids'
    : MATURITY_LEVELS.some((m) => m.value === input.maturityCeiling)
      ? input.maturityCeiling
      : 'adults';

  const account = await getVerifiedAccount();
  if (account.status !== 'authenticated') return { ok: false, error: 'Sign in with a verified account to manage profiles.' };
  const db = account.client;

  const { error } = await db.from('profiles').insert({
    account_id: account.user.id,
    name: input.name.trim(),
    is_kids: input.isKids,
    maturity_ceiling: input.isKids ? 'TV-PG' : ceiling,
  });
  if (error) return { ok: false, error: error.message };

  revalidatePath('/account/profiles');
  return { ok: true };
}

/** Rename a profile (ownership enforced by RLS). */
export async function renameProfileAction(profileId: string, name: string): Promise<ProfileActionResult> {
  if (!isProfileId(profileId)) return { ok: false, error: 'Choose a valid profile.' };
  const nameError = validName(name);
  if (nameError) return { ok: false, error: nameError };

  const account = await getVerifiedAccount();
  if (account.status !== 'authenticated') return { ok: false, error: 'Sign in with a verified account to manage profiles.' };
  const db = account.client;

  const { data, error } = await db.from('profiles').update({ name: name.trim() })
    .eq('id', profileId).eq('account_id', account.user.id).select('id').maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: 'Profile not found on your account.' };

  revalidatePath('/account/profiles');
  return { ok: true };
}

/**
 * Delete a profile. The last remaining profile cannot be deleted (the account
 * needs at least one — watchlist and history are keyed through it).
 */
export async function deleteProfileAction(profileId: string): Promise<ProfileActionResult> {
  if (!isProfileId(profileId)) return { ok: false, error: 'Choose a valid profile.' };
  const account = await getVerifiedAccount();
  if (account.status !== 'authenticated') return { ok: false, error: 'Sign in with a verified account to manage profiles.' };
  const db = account.client;

  const { data: profiles, error: readError } = await db.from('profiles').select('id')
    .eq('account_id', account.user.id).limit(2);
  if (readError) return { ok: false, error: 'Profiles are temporarily unavailable.' };
  if (!profiles || profiles.length <= 1) {
    return { ok: false, error: 'You need at least one profile.' };
  }

  const { data, error } = await db.from('profiles').delete().eq('id', profileId)
    .eq('account_id', account.user.id).select('id').maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: 'Profile not found on your account.' };

  const cookieStore = await cookies();
  if (cookieStore.get(ACTIVE_PROFILE_COOKIE)?.value === profileId) cookieStore.delete(ACTIVE_PROFILE_COOKIE);
  revalidatePath('/account', 'layout');
  revalidatePath('/account/profiles');
  return { ok: true };
}
