import 'server-only';

import { getSupabaseServerClient } from '@/lib/supabase/server';
import { getTitleCardsByIds, type TitleCard } from '@/features/catalog/card-queries';
import { getActiveProfileId, resolveActiveProfileId } from '@/features/account/active-profile';

/**
 * Watchlist reads (Spec Sections 4, 7, 8). The watchlist belongs to the
 * signed-in account's selected profile (v1: one named list per profile). All
 * reads run through the RLS-scoped server client, so an anonymous visitor
 * simply has no watchlist. Returns empty/null results on failure — never throws
 * into a page render.
 */

/** Resolve the selected profile, falling back to the account's default profile. */
export async function getDefaultProfileId(): Promise<string | null> {
  return getActiveProfileId();
}

async function selectedWatchlist(db: Awaited<ReturnType<typeof getSupabaseServerClient>>, accountId: string): Promise<string | null> {
  try {
    const profileId = await resolveActiveProfileId(db, accountId);
    if (!profileId) return null;
    const { data, error } = await db.from('watchlists').select('id')
      .eq('account_id', accountId).eq('profile_id', profileId).eq('name', 'My list').maybeSingle();
    return error ? null : data?.id ?? null;
  } catch {
    return null;
  }
}

/** True when the title is on the signed-in viewer's watchlist. */
export async function isInWatchlist(titleId: string): Promise<boolean> {
  const db = await getSupabaseServerClient();
  const { data: user } = await db.auth.getUser();
  if (!user.user) return false;
  const watchlistId = await selectedWatchlist(db, user.user.id);
  if (!watchlistId) return false;

  const { data, error } = await db
    .from('watchlist_items')
    .select('title_id')
    .limit(1)
    .eq('watchlist_id', watchlistId)
    .eq('title_id', titleId)
    .maybeSingle();
  if (error) {
    console.warn('watchlist.isInWatchlist failed', { message: error.message });
    return false;
  }
  return data !== null;
}

/** The signed-in viewer's watchlist titles, newest first (max 100). */
export async function listWatchlistTitles(): Promise<TitleCard[]> {
  const db = await getSupabaseServerClient();
  const { data: user } = await db.auth.getUser();
  if (!user.user) return [];
  const watchlistId = await selectedWatchlist(db, user.user.id);
  if (!watchlistId) return [];

  const { data: items, error } = await db
    .from('watchlist_items')
    .select('title_id')
    .eq('watchlist_id', watchlistId)
    .order('added_at', { ascending: false })
    .limit(100);
  if (error) {
    console.warn('watchlist.listWatchlistTitles failed', { message: error.message });
    return [];
  }

  const titles = await getTitleCardsByIds((items ?? []).map((item) => item.title_id));
  return (items ?? []).map((item) => titles.get(item.title_id)).filter((title): title is TitleCard => title !== undefined);
}
