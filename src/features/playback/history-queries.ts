import 'server-only';

import { getSupabaseServerClient } from '@/lib/supabase/server';
import { getTitleById } from '@/features/catalog/queries';
import type { WatchEpisodeContext } from '@/features/catalog/types';

/**
 * Watch history reads (Spec Sections 4, 8, 18). Rows come from the viewer's
 * own `playback_sessions` (RLS-scoped) — one per play, newest first. The
 * external embed exposes no position telemetry, so history shows honest
 * "watched on" dates rather than fabricated progress. TV sessions carry the
 * exact episode watched (when `episode_id` was recorded), resolved to its
 * season/episode numbers and name for the row's label and deep link.
 */

export interface HistoryEntry {
  sessionId: string;
  titleId: string;
  watchedAt: string;
  state: string;
  /** TV sessions point at the exact episode watched (resolved S/E + name). */
  episode?: WatchEpisodeContext;
}

export async function listWatchHistory(limit = 50): Promise<HistoryEntry[]> {
  const db = await getSupabaseServerClient();
  const { data: user } = await db.auth.getUser();
  if (!user.user) return [];

  const { data, error } = await db
    .from('playback_sessions')
    .select('id, title_id, started_at, state, episode_id')
    // Scoped to THIS account even though playback_sessions_admin_read lets
    // analytics.read holders see every row — the account pages must never show
    // another user's sessions (security audit finding).
    .eq('account_id', user.user.id)
    .order('started_at', { ascending: false })
    .limit(limit);
  if (error) {
    console.warn('history.listWatchHistory failed', { message: error.message });
    return [];
  }
  const rows = data ?? [];

  // Resolve episode context (season/episode numbers + name) for TV sessions —
  // same shape progress-queries builds for continue-watching, batched 100 ids
  // at a time. An episode_id whose row is gone (deleted -> set null on the
  // session) simply yields no episode context and the row falls back to the
  // title-only movie-style rendering.
  const episodeIds = [
    ...new Set(rows.map((r) => r.episode_id).filter((e): e is string => Boolean(e))),
  ];
  const episodes = new Map<string, WatchEpisodeContext>();
  for (let i = 0; i < episodeIds.length; i += 100) {
    const part = episodeIds.slice(i, i + 100);
    const { data: epRows, error: epErr } = await db
      .from('episodes')
      .select('id, season_number, episode_number, name')
      .in('id', part);
    if (epErr) {
      console.warn('history.listWatchHistory: episodes read failed', { message: epErr.message });
      continue;
    }
    for (const e of epRows ?? []) {
      if (e.season_number == null || e.episode_number == null) continue;
      episodes.set(e.id, {
        episodeId: e.id,
        seasonNumber: e.season_number,
        episodeNumber: e.episode_number,
        name: e.name,
      });
    }
  }

  return rows.map((r) => ({
    sessionId: r.id,
    titleId: r.title_id,
    watchedAt: r.started_at,
    state: r.state,
    ...(r.episode_id && episodes.has(r.episode_id)
      ? { episode: episodes.get(r.episode_id)! }
      : {}),
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
