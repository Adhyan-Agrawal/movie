'use server';

import { getSupabaseServerClient } from '@/lib/supabase/server';
import { getDefaultProfileId } from '@/features/watchlist/queries';
import { features } from '@/lib/env';
import { ACCOUNT_SERVICES_UNAVAILABLE, isStoredCatalogId } from '@/features/account/availability';

/**
 * Ratings writes (Spec Sections 4, 7). The `ratings` table scopes rows to the
 * rating account via RLS (`ratings_self_all`), and its `unique(profile_id,
 * title_id)` constraint is a plain unique index — a valid `onConflict` target —
 * so one upsert handles both first-rating and change-rating. Only async
 * functions are exported ('use server' contract).
 */

export interface RatingActionResult {
  ok: boolean;
  message?: string;
}

/** Set (or change) the signed-in viewer's rating for a title (1–10). */
export async function setRatingAction(titleId: string, value: number): Promise<RatingActionResult> {
  if (!features.supabaseConfigured) return { ok: false, message: ACCOUNT_SERVICES_UNAVAILABLE };
  if (!isStoredCatalogId(titleId)) return { ok: false, message: 'Rating this public title is unavailable.' };
  const v = Math.round(value);
  if (!Number.isInteger(v) || v < 1 || v > 10) {
    return { ok: false, message: 'Rating must be a whole number from 1 to 10.' };
  }

  try {
  const db = await getSupabaseServerClient();
  const { data: user } = await db.auth.getUser();
  if (!user.user) return { ok: false, message: 'Sign in to rate titles.' };
  const profileId = await getDefaultProfileId();
  if (!profileId) return { ok: false, message: 'Create a profile before rating titles.' };

  const { error } = await db.from('ratings').upsert(
    { profile_id: profileId, account_id: user.user.id, title_id: titleId, value: v },
    { onConflict: 'profile_id,title_id' },
  );
  if (error) {
    return { ok: false, message: 'Could not save your rating. Please try again.' };
  }
  return { ok: true };
  } catch { return { ok: false, message: ACCOUNT_SERVICES_UNAVAILABLE }; }
}

/** Remove the signed-in viewer's rating for a title. */
export async function removeRatingAction(titleId: string): Promise<RatingActionResult> {
  if (!features.supabaseConfigured) return { ok: false, message: ACCOUNT_SERVICES_UNAVAILABLE };
  if (!isStoredCatalogId(titleId)) return { ok: false, message: 'Rating this public title is unavailable.' };
  try {
  const db = await getSupabaseServerClient();
  const { data: user } = await db.auth.getUser();
  if (!user.user) return { ok: false };
  const profileId = await getDefaultProfileId();
  if (!profileId) return { ok: false };

  const { error } = await db.from('ratings').delete().eq('profile_id', profileId).eq('title_id', titleId);
  if (error) {
    return { ok: false, message: 'Could not remove your rating. Please try again.' };
  }
  return { ok: true };
  } catch { return { ok: false, message: ACCOUNT_SERVICES_UNAVAILABLE }; }
}
