'use server';

import { getSupabaseServerClient } from '@/lib/supabase/server';

/**
 * Playback issue reporting (Spec Sections 9, 14).
 *
 * The player's "Report playback issue" control files a `playback_reports` row so
 * an operator can see which servers actually fail for viewers. Only SAFE
 * diagnostics are stored — never the iframe URL, query string, token, or real
 * provider identity: just the public "Server N" label, the player state, and
 * optional free text. RLS: any viewer may insert (anonymous is fine — the
 * account is nullable); only admins read. Only async functions are exported.
 */

export interface PlaybackReportInput {
  titleId: string;
  episodeId?: string;
  /** Public label only, e.g. "Server 3" — never the upstream provider name. */
  serverLabel?: string;
  playerState?: string;
  /** Optional free text (trimmed, length-capped). */
  message?: string;
}

export async function reportPlaybackIssueAction(input: PlaybackReportInput): Promise<{ ok: boolean }> {
  try {
    const db = await getSupabaseServerClient();
    const { data: user } = await db.auth.getUser();

    const message = input.message?.trim().slice(0, 2000);
    // Table added in migration 0008 — not in the generated types yet, cast.
    const { error } = await (db as any).from('playback_reports').insert({
      ...(user.user ? { account_id: user.user.id } : {}),
      title_id: input.titleId,
      ...(input.episodeId ? { episode_id: input.episodeId } : {}),
      ...(input.serverLabel?.trim() ? { server_label: input.serverLabel.trim().slice(0, 40) } : {}),
      ...(input.playerState?.trim() ? { player_state: input.playerState.trim().slice(0, 40) } : {}),
      ...(message ? { message } : {}),
    });
    if (error) throw error;
    return { ok: true };
  } catch (err) {
    console.warn('playback.report failed', {
      message: err instanceof Error ? err.message : String(err),
    });
    return { ok: false };
  }
}
