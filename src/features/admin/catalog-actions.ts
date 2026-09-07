'use server';

import { revalidatePath } from 'next/cache';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { requirePermission } from '@/lib/permissions/check';
import { PERMISSIONS } from '@/lib/permissions/permissions';

/**
 * Admin catalog lifecycle actions (Spec Sections 7, 10): publish, archive, and
 * hard-delete a single title.
 *
 * Every action asserts its catalog permission app-side BEFORE any write
 * (matching the boundaries migration 0004 split apart), then runs through the
 * RLS-scoped server client — the signed-in admin's session — so those policies
 * stay the second line of defense. Nothing here uses the service client: every
 * write is attributable to the acting admin.
 *
 * Permission boundaries (0004):
 *  - publish changes `status` to/from 'published', which the
 *    `enforce_catalog_publish` trigger requires `catalog.publish` for.
 *  - plain create/edit (archive included) requires `catalog.create`.
 *  - hard delete requires `catalog.delete`.
 *
 * All child rows (seasons, episodes, media_sources, title_genres, …) reference
 * `titles` with `on delete cascade`, so a hard delete is safe.
 *
 * Only async functions are exported from this 'use server' module.
 */

/** Uniform action result — honest, renderable errors for the admin UI. */
export interface CatalogActionResult {
  ok: boolean;
  error?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function revalidateTitlesPage(): void {
  revalidatePath('/admin/catalog/titles');
}

/** Publish a title: `status='published'`, `visibility='public'`, stamp `published_at`. */
export async function publishTitleAction(titleId: string): Promise<CatalogActionResult> {
  try {
    await requirePermission(PERMISSIONS.CATALOG_PUBLISH);
  } catch {
    return { ok: false, error: 'You need the catalog.publish permission to publish titles.' };
  }

  if (!UUID_RE.test(titleId ?? '')) return { ok: false, error: 'Invalid title id.' };

  const db = await getSupabaseServerClient();
  const { error } = await db
    .from('titles')
    .update({
      status: 'published',
      visibility: 'public',
      published_at: new Date().toISOString(),
    })
    .eq('id', titleId);
  if (error) {
    return { ok: false, error: `Could not publish the title: ${error.message}` };
  }

  revalidateTitlesPage();
  return { ok: true };
}

/**
 * Archive a title: `status='archived'` — the `title_status` enum value for a
 * pulled-from-publication title (drafts, scheduled, and published alike).
 */
export async function archiveTitleAction(titleId: string): Promise<CatalogActionResult> {
  try {
    await requirePermission(PERMISSIONS.CATALOG_CREATE);
  } catch {
    return { ok: false, error: 'You need the catalog.create permission to edit titles.' };
  }

  if (!UUID_RE.test(titleId ?? '')) return { ok: false, error: 'Invalid title id.' };

  const db = await getSupabaseServerClient();
  const { error } = await db.from('titles').update({ status: 'archived' }).eq('id', titleId);
  if (error) {
    return { ok: false, error: `Could not archive the title: ${error.message}` };
  }

  revalidateTitlesPage();
  return { ok: true };
}

/** Hard-delete a title row; child rows cascade via their FKs. */
export async function deleteTitleAction(titleId: string): Promise<CatalogActionResult> {
  try {
    await requirePermission(PERMISSIONS.CATALOG_DELETE);
  } catch {
    return { ok: false, error: 'You need the catalog.delete permission to delete titles.' };
  }

  if (!UUID_RE.test(titleId ?? '')) return { ok: false, error: 'Invalid title id.' };

  const db = await getSupabaseServerClient();
  const { error } = await db.from('titles').delete().eq('id', titleId);
  if (error) {
    return { ok: false, error: `Could not delete the title: ${error.message}` };
  }

  revalidateTitlesPage();
  return { ok: true };
}
