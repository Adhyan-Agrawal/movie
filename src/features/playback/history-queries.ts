import 'server-only';

import { getSupabaseServerClient } from '@/lib/supabase/server';
import { getTitleById } from '@/features/catalog/queries';

/**
 * Watch history reads (Spec Sections 4, 8, 18). Rows come from the viewer's
 * own `playback_sessions` (RLS-scoped) — one per play, newest first. The
 * external embed exposes no position telemetry, so history shows honest
 * "watched on" dates rather than fabricated progress.
 */

export interface HistoryEntry {
  sessionId: string;
  titleId: string;
  watchedAt: string;
  state: string;
}

export async function listWatchHistory(limit = 50): Promise<HistoryEntry[]> {
  const db = await getSupabaseServerClient();
  const { data: user } = await db.auth.getUser();
  if (!user.user) return [];

  const { data, error } = await db
    .from('playback_sessions')
    .select('id, title_id, started_at, state')
    .order('started_at', { ascending: false })
    .limit(limit);
  if (error) {
    console.warn('history.listWatchHistory failed', { message: error.message });
    return [];
  }
  return (data ?? []).map((r) => ({
    sessionId: r.id,
    titleId: r.title_id,
    watchedAt: r.started_at,
    state: r.state,
  }));
}

/** History entries with their titles resolved (skips deleted titles). */
export async function listWatchHistoryWithTitles(
  limit = 50,
): Promise<Array<{ entry: HistoryEntry; title: Awaited<ReturnType<typeof getTitleById>> }>> {
  const entries = await listWatchHistory(limit);
  return (
    await Promise.all(
      entries.map(async (entry) => ({ entry, title: await getTitleById(entry.titleId) })),
    )
  ).filter((x) => x.title !== null);
}
