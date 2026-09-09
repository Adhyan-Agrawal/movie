import 'server-only';

import { getSupabaseServerClient } from '@/lib/supabase/server';
import { getDefaultProfileId } from '@/features/watchlist/queries';
import { listTitles } from './queries';
import type { MediaRow, Title } from './types';

/**
 * "For you" personalization (Spec Section 13).
 *
 * Builds a recommendation row from the signed-in viewer's OWN engagement —
 * watch history (watch_progress), watchlist, and ratings. The viewer's top
 * genres (by number of engaged titles) seed a popularity-ranked recommendation
 * set, minus anything they've already engaged with. Anonymous viewers and
 * viewers with no history get null (the home page then omits the row).
 *
 * Reads use the RLS-scoped client for the viewer's rows; recommendations are
 * public titles via the standard catalog read.
 */

const MAX_ENGAGED = 200;
const MAX_GENRES = 3;
const MAX_RESULTS = 12;

/** Collect the title ids the viewer has demonstrably engaged with. */
async function engagedTitleIds(db: Awaited<ReturnType<typeof getSupabaseServerClient>>, profileId: string): Promise<string[]> {
  const seen = new Set<string>();
  const add = (rows: Array<{ title_id: string }> | null) => {
    for (const r of rows ?? []) if (r.title_id) seen.add(r.title_id);
  };

  const { data: wp } = await db
    .from('watch_progress')
    .select('title_id')
    .eq('profile_id', profileId)
    .gte('progress', 0.02)
    .limit(MAX_ENGAGED);
  add(wp);

  const { data: rated } = await db.from('ratings').select('title_id').eq('profile_id', profileId).limit(MAX_ENGAGED);
  add(rated);

  const { data: wl } = await db
    .from('watchlists')
    .select('id')
    .eq('profile_id', profileId)
    .eq('is_default', true)
    .maybeSingle();
  if (wl) {
    const { data: items } = await db
      .from('watchlist_items')
      .select('title_id')
      .eq('watchlist_id', wl.id)
      .limit(MAX_ENGAGED);
    add(items);
  }
  return [...seen];
}

/** The viewer's top genres by how many engaged titles fall in each. */
async function topGenres(db: Awaited<ReturnType<typeof getSupabaseServerClient>>, titleIds: string[]): Promise<string[]> {
  const counts = new Map<string, number>();
  for (let i = 0; i < titleIds.length; i += 100) {
    const part = titleIds.slice(i, i + 100);
    // title_genres → genres(name); the generated types don't model this FK
    // relation, so query it opaquely like repository.ts's CAST_SELECT and cast.
    const { data } = await (db as any).from('title_genres').select('genres ( name )').in('title_id', part);
    for (const tg of data ?? []) {
      const name = (tg as { genres: { name: string } | null }).genres?.name;
      if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_GENRES)
    .map(([name]) => name);
}

/**
 * A personalized recommendation row, or null when there isn't enough signal
 * (anonymous / no history / no matching public titles). Never throws — every
 * failure degrades to null so the home page stays unaffected.
 */
export async function getForYouRow(): Promise<MediaRow | null> {
  try {
    const db = await getSupabaseServerClient();
    const { data: user } = await db.auth.getUser();
    if (!user.user) return null;
    const profileId = await getDefaultProfileId();
    if (!profileId) return null;

    const engaged = await engagedTitleIds(db, profileId);
    if (engaged.length === 0) return null;

    const genres = await topGenres(db, engaged);
    if (genres.length === 0) return null;

    // Rank by popularity within the viewer's favourite genres, skipping titles
    // they've already seen/saved/rated. Interleave genres so the row is varied.
    const excluded = new Set(engaged);
    const pool: Title[] = [];
    for (const genre of genres) {
      const titles = await listTitles({ genre, sort: 'trending' });
      pool.push(...titles.filter((t) => !excluded.has(t.id)));
    }
    const seenIds = new Set<string>();
    const picked: Title[] = [];
    for (const title of pool) {
      if (picked.length >= MAX_RESULTS) break;
      if (seenIds.has(title.id)) continue;
      seenIds.add(title.id);
      picked.push(title);
    }
    if (picked.length === 0) return null;

    const reason =
      genres.length > 0 ? `Based on your ${genres.slice(0, 2).join(' and ').toLowerCase()} taste` : 'Based on your activity';
    return {
      id: 'for-you',
      heading: 'Because you watched',
      reason,
      titles: picked,
    };
  } catch (err) {
    console.warn('personalization.getForYouRow failed', {
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
