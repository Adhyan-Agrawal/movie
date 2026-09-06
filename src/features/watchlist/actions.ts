'use server';

import { getSupabaseServerClient } from '@/lib/supabase/server';
import { getDefaultProfileId } from './queries';

/**
 * Watchlist mutations (Spec Sections 4, 7, 8). All runs as the signed-in
 * viewer through the RLS-scoped client — anonymous callers get a signed-out
 * result the UI turns into a sign-in prompt, never an error. Only async
 * functions are exported from this 'use server' module.
 */

export interface WatchlistToggleResult {
  ok: boolean;
  /** Resulting membership (only meaningful when ok). */
  inWatchlist: boolean;
  /** False when there is no session — the UI should prompt sign-in. */
  signedIn: boolean;
  error?: string;
}

/**
 * Add/remove a title from the signed-in viewer's watchlist. Creates the
 * default watchlist row on first use. Idempotent per direction.
 */
export async function toggleWatchlistAction(
  titleId: string,
  currentlyInList: boolean,
): Promise<WatchlistToggleResult> {
  const db = await getSupabaseServerClient();
  const { data: user } = await db.auth.getUser();
  if (!user.user) {
    return { ok: false, inWatchlist: currentlyInList, signedIn: false };
  }

  const profileId = await getDefaultProfileId();
  if (!profileId) {
    return {
      ok: false,
      inWatchlist: currentlyInList,
      signedIn: true,
      error: 'No profile found for your account yet.',
    };
  }

  // Ensure the profile's default list exists — idempotent (one per name).
  const { error: ensureErr } = await db
    .from('watchlists')
    .upsert(
      { profile_id: profileId, account_id: user.user.id, name: 'My list', is_default: true },
      { onConflict: 'profile_id,name' },
    );
  if (ensureErr) {
    return { ok: false, inWatchlist: currentlyInList, signedIn: true, error: ensureErr.message };
  }

  const { data: list, error: listErr } = await db
    .from('watchlists')
    .select('id')
    .eq('profile_id', profileId)
    .maybeSingle();
  if (listErr || !list) {
    return {
      ok: false,
      inWatchlist: currentlyInList,
      signedIn: true,
      error: listErr?.message ?? 'Watchlist not found.',
    };
  }

  if (currentlyInList) {
    const { error: delErr } = await db
      .from('watchlist_items')
      .delete()
      .eq('watchlist_id', list.id)
      .eq('title_id', titleId);
    if (delErr) {
      return { ok: false, inWatchlist: true, signedIn: true, error: delErr.message };
    }
    return { ok: true, inWatchlist: false, signedIn: true };
  }

  const { error: addErr } = await db
    .from('watchlist_items')
    .upsert({ watchlist_id: list.id, title_id: titleId }, { onConflict: 'watchlist_id,title_id' });
  if (addErr) {
    return { ok: false, inWatchlist: false, signedIn: true, error: addErr.message };
  }
  return { ok: true, inWatchlist: true, signedIn: true };
}
