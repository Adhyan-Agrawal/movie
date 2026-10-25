'use server';

import { getSupabaseServerClient } from '@/lib/supabase/server';
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
  /** Optional consistency guard, NEVER an authorization source. */
  viewerKey?: string;
}

/**
 * Upsert the viewer's watch-progress row for a title/episode.
 *
 * The unique index over (profile, title, episode) is PARTIAL (it coalesces a
 * nullable episode_id), so `onConflict` cannot target it — we select the
 * existing row first, then update or insert.
 */
export async function reportProgressAction(input: ReportProgressInput): Promise<{ ok: boolean }> {
  const maxSeconds = 2_147_483_647; // PostgreSQL integer columns.
  if (!input || typeof input.titleId !== 'string' || !input.titleId.trim() ||
      (input.episodeId !== undefined && (typeof input.episodeId !== 'string' || !input.episodeId.trim())) ||
      typeof input.positionSeconds !== 'number' || !Number.isFinite(input.positionSeconds) ||
      input.positionSeconds < 0 || input.positionSeconds > maxSeconds ||
      (input.durationSeconds !== undefined && (typeof input.durationSeconds !== 'number' ||
        !Number.isFinite(input.durationSeconds) || input.durationSeconds < 0 || input.durationSeconds > maxSeconds))) {
    return { ok: false };
  }
  try {
    const db = await getSupabaseServerClient();
    const { data: user, error: authError } = await db.auth.getUser();
    if (authError || !user.user) return { ok: false };

    const { data: profiles, error: profileError } = await db.from('profiles').select('id')
      .eq('account_id', user.user.id).order('created_at', { ascending: true }).limit(1);
    const profileId = profiles?.[0]?.id;
    if (profileError || !profileId) return { ok: false };
    const viewerKey = `account:${user.user.id}:profile:${profileId}`;
    if (input.viewerKey !== undefined && input.viewerKey !== viewerKey) return { ok: false };

    if (input.episodeId) {
      const { data: episode, error } = await db.from('episodes').select('id')
        .eq('id', input.episodeId).eq('title_id', input.titleId).maybeSingle();
      if (error || !episode) return { ok: false };
    }

    const position = Math.round(input.positionSeconds);
    const duration = input.durationSeconds !== undefined ? Math.round(input.durationSeconds) : undefined;
    const progress = progressFraction(position, duration);
    const completed = progress >= COMPLETION_THRESHOLD;

    let existing = db.from('watch_progress').select('id').eq('account_id', user.user.id)
      .eq('profile_id', profileId).eq('title_id', input.titleId);
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
        .eq('id', row.id).eq('account_id', user.user.id).eq('profile_id', profileId);
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
  } catch (error) {
    console.warn('playback.reportProgress failed', {
      message: error instanceof Error ? error.message : String(error),
    });
    return { ok: false };
  }
}
