import 'server-only';

import { getSupabaseServerClient } from '@/lib/supabase/server';
import type { Title } from '@/features/catalog/types';
import { getTitleById } from '@/features/catalog/queries';

/**
 * Watchlist reads (Spec Sections 4, 7, 8). The watchlist belongs to the
 * signed-in account's default profile (v1: one named list per profile). All
 * reads run through the RLS-scoped server client, so an anonymous visitor
 * simply has no watchlist. Returns empty/null results on failure — never throws
 * into a page render.
 */

/** Resolve the signed-in account's default profile id, or null when signed out. */
export async function getDefaultProfileId(): Promise<string | null> {
  const db = await getSupabaseServerClient();
  const { data: user } = await db.auth.getUser();
  if (!user.user) return null;

  const { data: profiles, error } = await db
    .from('profiles')
    .select('id')
    .eq('account_id', user.user.id)
    .order('created_at', { ascending: true })
    .limit(1);
  if (error || !profiles || profiles.length === 0) return null;
  return profiles[0]!.id;
}

/** True when the title is on the signed-in viewer's watchlist. */
export async function isInWatchlist(titleId: string): Promise<boolean> {
  const db = await getSupabaseServerClient();
  const { data: user } = await db.auth.getUser();
  if (!user.user) return false;

  const { data, error } = await db
    .from('watchlist_items')
    .select('title_id')
    .limit(1)
    .eq('title_id', titleId)
    // RLS scopes rows to this account's list; a returned row = membership.
    .maybeSingle();
  if (error) {
    console.warn('watchlist.isInWatchlist failed', { message: error.message });
    return false;
  }
  return data !== null;
}

/** The signed-in viewer's watchlist titles, newest first (max 100). */
export async function listWatchlistTitles(): Promise<Title[]> {
  const db = await getSupabaseServerClient();
  const { data: user } = await db.auth.getUser();
  if (!user.user) return [];

  const { data: items, error } = await db
    .from('watchlist_items')
    .select('title_id, added_at')
    .order('added_at', { ascending: false })
    .limit(100);
  if (error) {
    console.warn('watchlist.listWatchlistTitles failed', { message: error.message });
    return [];
  }

  const titles = await Promise.all((items ?? []).map((i) => getTitleById(i.title_id)));
  return titles.filter((t): t is Title => t !== null);
}
