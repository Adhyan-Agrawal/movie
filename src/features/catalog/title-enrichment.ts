import 'server-only';

import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { enrichTitleFromTmdb } from './tmdb-sync';

/**
 * On-demand title completeness (Spec Section 4).
 *
 * The bulk sync's season-episode budget means a series can be imported with
 * seasons but no episode rows (e.g. Grey's Anatomy / Bones / Criminal Minds were
 * found with 0 episodes). When a viewer opens such a title, the title page and
 * watch page call {@link ensureTitleComplete} and it fetches the FULL episode
 * set for that one title from TMDB, so a viewer never hits an empty episode
 * list on a series that exists on TMDB.
 *
 * Guards:
 *   - Completeness gate: if the imported episode count already meets the
 *     seasons' expected total, nothing runs (converges naturally).
 *   - Cooldown marker: a completed run writes an `audit_logs` row
 *     (action 'catalog.enrich', after->title_id); re-visits within the window
 *     skip without re-fetching. audit_logs is service-write-only, so this works
 *     for anonymous viewers too (no RLS problem like `imports` would have).
 *
 * All writes go through the service client (any visitor may trigger, exactly
 * like the search-to-import path) and every failure here degrades to a no-op —
 * enrichment must never break the page render.
 */

/**
 * Re-fetch cooldowns: after a SUCCESSFUL run we skip re-fetching for an hour
 * (it converged; nothing to gain). After a FAILED run we only wait 10 minutes —
 * the viewer must never be stuck with an empty episode list for an hour because
 * of one transient TMDB error, but we also don't hammer TMDB on every single
 * view while it's unreachable.
 */
const SUCCESS_COOLDOWN_MS = 60 * 60 * 1000;
const FAILURE_COOLDOWN_MS = 10 * 60 * 1000;

/**
 * The most recent enrichment outcome for a title, or null when it's outside its
 * cooldown (so a re-run is due). Only success markers suppress re-fetching.
 */
async function recentEnrichmentStatus(
  service: ReturnType<typeof getSupabaseServiceClient>,
  titleId: string,
): Promise<'success' | 'failure' | null> {
  const { data } = await service
    .from('audit_logs')
    .select('outcome, created_at')
    .eq('action', 'catalog.enrich')
    .contains('after', { title_id: titleId })
    .order('created_at', { ascending: false })
    .limit(1);
  const last = data?.[0];
  if (!last) return null;
  const age = Date.now() - new Date(last.created_at).getTime();
  if (last.outcome === 'success') return age < SUCCESS_COOLDOWN_MS ? 'success' : null;
  return age < FAILURE_COOLDOWN_MS ? 'failure' : null;
}

export interface EnrichmentOutcome {
  /** Whether a TMDB fetch actually ran this call. */
  ran: boolean;
  /** Episodes imported by this run. */
  episodes: number;
  /** True when the series is now fully imported (no further runs needed). */
  complete: boolean;
  /** Skip reason when `ran` is false. */
  reason?: string;
}

async function countEpisodes(service: ReturnType<typeof getSupabaseServiceClient>, titleId: string): Promise<number> {
  const { count } = await service
    .from('episodes')
    .select('*', { count: 'exact', head: true })
    .eq('title_id', titleId);
  return count ?? 0;
}

/** Best-effort audit marker so repeated visits don't re-fetch. */
async function markEnriched(titleId: string, ok: boolean, episodes: number, reason?: string): Promise<void> {
  try {
    const service = getSupabaseServiceClient();
    await service.from('audit_logs').insert({
      action: 'catalog.enrich',
      entity_type: 'title',
      outcome: ok ? 'success' : 'failure',
      after: { title_id: titleId, episodes, reason: reason ?? null },
    });
  } catch (err) {
    console.warn('enrichment.marker failed', {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Make sure a title is fully imported before its page renders. Best-effort and
 * never throws: every branch returns an {@link EnrichmentOutcome} describing
 * what (if anything) happened, and failures degrade to "could not enrich".
 */
export async function ensureTitleComplete(titleId: string): Promise<EnrichmentOutcome> {
  try {
    const service = getSupabaseServiceClient();

    const { data: title } = await service
      .from('titles')
      .select('type, tmdb_id')
      .eq('id', titleId)
      .maybeSingle();
    if (!title || title.type !== 'tv' || title.tmdb_id == null) {
      return { ran: false, episodes: 0, complete: true, reason: 'nothing to enrich (movie/no tmdb id)' };
    }

    // Completeness gate: episodes already meet the seasons' expected total.
    const { data: seasons } = await service.from('seasons').select('episode_count').eq('title_id', titleId);
    const expected = (seasons ?? []).reduce((sum, s) => sum + (s.episode_count ?? 0), 0);
    const actual = await countEpisodes(service, titleId);
    if (expected > 0 && actual >= expected) {
      return { ran: false, episodes: 0, complete: true };
    }

    if (await recentEnrichmentStatus(service, titleId)) {
      return { ran: false, episodes: 0, complete: false, reason: 'recently enriched (cooldown)' };
    }

    const result = await enrichTitleFromTmdb(titleId);
    await markEnriched(titleId, result.ok, result.episodes, result.reason);

    const newTotal = actual + result.episodes;
    return {
      ran: true,
      episodes: result.episodes,
      complete: result.ok && expected > 0 && newTotal >= expected,
      reason: result.ok ? undefined : result.reason,
    };
  } catch (err) {
    console.warn('enrichment.ensureTitleComplete failed', {
      titleId,
      message: err instanceof Error ? err.message : String(err),
    });
    return { ran: false, episodes: 0, complete: false, reason: 'enrichment failed' };
  }
}
