'use server';

import { getSupabaseServerClient } from '@/lib/supabase/server';
import { getDefaultProfileId } from '@/features/watchlist/queries';
import { COMPLETION_THRESHOLD, progressFraction } from './progress';

/**
 * Watch-progress recording (Spec Sections 4, 8, 14). The native player emits
 * REAL telemetry (timeupdate/pause/ended), so Lumora can store honest
 * positions — unlike embed playback, where no position may be fabricated.
 *
 * Runs as the signed-in viewer via the RLS-scoped client; anonymous viewers
 * get ok:false silently — nothing errors and nothing is recorded. Only async
 * functions are exported ('use server' contract).
 */

export interface ReportProgressInput {
  titleId: string;
  episodeId?: string;
  positionSeconds: number;
  durationSeconds?: number;
}

/**
 * Upsert the viewer's watch-progress row for a title/episode.
 *
 * The unique index over (profile, title, episode) is PARTIAL (it coalesces a
 * nullable episode_id), so `onConflict` cannot target it — we select the
 * existing row first, then update or insert.
 */
export async function reportProgressAction(input: ReportProgressInput): Promise<{ ok: boolean }> {
  const db = await getSupabaseServerClient();
  const { data: user } = await db.auth.getUser();
  if (!user.user) return { ok: false };

  const profileId = await getDefaultProfileId();
  if (!profileId) return { ok: false };

  const position = Math.max(0, Math.round(input.positionSeconds));
  const duration =
    input.durationSeconds !== undefined ? Math.max(0, Math.round(input.durationSeconds)) : undefined;
  const progress = progressFraction(position, duration);
  const completed = progress >= COMPLETION_THRESHOLD;

  let existing = db.from('watch_progress').select('id').eq('profile_id', profileId).eq('title_id', input.titleId);
  existing = input.episodeId
    ? existing.eq('episode_id', input.episodeId)
    : existing.is('episode_id', null);
  const { data: row, error: selectError } = await existing.maybeSingle();
  if (selectError) {
    console.warn('playback.reportProgress: select failed', { message: selectError.message });
    return { ok: false };
  }

  if (row) {
    const { error } = await db
      .from('watch_progress')
      .update({
        position_seconds: position,
        ...(duration !== undefined ? { duration_seconds: duration } : {}),
        progress,
        completed,
        updated_at: new Date().toISOString(),
      })
      .eq('id', row.id);
    if (error) {
      console.warn('playback.reportProgress: update failed', { message: error.message });
      return { ok: false };
    }
    return { ok: true };
  }

  const { error } = await db.from('watch_progress').insert({
    account_id: user.user.id,
    profile_id: profileId,
    title_id: input.titleId,
    ...(input.episodeId ? { episode_id: input.episodeId } : {}),
    position_seconds: position,
    ...(duration !== undefined ? { duration_seconds: duration } : {}),
    progress,
    completed,
  });
  if (error) {
    console.warn('playback.reportProgress: insert failed', { message: error.message });
    return { ok: false };
  }
  return { ok: true };
}
