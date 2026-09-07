'use server';

import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { revalidatePath } from 'next/cache';
import { requirePermission } from '@/lib/permissions/check';
import { PERMISSIONS } from '@/lib/permissions/permissions';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import type { SupabaseServiceClient } from '@/lib/supabase/service';
import { isFfmpegAvailable, RENDITIONS, transcodeToHls } from '../../../scripts/transcode-hls.mjs';
import type { TranscodeActionState } from './transcode-state';

/**
 * Admin action: transcode an uploaded file in the PRIVATE `media` bucket into
 * an adaptive HLS ladder and register it as a native `hls` media source.
 *
 * Flow: (a) gate `provider.manage`, (b) download the source object from private
 * storage into a temp dir, (c) run the ffmpeg ladder (`scripts/transcode-hls.mjs`),
 * (d) upload every produced playlist + segment back to `media` under
 * `hls/{title-slug}/…`, and (e) create ONE `media_sources` row (kind 'hls',
 * reference = the master playlist's storage path) unless one already exists for
 * that exact master.
 *
 * WHY THE SERVICE CLIENT: the private bucket has deliberately no public storage
 * policies (migration 0006), so uploads/downloads AND the media_sources write
 * need the service role. Permission is still asserted app-side first, and only
 * async functions are exported from this 'use server' module.
 *
 * SECURITY/CONCURRENCY NOTES:
 *  - The uploaded source is re-validated as belonging to the given title before
 *    it is ever read (`media/{titleId}/…`), matching the upload flow.
 *  - Only the produced playlist/segment files are uploaded to storage — no
 *    logs, no secrets, nothing from the temp dir but the ladder.
 *  - This is a long-running, CPU-heavy operation (up to 30 min for a feature
 *    film). It is an operator tool, not a per-viewer path; platform request
 *    timeouts on serverless hosts should be raised accordingly.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A storage path the transcode flow is allowed to read: media/{titleId}/{episodeId|'title'}/{name}. */
const MEDIA_PATH_RE = /^media\/[0-9a-f-]{36}\/(?:title|[0-9a-f-]{36})\/[A-Za-z0-9._-]+$/;

const PERMISSION_ERROR = 'You need the provider.manage permission to transcode media.';
const FFMPEG_MISSING_HINT =
  'ffmpeg is not installed on this server. Install it and retry ' +
  '(Ubuntu/Debian: `sudo apt-get install ffmpeg` · macOS: `brew install ffmpeg` · ' +
  'Windows: `winget install Gyan.FFmpeg`), or set FFMPEG_PATH to the binary.';

/** Mirror of the upload flow's 10 GB cap (uploads are capped client-side too). */
const MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024 * 1024;

/** Storage Content-Type per produced file extension. */
const CONTENT_TYPES: Record<string, string> = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.mp4': 'video/mp4',
};

function errorState(message: string): TranscodeActionState {
  return { status: 'error', message };
}

/** Permission gate: every exported action calls this first. */
async function ensurePermission(): Promise<string | null> {
  try {
    await requirePermission(PERMISSIONS.PROVIDER_MANAGE);
    return null;
  } catch {
    return PERMISSION_ERROR;
  }
}

/** Extension-derived storage Content-Type (fallback octet-stream). */
function contentTypeFor(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return 'application/octet-stream';
  return CONTENT_TYPES[name.slice(dot).toLowerCase()] ?? 'application/octet-stream';
}

/** Keep the source filename safe as a local temp file name. */
function sanitizeInputFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  const cleaned = base
    .replace(/[^A-Za-z0-9.-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 120);
  return cleaned || `input-${Date.now()}`;
}

/** A title slug is already URL-safe; defend anyway (fallback: the title id). */
function sanitizeSlug(slug: string | undefined): string {
  const cleaned = (slug ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return cleaned || '';
}

/** Recursively list every file under `dir` (absolute paths). */
async function walkFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walkFiles(full)));
    else out.push(full);
  }
  return out;
}

/**
 * Best-effort removal of everything currently under `prefix`, so a re-transcode
 * never leaves orphaned segments from an earlier, longer cut. Supabase list()
 * returns folders as entries with null metadata; the ladder is only two levels
 * deep (prefix/{variant}/seg_N.ts), so a two-level walk is enough.
 */
async function removePrefixFiles(service: SupabaseServiceClient, prefix: string): Promise<void> {
  try {
    const { data: top } = await service.storage.from('media').list(prefix, { limit: 1000 });
    const toRemove: string[] = [];
    for (const entry of top ?? []) {
      if (entry.metadata === null) {
        const { data: nested } = await service.storage
          .from('media')
          .list(`${prefix}/${entry.name}`, { limit: 1000 });
        for (const n of nested ?? []) {
          if (n.metadata !== null) toRemove.push(`${prefix}/${entry.name}/${n.name}`);
        }
      } else {
        toRemove.push(`${prefix}/${entry.name}`);
      }
    }
    if (toRemove.length > 0) await service.storage.from('media').remove(toRemove);
  } catch (err) {
    // Stale objects are a storage-only leak, never a transcode failure.
    console.warn(`[transcodeUploadAction] prefix cleanup skipped (${prefix}): ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Upload every file under `workDir` to `media` at `prefix/<relative path>`. Returns an error string or null. */
async function uploadDirectory(
  service: SupabaseServiceClient,
  workDir: string,
  prefix: string,
): Promise<string | null> {
  try {
    await removePrefixFiles(service, prefix);
    const files = await walkFiles(workDir);
    for (const file of files) {
      const rel = relative(workDir, file).split('\\').join('/');
      const storagePath = `${prefix}/${rel}`;
      const bytes = await readFile(file);
      const { error } = await service.storage.from('media').upload(storagePath, bytes, {
        contentType: contentTypeFor(rel),
        upsert: true,
      });
      if (error) return `${storagePath}: ${error.message}`;
    }
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Register the HLS source row (kind 'hls', reference = master playlist path).
 * Idempotent: when a row already exists for exactly this master path, leave it
 * untouched rather than stacking duplicates on re-transcode.
 */
async function upsertHlsSourceRow(
  service: SupabaseServiceClient,
  input: { titleId: string; episodeId?: string; masterPath: string; label?: string },
): Promise<string | null> {
  const existing = await service
    .from('media_sources')
    .select('id')
    .eq('title_id', input.titleId)
    .eq('kind', 'hls')
    .eq('reference', input.masterPath)
    .maybeSingle();
  if (existing.error) return existing.error.message;
  if (existing.data) return null; // already registered

  const defaultLabel = `HLS (${RENDITIONS.map((r) => `${r.height}p`).join('/')})`;
  const { error } = await service.from('media_sources').insert({
    title_id: input.titleId,
    episode_id: input.episodeId ?? null,
    kind: 'hls',
    reference: input.masterPath,
    label: (input.label ?? defaultLabel).trim().slice(0, 120) || defaultLabel,
    language: 'en',
    quality: 'auto',
    priority: 200, // above the default 100 of raw uploads — the ladder is the preferred native source
    enabled: true,
  });
  return error?.message ?? null;
}

/**
 * Transcode an already-uploaded file in the private `media` bucket into an HLS
 * ladder. `formData` carries: `titleId`, `episodeId` (optional, whole-title when
 * empty), `path` (the media_sources `reference` of the uploaded file), `label`.
 */
export async function transcodeUploadAction(
  _prev: TranscodeActionState,
  formData: FormData,
): Promise<TranscodeActionState> {
  const str = (name: string) => String(formData.get(name) ?? '').trim();

  const titleId = str('titleId');
  const episodeId = str('episodeId') || undefined;
  const path = str('path');
  const label = str('label');

  // Validate BEFORE touching storage (mirrors the upload flow's checks).
  if (!UUID_RE.test(titleId)) return errorState('A valid title is required.');
  if (episodeId !== undefined && !UUID_RE.test(episodeId)) return errorState('Invalid episode selected.');
  if (!MEDIA_PATH_RE.test(path)) {
    return errorState('Invalid storage path — this does not look like a Lumora upload.');
  }
  if (!path.startsWith(`media/${titleId}/`)) {
    return errorState('The storage path does not belong to this title.');
  }

  const denied = await ensurePermission();
  if (denied) return errorState(denied);

  if (!isFfmpegAvailable()) return errorState(FFMPEG_MISSING_HINT);

  const service = getSupabaseServiceClient();
  const workDir = await mkdtemp(join(tmpdir(), 'lumora-hls-'));

  try {
    // (b) Download the source object from private storage to a temp dir.
    const { data: blob, error: downloadError } = await service.storage.from('media').download(path);
    if (downloadError || !blob) {
      return errorState(`Could not read the uploaded file from storage: ${downloadError?.message ?? 'empty object'}`);
    }
    const bytes = Buffer.from(await blob.arrayBuffer());
    if (bytes.byteLength === 0) return errorState('The uploaded file is empty.');
    if (bytes.byteLength > MAX_DOWNLOAD_BYTES) return errorState('The uploaded file exceeds the 10 GB transcode limit.');

    const inputFile = join(workDir, sanitizeInputFilename(basename(path)));
    await writeFile(inputFile, bytes);

    // (c) Run the ffmpeg ladder (1080/720/480 + master) into the temp dir.
    const result = await transcodeToHls({
      inputPath: inputFile,
      outputDir: workDir,
      onProgress: ({ percent }) => {
        if (percent != null) console.log(`[transcodeUploadAction] ${titleId} ${percent.toFixed(0)}%`);
      },
    });

    // (d) Upload the ladder back to `media` under hls/{slug}/… (episodes get
    //     their own subfolder so masters never collide within a title).
    const { data: title } = await service.from('titles').select('slug').eq('id', titleId).maybeSingle();
    const slug = sanitizeSlug(title?.slug) || titleId;
    const prefix = episodeId ? `hls/${slug}/episodes/${episodeId}` : `hls/${slug}`;

    const uploadError = await uploadDirectory(service, workDir, prefix);
    if (uploadError) return errorState(`ffmpeg finished but the results could not be stored: ${uploadError}`);

    // (e) One media_sources row pointing at the master playlist — if missing.
    const masterPath = `${prefix}/master.m3u8`;
    const rowError = await upsertHlsSourceRow(service, { titleId, episodeId, masterPath, label });
    if (rowError) {
      return errorState(`HLS was transcoded and stored, but the source row could not be saved: ${rowError}`);
    }

    revalidatePath('/admin/sources');
    revalidatePath('/admin/sources/transcode');

    return {
      status: 'ok',
      message: `Transcoded to HLS — ${result.renditions.length} renditions (${result.renditions.map((r) => `${r.height}p`).join(' / ')}) ready for the native player.`,
      masterPath,
      prefix,
      renditions: result.renditions.map((r) => `${r.height}p`),
      durationSeconds: result.durationSeconds ?? undefined,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorState(`Transcode failed: ${message}`);
  } finally {
    // Temp ladder + source copy never leave the machine.
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
