import 'server-only';

import { getSupabaseServerClient } from '@/lib/supabase/server';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { getDefaultProfileId } from '@/features/watchlist/queries';

/**
 * Ratings reads (Spec Sections 4, 7). The `ratings` table's RLS scopes rows to
 * the rating account, so:
 *   - The COMMUNITY aggregate (average + count over every viewer) is read with
 *     the service client — an aggregate is not sensitive and no public-read
 *     policy exists on `ratings`.
 *   - The SIGNED-IN viewer's own rating is read with the request-scoped client
 *     (RLS returns only their rows).
 * Failures degrade to an empty summary / null own-rating, never a page error.
 */

export interface RatingSummary {
  /** Average of all ratings, rounded to 1 decimal, or null when none yet. */
  average: number | null;
  count: number;
}

export async function getRatingSummary(titleId: string): Promise<RatingSummary> {
  try {
    const service = getSupabaseServiceClient();
    const { data, error } = await service.from('ratings').select('value').eq('title_id', titleId);
    if (error) throw error;
    const values = (data ?? []).map((r) => r.value as number);
    if (values.length === 0) return { average: null, count: 0 };
    const sum = values.reduce((a, b) => a + b, 0);
    return { average: Math.round((sum / values.length) * 10) / 10, count: values.length };
  } catch (err) {
    console.warn('ratings.getRatingSummary failed', {
      message: err instanceof Error ? err.message : String(err),
    });
    return { average: null, count: 0 };
  }
}

/** The signed-in viewer's own rating (1–10) for a title, or null. */
export async function getMyRating(titleId: string): Promise<number | null> {
  try {
    const db = await getSupabaseServerClient();
    const { data: user } = await db.auth.getUser();
    if (!user.user) return null;
    const profileId = await getDefaultProfileId();
    if (!profileId) return null;
    const { data, error } = await db
      .from('ratings')
      .select('value')
      .eq('profile_id', profileId)
      .eq('title_id', titleId)
      .maybeSingle();
    if (error) throw error;
    return data ? (data.value as number) : null;
  } catch (err) {
    console.warn('ratings.getMyRating failed', {
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
