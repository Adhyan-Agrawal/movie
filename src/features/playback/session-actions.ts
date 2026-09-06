'use server';

import { getSupabaseServerClient } from '@/lib/supabase/server';
import { getDefaultProfileId } from '@/features/watchlist/queries';

/**
 * Playback session recording (Spec Sections 9, 14, 18). The external embed
 * exposes NO position telemetry (capabilities.telemetry === false), so Lumora
 * records its own session events honestly: start, heartbeat (viewer still
 * watching), and end — never a fabricated position or progress fraction.
 *
 * Runs as the signed-in viewer via the RLS-scoped client (playback_sessions
 * policies scope rows to the account). Anonymous viewers get ok:false — no
 * session is recorded and nothing errors.
 */

export interface PlaybackSessionResult {
  ok: boolean;
  sessionId?: string;
}

/** Record that playback started for a title (one row per play). */
export async function reportPlaybackStartAction(titleId: string): Promise<PlaybackSessionResult> {
  const db = await getSupabaseServerClient();
  const { data: user } = await db.auth.getUser();
  if (!user.user) return { ok: false };

  const profileId = await getDefaultProfileId();
  const { data, error } = await db
    .from('playback_sessions')
    .insert({
      account_id: user.user.id,
      ...(profileId ? { profile_id: profileId } : {}),
      title_id: titleId,
      state: 'playing',
    })
    .select('id')
    .single();
  if (error) {
    console.warn('playback.start failed', { message: error.message });
    return { ok: false };
  }
  return { ok: true, sessionId: data.id };
}

/** Heartbeat: the viewer is still on the player (no position implied). */
export async function reportPlaybackHeartbeatAction(sessionId: string): Promise<{ ok: boolean }> {
  const db = await getSupabaseServerClient();
  const { error } = await db
    .from('playback_sessions')
    .update({ last_heartbeat_at: new Date().toISOString() })
    .eq('id', sessionId);
  return { ok: !error };
}

/** Record that the viewer left the player. */
export async function reportPlaybackEndAction(sessionId: string): Promise<{ ok: boolean }> {
  const db = await getSupabaseServerClient();
  const { error } = await db
    .from('playback_sessions')
    .update({ state: 'ended', ended_at: new Date().toISOString() })
    .eq('id', sessionId);
  return { ok: !error };
}
