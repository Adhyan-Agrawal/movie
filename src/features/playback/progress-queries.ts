import 'server-only';

import { getSupabaseServerClient } from '@/lib/supabase/server';
import { getDefaultProfileId } from '@/features/watchlist/queries';
import { getTitleById } from '@/features/catalog/queries';
import type { ContinueWatchingEntry, WatchProgress } from '@/features/catalog/types';
import { isResumable } from './progress';

/**
 * Watch-progress reads (Spec Sections 4, 8, 14) for the signed-in viewer.
 * All queries run under RLS; anonymous visitors get null/[] — never an error
 * into a page render.
 */

/** A saved resume point for one title/episode. */
export interface ResumePosition {
  positionSeconds: number;
  progress: number;
}

/**
 * The viewer's latest resume position for a title/episode, or null when there
 * is nothing worth resuming (not signed in, no row, barely started, or
 * finished — finished titles restart from the beginning by design).
 */
export async function getResumePosition(
  titleId: string,
  episodeId?: string,
): Promise<ResumePosition | null> {
  const db = await getSupabaseServerClient();
  const { data: user } = await db.auth.getUser();
  if (!user.user) return null;

  const profileId = await getDefaultProfileId();
  if (!profileId) return null;

  let query = db
    .from('watch_progress')
    .select('position_seconds, progress')
    .eq('profile_id', profileId)
    .eq('title_id', titleId);
  query = episodeId ? query.eq('episode_id', episodeId) : query.is('episode_id', null);

  const { data, error } = await query.order('updated_at', { ascending: false }).limit(1).maybeSingle();
  if (error) {
    console.warn('playback.getResumePosition failed', { message: error.message });
    return null;
  }
  if (!data || !isResumable(data.progress)) return null;
  return { positionSeconds: data.position_seconds, progress: data.progress };
}

/** True when the request carries a signed-in session. */
export async function isSignedIn(): Promise<boolean> {
  const db = await getSupabaseServerClient();
  const { data } = await db.auth.getUser();
  return data.user !== null;
}

/** Recent embed sessions considered for the continue-watching fallback. */
const SESSION_WINDOW_DAYS = 30;
/** Upper bound on session rows scanned while deduplicating titles. */
const SESSION_SCAN_LIMIT = 200;

/**
 * Continue-watching entries for the signed-in viewer (anonymous → []).
 *
 * Two honest sources, newest first:
 *  1. watch_progress rows (native player telemetry) — real position + bar.
 *  2. recent playback_sessions for titles with NO progress row — the viewer
 *     watched via an external server, which shares no position, so the entry
 *     carries `progress: undefined` and the row renders a "Continue" badge
 *     instead of a fabricated bar.
 */
export async function getContinueWatching(limit = 12): Promise<ContinueWatchingEntry[]> {
  const db = await getSupabaseServerClient();
  const { data: user } = await db.auth.getUser();
  if (!user.user) return [];

  const profileId = await getDefaultProfileId();
  const entries: ContinueWatchingEntry[] = [];
  const seen = new Set<string>();

  if (profileId) {
    const { data: rows, error } = await db
      .from('watch_progress')
      .select('title_id, progress, position_seconds, updated_at, episode_id')
      .eq('profile_id', profileId)
      .eq('completed', false)
      .gte('progress', 0.02)
      .order('updated_at', { ascending: false })
      .limit(limit);
    if (error) {
      console.warn('playback.getContinueWatching: watch_progress read failed', {
        message: error.message,
      });
    }
    const rowsList = rows ?? [];
    // Resolve episode context (season/episode numbers + name) for TV rows so
    // the row links to the exact episode the viewer left off on.
    const episodeIds = [
      ...new Set(rowsList.map((r) => r.episode_id).filter((e): e is string => Boolean(e))),
    ];
    const episodes = new Map<
      string,
      { episodeId: string; seasonNumber: number; episodeNumber: number; name: string }
    >();
    for (let i = 0; i < episodeIds.length; i += 100) {
      const part = episodeIds.slice(i, i + 100);
      const { data: epRows, error: epErr } = await db
        .from('episodes')
        .select('id, season_number, episode_number, name')
        .in('id', part);
      if (epErr) {
        console.warn('playback.getContinueWatching: episodes read failed', { message: epErr.message });
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

    for (const row of rowsList) {
      if (entries.length >= limit) break;
      if (seen.has(row.title_id)) continue;
      const title = await getTitleById(row.title_id);
      if (!title) continue;
      seen.add(row.title_id);
      const progress: WatchProgress = {
        titleId: row.title_id,
        progress: row.progress,
        positionSeconds: row.position_seconds,
        updatedAt: row.updated_at,
      };
      const episode = row.episode_id ? episodes.get(row.episode_id) : undefined;
      entries.push(episode ? { title, progress, episode } : { title, progress });
    }
  }

  if (entries.length < limit) {
    const since = new Date(Date.now() - SESSION_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const { data: sessions, error } = await db
      .from('playback_sessions')
      .select('title_id')
      // Scoped to THIS account (playback_sessions_admin_read would otherwise
      // expose every row to analytics.read holders — the account home must
      // never surface another user's sessions).
      .eq('account_id', user.user.id)
      .gte('started_at', since)
      .order('started_at', { ascending: false })
      .limit(SESSION_SCAN_LIMIT);
    if (error) {
      console.warn('playback.getContinueWatching: playback_sessions read failed', {
        message: error.message,
      });
    }
    for (const session of sessions ?? []) {
      if (entries.length >= limit) break;
      if (seen.has(session.title_id)) continue;
      const title = await getTitleById(session.title_id);
      if (!title) continue;
      seen.add(session.title_id);
      entries.push({ title });
    }
  }

  return entries;
}
