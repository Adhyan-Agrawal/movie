import 'server-only';

import { getSupabaseServerClient } from '@/lib/supabase/server';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import type { SyncResult } from './tmdb-sync';

/**
 * Sync-run bookkeeping (Spec Section 10): every TMDB sync writes an `imports`
 * row (kind 'tmdb', totals) and an `audit_logs` row (action 'catalog.sync').
 *
 * Split clients by design:
 *   - `imports` allows `catalog.create` via RLS, so it is written with the
 *     RLS-scoped server client — the run stays attributable to the acting
 *     admin/editor.
 *   - `audit_logs` has NO client-insert policy by design (service-role only
 *     writer per the audit-trail contract), so that insert uses the
 *     service-role client.
 *
 * Recording must never break the sync itself: every failure here is logged and
 * swallowed.
 */

export interface SyncRunRecord {
  ok: boolean;
  /** Human-readable scope of the run, e.g. 'charts' or 'discover'. */
  source: string;
  /** Counts from a successful sync (omitted on failure). */
  result?: SyncResult;
  /** Error message from a failed sync (omitted on success). */
  error?: string;
}

/** Resolve the signed-in actor (the admin who clicked sync), if any. */
async function currentActorId(): Promise<string | null> {
  try {
    const db = await getSupabaseServerClient();
    const { data } = await db.auth.getUser();
    return data.user?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Insert the `imports` + `audit_logs` rows for one sync run. Best-effort:
 * failures are logged, never thrown — a bookkeeping miss must not turn a
 * successful (or already-failed) sync into an exception for the caller.
 */
export async function recordSyncRun(record: SyncRunRecord): Promise<void> {
  const actorId = await currentActorId();
  const counts = {
    movies: record.result?.movies ?? 0,
    series: record.result?.series ?? 0,
    seasons: record.result?.seasons ?? 0,
    episodes: record.result?.episodes ?? 0,
    people: record.result?.people ?? 0,
    genres: record.result?.genres ?? 0,
    failed: record.result?.failed ?? 0,
  };
  // processed/succeeded = titles that made it through normalization; failed =
  // titles the run discovered but could not import.
  const processed = counts.movies + counts.series;
  const failed = record.ok ? counts.failed : 1;

  try {
    const db = await getSupabaseServerClient();
    const { error: importErr } = await db.from('imports').insert({
      kind: 'tmdb',
      status: record.ok ? 'completed' : 'failed',
      source: `tmdb:${record.source}`,
      mapping: counts,
      dry_run: false,
      total: processed + failed,
      processed,
      succeeded: record.ok ? processed : 0,
      failed,
      error_report: record.ok ? [] : [{ message: record.error ?? 'Unknown sync error' }],
      created_by: actorId,
    });
    if (importErr) throw new Error(importErr.message);
  } catch (err) {
    console.warn('catalog.sync: failed to record imports row', {
      message: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    // Service client: audit_logs is service-role-write-only by design.
    const service = getSupabaseServiceClient();
    const { error: auditErr } = await service.from('audit_logs').insert({
      actor_account_id: actorId,
      action: 'catalog.sync',
      entity_type: 'title',
      outcome: record.ok ? 'success' : 'failure',
      reason: record.ok ? null : (record.error ?? 'Unknown sync error'),
      after: { source: record.source, ...counts },
    });
    if (auditErr) throw new Error(auditErr.message);
  } catch (err) {
    console.warn('catalog.sync: failed to record audit_logs row', {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
