'use server';

import { revalidatePath } from 'next/cache';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { requirePermission } from '@/lib/permissions/check';
import { PERMISSIONS } from '@/lib/permissions/permissions';
import { importTitleForRequest } from '@/features/catalog/tmdb-sync';
import type { AdminTitleRequestRow } from './types';

/**
 * Admin title-request queue actions (Spec Section 4): import a requested title
 * from TMDB, or reject it.
 *
 * Both actions assert `catalog.create` app-side BEFORE any data access (the
 * admin layout gate is the first layer, this is the second), then write through
 * the RLS-scoped server client — the `title_requests_admin_update` policy
 * (public.has_permission('catalog.create')) enforces the same boundary on the
 * DB side, and every write is attributable to the acting editor.
 *
 * Import requires one exact name/type/year match and a confirmed catalog write.
 * Unmatched, ambiguous, incomplete, or failed lookups leave the request pending.
 *
 * Only async functions are exported from this 'use server' module.
 */

/** Uniform action result — honest, renderable errors for the admin UI. */
export interface TitleRequestActionResult {
  ok: boolean;
  error?: string;
  /** The status committed, but its separate notification write was not confirmed. */
  requestUpdated?: true;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function revalidateRequestsPage(): void {
  revalidatePath('/admin/requests');
}

async function notifyRequestTransition(
  request: Pick<AdminTitleRequestRow, 'id' | 'account_id' | 'title_name'>,
  status: 'imported' | 'rejected',
): Promise<TitleRequestActionResult> {
  revalidateRequestsPage();
  revalidatePath('/request');
  try {
    if (typeof request.account_id !== 'string' || !UUID_RE.test(request.account_id)
      || typeof request.title_name !== 'string' || !request.title_name.trim()) throw new Error('Invalid notification recipient.');
    // Only the winner of a real pending->final transition reaches this insert.
    // Notifications have service-only INSERT; account reads/updates never use it.
    const { error } = await getSupabaseServiceClient().from('notifications').insert({
      account_id: request.account_id,
      profile_id: null,
      kind: status === 'imported' ? 'import' : 'moderation',
      title: status === 'imported' ? 'Your requested title was imported' : 'Your title request was reviewed',
      body: status === 'imported'
        ? `Your request for "${request.title_name.trim().slice(0, 200)}" was added to the catalog. Playback availability can vary.`
        : `Your request for "${request.title_name.trim().slice(0, 200)}" was not approved.`,
      data: { request_id: request.id, status },
    }).abortSignal(AbortSignal.timeout(10_000));
    if (error) throw new Error('Notification write not confirmed.');
    revalidatePath('/account/notifications');
    return { ok: true };
  } catch {
    // These two writes are not a transaction; never imply the status rolled back.
    return {
      ok: false, requestUpdated: true,
      error: `The request was ${status}, but its account notification could not be confirmed. The request status is saved. Refresh the queue to see it.`,
    };
  }
}

/**
 * Import a pending request without guessing an identity from TMDB search rank.
 * Only a confirmed import can change the unchanged pending request's status.
 */
export async function importRequestedTitleAction(requestId: string): Promise<TitleRequestActionResult> {
  try {
    await requirePermission(PERMISSIONS.CATALOG_CREATE);
  } catch {
    return { ok: false, error: 'You need the catalog.create permission to import titles.' };
  }

  if (!UUID_RE.test(requestId ?? '')) return { ok: false, error: 'Invalid request id.' };

  const db = await getSupabaseServerClient();

  // title_requests is not yet in the generated Supabase types — cast
  // pragmatically. The admin read policy (catalog.read) scopes what we see.
  const { data: row, error: readError } = await (db as any).from('title_requests')
    .select('id, account_id, title_name, media_type, year, status, updated_at')
    .eq('id', requestId)
    .maybeSingle();
  if (readError || !row) {
    return { ok: false, error: readError ? `Could not read the request: ${readError.message}` : 'Request not found.' };
  }

  if (row.status !== 'pending') {
    return { ok: false, error: 'Only pending requests can be imported.' };
  }

  let importedId: string | null;
  try {
    importedId = await importTitleForRequest(row.title_name, row.media_type, row.year);
  } catch {
    return { ok: false, error: 'Could not import the requested title. The request is unchanged; try again later.' };
  }
  if (!importedId) {
    return { ok: false, error: 'Could not confirm a single TMDB match for the requested title, type, and year. The request is unchanged.' };
  }

  const { data: updated, error: updateError } = await (db as any).from('title_requests')
    .update({ status: 'imported', updated_at: new Date().toISOString() })
    .eq('id', requestId)
    .eq('status', 'pending')
    .eq('updated_at', row.updated_at)
    .select('id, account_id, title_name')
    .maybeSingle();
  if (updateError) {
    return { ok: false, error: `Could not mark the request imported: ${updateError.message}` };
  }
  if (!updated) {
    return { ok: false, error: 'The request changed while importing. Reload the queue before trying again.' };
  }

  return notifyRequestTransition(updated, 'imported');
}

/** Reject a pending request without importing anything. */
export async function rejectRequestedTitleAction(requestId: string): Promise<TitleRequestActionResult> {
  try {
    await requirePermission(PERMISSIONS.CATALOG_CREATE);
  } catch {
    return { ok: false, error: 'You need the catalog.create permission to manage requests.' };
  }

  if (!UUID_RE.test(requestId ?? '')) return { ok: false, error: 'Invalid request id.' };

  const db = await getSupabaseServerClient();
  const { data: updated, error } = await (db as any).from('title_requests')
    .update({ status: 'rejected', updated_at: new Date().toISOString() })
    .eq('id', requestId)
    .eq('status', 'pending')
    .select('id, account_id, title_name')
    .maybeSingle();
  if (error) {
    return { ok: false, error: `Could not reject the request: ${error.message}` };
  }

  if (!updated) return { ok: false, error: 'Only pending requests can be rejected. The request is no longer pending or available.' };
  return notifyRequestTransition(updated, 'rejected');
}
