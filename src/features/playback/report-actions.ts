'use server';

import { getSupabaseServerClient } from '@/lib/supabase/server';
import { features } from '@/lib/env';
import { isStoredCatalogId } from '@/features/account/availability';

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
  if (!features.supabaseConfigured || !isStoredCatalogId(input.titleId)
    || (input.episodeId && !isStoredCatalogId(input.episodeId))) return { ok: false };
  try {
    const db = await getSupabaseServerClient();
    const { data: user } = await db.auth.getUser();

    const message = input.message?.trim().replace(/https?:\/\/\S+/g, '[redacted URL]').slice(0, 2000);
    const serverLabel = /^(?:Direct|Server \d{1,3})$/.test(input.serverLabel?.trim() ?? '') ? input.serverLabel!.trim() : undefined;
    // Table added in migration 0008 — not in the generated types yet, cast.
    const { error } = await (db as any).from('playback_reports').insert({
      ...(user.user ? { account_id: user.user.id } : {}),
      title_id: input.titleId,
      ...(input.episodeId ? { episode_id: input.episodeId } : {}),
      ...(serverLabel ? { server_label: serverLabel } : {}),
      ...(input.playerState?.trim() ? { player_state: input.playerState.trim().slice(0, 40) } : {}),
      ...(message ? { message } : {}),
    });
    if (error) throw error;
    return { ok: true };
  } catch {
    return { ok: false };
  }
}
