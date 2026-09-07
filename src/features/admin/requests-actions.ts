'use server';

import { revalidatePath } from 'next/cache';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { requirePermission } from '@/lib/permissions/check';
import { PERMISSIONS } from '@/lib/permissions/permissions';
import { importTitlesForSearch } from '@/features/catalog/tmdb-sync';

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
 * Import runs the same TMDB search-to-import path the public search box uses,
 * capped at 1 title so the request resolves to exactly one match. TMDB being
 * unreachable (some networks block api.themoviedb.org) surfaces the same honest
 * "could not find" error and leaves the request pending for a later retry.
 *
 * Only async functions are exported from this 'use server' module.
 */

/** Uniform action result — honest, renderable errors for the admin UI. */
export interface TitleRequestActionResult {
  ok: boolean;
  error?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function revalidateRequestsPage(): void {
  revalidatePath('/admin/requests');
}

/**
 * Import a pending request: TMDB-search the requested name, and when a match is
 * found, mark the request 'imported'. No match (or TMDB unreachable) leaves it
 * pending so the editor can retry later.
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
    .select('*')
    .eq('id', requestId)
    .maybeSingle();
  if (readError || !row) {
    return { ok: false, error: readError ? `Could not read the request: ${readError.message}` : 'Request not found.' };
  }

  // Same TMDB search-to-import path the public search box uses, capped at one
  // title. Failures (network blocks, no match) leave the request pending.
  let imported: Awaited<ReturnType<typeof importTitlesForSearch>> = [];
  try {
    imported = await importTitlesForSearch(row.title_name, 1);
  } catch {
    // Fall through to the "could not find" error below.
  }
  if (imported.length === 0) {
    return { ok: false, error: 'Could not find that title on TMDB.' };
  }

  const { error: updateError } = await (db as any).from('title_requests')
    .update({ status: 'imported', updated_at: new Date().toISOString() })
    .eq('id', requestId);
  if (updateError) {
    return { ok: false, error: `Could not mark the request imported: ${updateError.message}` };
  }

  revalidateRequestsPage();
  return { ok: true };
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
  const { error } = await (db as any).from('title_requests')
    .update({ status: 'rejected', updated_at: new Date().toISOString() })
    .eq('id', requestId);
  if (error) {
    return { ok: false, error: `Could not reject the request: ${error.message}` };
  }

  revalidateRequestsPage();
  return { ok: true };
}
