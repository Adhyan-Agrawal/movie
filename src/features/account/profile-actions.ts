'use server';

import { revalidatePath } from 'next/cache';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { listAccountProfiles } from './queries';
import { MATURITY_LEVELS } from './types';

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
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 30) {
    return 'Profile name must be 1–30 characters.';
  }
  return null;
}

/** Create a profile on the signed-in account. */
export async function createProfileAction(input: {
  name: string;
  isKids: boolean;
  maturityCeiling: string;
}): Promise<ProfileActionResult> {
  const nameError = validName(input.name);
  if (nameError) return { ok: false, error: nameError };
  // Ceiling is stored as the semantic level (see types.ts MATURITY_LEVELS);
  // kids profiles are always capped at 'kids'.
  const ceiling = input.isKids
    ? 'kids'
    : MATURITY_LEVELS.some((m) => m.value === input.maturityCeiling)
      ? input.maturityCeiling
      : 'adults';

  const db = await getSupabaseServerClient();
  const { data: user } = await db.auth.getUser();
  if (!user.user) return { ok: false, error: 'Sign in to manage profiles.' };

  const { error } = await db.from('profiles').insert({
    account_id: user.user.id,
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
  const nameError = validName(name);
  if (nameError) return { ok: false, error: nameError };

  const db = await getSupabaseServerClient();
  const { data: user } = await db.auth.getUser();
  if (!user.user) return { ok: false, error: 'Sign in to manage profiles.' };

  const { error } = await db.from('profiles').update({ name: name.trim() }).eq('id', profileId);
  if (error) return { ok: false, error: error.message };

  revalidatePath('/account/profiles');
  return { ok: true };
}

/**
 * Delete a profile. The last remaining profile cannot be deleted (the account
 * needs at least one — watchlist and history are keyed through it).
 */
export async function deleteProfileAction(profileId: string): Promise<ProfileActionResult> {
  const db = await getSupabaseServerClient();
  const { data: user } = await db.auth.getUser();
  if (!user.user) return { ok: false, error: 'Sign in to manage profiles.' };

  const profiles = await listAccountProfiles();
  if (profiles.length <= 1) {
    return { ok: false, error: 'You need at least one profile.' };
  }
  const target = profiles.find((p) => p.id === profileId);
  if (!target) return { ok: false, error: 'Profile not found on your account.' };

  const { error } = await db.from('profiles').delete().eq('id', profileId);
  if (error) return { ok: false, error: error.message };

  revalidatePath('/account/profiles');
  return { ok: true };
}
