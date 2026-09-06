'use server';

import { revalidatePath } from 'next/cache';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import type { MediaSourceKindEnum } from '@/lib/supabase/types';
import { requirePermission } from '@/lib/permissions/check';
import { PERMISSIONS } from '@/lib/permissions/permissions';
import { MEDIA_SOURCE_KINDS, isPrivateOrLoopbackHost } from '@/lib/validation/source';
import { inferRemoteSourceKind, inferSourceKind, sanitizeUploadFilename } from './source-utils';

/**
 * Admin media-source actions (Spec Sections 7, 9, 11): upload tickets into the
 * PRIVATE `media` storage bucket plus remote-source CRUD on `media_sources`.
 *
 * Every action first asserts `provider.manage` (matching the
 * `media_sources_manage` RLS policy) and returns a clean `{ ok: false, error }`
 * on denial — never a thrown error the client can't render.
 *
 * WHY THE SERVICE CLIENT: storage writes to the private `media` bucket are only
 * possible with the service role (migration 0006 deliberately created no public
 * storage policies), so the upload/delete paths NEED it. For consistency the
 * `media_sources` writes here also use the service client; permission is still
 * enforced app-side by `requirePermission` before any write, and the rows
 * written are exactly the ones the caller validated. Only async functions are
 * exported from this 'use server' module; pure helpers live in
 * `./source-utils` (unit-tested).
 */

/** Uniform action result — honest, renderable errors for the admin UI. */
export interface SourceActionResult {
  ok: boolean;
  error?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A storage path the upload flow is allowed to touch: media/{titleId}/{episodeId|'title'}/{name}. */
const MEDIA_PATH_RE = /^media\/[0-9a-f-]{36}\/(?:title|[0-9a-f-]{36})\/[A-Za-z0-9._-]+$/;

const PERMISSION_ERROR = 'You need the provider.manage permission to manage media sources.';

/** Permission gate: every exported action calls this first. */
async function ensurePermission(): Promise<string | null> {
  try {
    await requirePermission(PERMISSIONS.PROVIDER_MANAGE);
    return null;
  } catch {
    return PERMISSION_ERROR;
  }
}

function revalidateSourcesPage(): void {
  revalidatePath('/admin/sources');
}

// ---------------------------------------------------------------------------
// Upload flow (step 1 of 2): ticket + signed UPLOAD url
// ---------------------------------------------------------------------------

/**
 * Step 1 of the upload flow. Sanitizes the filename, builds a per-title object
 * path (`media/{titleId}/{episodeId|'title'}/{timestamp}-{name}`), and returns
 * a time-limited signed UPLOAD URL the browser PUTs the file bytes to
 * directly. The service key never leaves the server; the signed URL alone is
 * handed to the client.
 */
export async function createUploadTicketAction(input: {
  titleId: string;
  episodeId?: string;
  filename: string;
  contentType?: string;
}): Promise<{ ok: boolean; path?: string; uploadUrl?: string; error?: string }> {
  const denied = await ensurePermission();
  if (denied) return { ok: false, error: denied };

  const titleId = input.titleId?.trim() ?? '';
  if (!UUID_RE.test(titleId)) return { ok: false, error: 'A valid title is required.' };
  if (input.episodeId !== undefined && input.episodeId !== '' && !UUID_RE.test(input.episodeId)) {
    return { ok: false, error: 'Invalid episode selected.' };
  }

  const safeName = sanitizeUploadFilename(input.filename ?? '');
  if (!safeName) return { ok: false, error: 'The filename has no usable characters — rename the file (letters, digits, dots, dashes).' };

  const slot = input.episodeId ? input.episodeId : 'title';
  const path = `media/${titleId}/${slot}/${Date.now()}-${safeName}`;

  const service = getSupabaseServiceClient();
  const { data, error } = await service.storage.from('media').createSignedUploadUrl(path);
  if (error || !data?.signedUrl) {
    return { ok: false, error: `Could not create the upload ticket: ${error?.message ?? 'unknown storage error'}` };
  }

  return { ok: true, path, uploadUrl: data.signedUrl };
}

// ---------------------------------------------------------------------------
// Upload flow (step 2 of 2): verify the object exists, then insert the row
// ---------------------------------------------------------------------------

/**
 * Step 2 of the upload flow. Verifies the uploaded object actually EXISTS in
 * the private bucket (listing the folder — an operator could skip step 1's PUT,
 * or the PUT could have failed mid-flight) before inserting the `media_sources`
 * row with `reference = path`. The kind is inferred from the file extension
 * (see `inferSourceKind`).
 */
export async function confirmUploadedSourceAction(input: {
  titleId: string;
  episodeId?: string;
  path: string;
  label?: string;
  language?: string;
  quality?: string;
}): Promise<SourceActionResult> {
  const denied = await ensurePermission();
  if (denied) return { ok: false, error: denied };

  const titleId = input.titleId?.trim() ?? '';
  if (!UUID_RE.test(titleId)) return { ok: false, error: 'A valid title is required.' };
  const path = input.path?.trim() ?? '';
  if (!MEDIA_PATH_RE.test(path)) {
    return { ok: false, error: 'Invalid storage path.' };
  }
  if (!path.startsWith(`media/${titleId}/`)) {
    return { ok: false, error: 'The storage path does not belong to this title.' };
  }

  const folder = path.slice(0, path.lastIndexOf('/'));
  const filename = path.slice(path.lastIndexOf('/') + 1);

  const service = getSupabaseServiceClient();
  const { data: objects, error: listError } = await service.storage.from('media').list(folder);
  if (listError) {
    return { ok: false, error: `Could not verify the upload: ${listError.message}` };
  }
  const uploaded = (objects ?? []).some((obj) => obj.name === filename);
  if (!uploaded) {
    return { ok: false, error: 'No uploaded file found at that path — the upload may have failed. Try again.' };
  }

  const episodeId = input.episodeId?.trim() || undefined;
  const { error: insertError } = await service.from('media_sources').insert({
    title_id: titleId,
    episode_id: episodeId ?? null,
    kind: inferSourceKind(filename),
    reference: path,
    label: (input.label ?? '').trim().slice(0, 120),
    language: (input.language ?? 'en').trim().slice(0, 10) || 'en',
    quality: (input.quality ?? 'auto').trim().slice(0, 20) || 'auto',
  });
  if (insertError) return { ok: false, error: `Could not save the source: ${insertError.message}` };

  revalidateSourcesPage();
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Remote sources
// ---------------------------------------------------------------------------

/**
 * Adds a remote stream URL (licensed HLS/DASH manifests, direct MP4s, embeds).
 * The URL is SSRF-screened: https only, no embedded credentials, no
 * localhost/private/link-local hosts (reusing the host checks from
 * `@/lib/validation/source`). The kind is taken from the form when given,
 * otherwise inferred from the URL's path extension, defaulting to 'hls'.
 */
export async function addRemoteSourceAction(input: {
  titleId: string;
  episodeId?: string;
  url: string;
  kind?: string;
  label?: string;
  language?: string;
  quality?: string;
}): Promise<SourceActionResult> {
  const denied = await ensurePermission();
  if (denied) return { ok: false, error: denied };

  const titleId = input.titleId?.trim() ?? '';
  if (!UUID_RE.test(titleId)) return { ok: false, error: 'A valid title is required.' };
  if (input.episodeId !== undefined && input.episodeId !== '' && !UUID_RE.test(input.episodeId)) {
    return { ok: false, error: 'Invalid episode selected.' };
  }

  const rawUrl = (input.url ?? '').trim();
  if (!rawUrl) return { ok: false, error: 'A stream URL is required.' };
  if (rawUrl.length > 2048) return { ok: false, error: 'The URL is too long (max 2048 characters).' };

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, error: 'That does not look like a valid URL.' };
  }
  if (url.protocol !== 'https:') return { ok: false, error: 'Source URLs must use https.' };
  if (url.username.length > 0 || url.password.length > 0) {
    return { ok: false, error: 'The URL must not contain embedded credentials.' };
  }
  if (isPrivateOrLoopbackHost(url.hostname)) {
    return { ok: false, error: 'Private, loopback, and link-local hosts are not allowed.' };
  }

  const providedKind = input.kind?.trim();
  if (providedKind && !(MEDIA_SOURCE_KINDS as readonly string[]).includes(providedKind)) {
    return { ok: false, error: 'Unknown source kind.' };
  }
  const kind = (providedKind as MediaSourceKindEnum | undefined) ?? inferRemoteSourceKind(url.pathname);

  const service = getSupabaseServiceClient();
  const { error } = await service.from('media_sources').insert({
    title_id: titleId,
    episode_id: input.episodeId?.trim() || null,
    kind,
    url: url.toString(),
    label: (input.label ?? '').trim().slice(0, 120),
    language: (input.language ?? 'en').trim().slice(0, 10) || 'en',
    quality: (input.quality ?? 'auto').trim().slice(0, 20) || 'auto',
  });
  if (error) return { ok: false, error: `Could not save the source: ${error.message}` };

  revalidateSourcesPage();
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Row maintenance
// ---------------------------------------------------------------------------

/** Enable or disable a source (disabled sources are skipped by playback). */
export async function toggleSourceAction(id: string, enabled: boolean): Promise<SourceActionResult> {
  const denied = await ensurePermission();
  if (denied) return { ok: false, error: denied };

  if (!UUID_RE.test(id ?? '')) return { ok: false, error: 'Invalid source id.' };

  const service = getSupabaseServiceClient();
  const { error } = await service.from('media_sources').update({ enabled }).eq('id', id);
  if (error) return { ok: false, error: `Could not update the source: ${error.message}` };

  revalidateSourcesPage();
  return { ok: true };
}

/**
 * Deletes a source row. When the row references an uploaded object, the object
 * is removed from the private bucket too — best-effort: a storage failure is
 * logged-and-swallowed so the row deletion itself still succeeds.
 */
export async function deleteSourceAction(id: string): Promise<SourceActionResult> {
  const denied = await ensurePermission();
  if (denied) return { ok: false, error: denied };

  if (!UUID_RE.test(id ?? '')) return { ok: false, error: 'Invalid source id.' };

  const service = getSupabaseServiceClient();
  const { data: row, error: fetchError } = await service
    .from('media_sources')
    .select('id, reference')
    .eq('id', id)
    .maybeSingle();
  if (fetchError) return { ok: false, error: `Could not find the source: ${fetchError.message}` };
  if (!row) return { ok: false, error: 'Source not found (it may already be deleted).' };

  const { error: deleteError } = await service.from('media_sources').delete().eq('id', id);
  if (deleteError) return { ok: false, error: `Could not delete the source: ${deleteError.message}` };

  if (row.reference && MEDIA_PATH_RE.test(row.reference)) {
    // Best-effort cleanup: the row is already gone; a stale object is a
    // storage-only leak, not a data-integrity failure.
    const { error: storageError } = await service.storage.from('media').remove([row.reference]);
    if (storageError) {
      console.warn(`[deleteSourceAction] storage object left behind (${row.reference}): ${storageError.message}`);
    }
  }

  revalidateSourcesPage();
  return { ok: true };
}
