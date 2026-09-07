'use server';

import { revalidatePath } from 'next/cache';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { requirePermission } from '@/lib/permissions/check';
import { PERMISSIONS } from '@/lib/permissions/permissions';
import { findEpisodeId } from '@/features/playback/native-sources';
import { isPrivateOrLoopbackHost } from '@/lib/validation/source';
import { inferRemoteSourceKind } from './source-utils';
import { parseBulkSourceCsv, type BulkSourceRow } from './bulk-source-parse';

/**
 * Bulk media-source tools (provider.manage): paste-CSV import of many remote
 * streams plus a live health probe of existing remote sources.
 *
 * Both actions assert `provider.manage` (matching the `media_sources_manage`
 * RLS policy) before any work — the page-level gate is the first layer, this
 * is the second. Rows are written with the service client exactly like the
 * single-source actions in `./sources-actions`; the caller-provided CSV is
 * validated per row (title lookup, episode resolution, SSRF-safe URL check)
 * BEFORE any write, so a bad line can never corrupt `media_sources`.
 */

const PERMISSION_ERROR = 'You need the provider.manage permission to use bulk source tools.';

/** Row-level outcome for {@link bulkImportSourcesAction}. */
export type BulkImportRowStatus = 'imported' | 'skipped' | 'error';

/** One CSV line's outcome, keyed by its 1-based line number. */
export interface BulkImportRowResult {
  line: number;
  tmdbId: string;
  /** Resolved title name / label / url fragment, for the results table. */
  label: string;
  status: BulkImportRowStatus;
  /** Human detail: 'inserted', 'updated existing', or the failure reason. */
  note?: string;
}

/** Whole-run outcome for {@link bulkImportSourcesAction}. */
export interface BulkImportResult {
  ok: boolean;
  imported: number;
  skipped: number;
  failed: number;
  rows: BulkImportRowResult[];
  /** Fatal (pre-run) error: permission denied, empty/unparseable CSV. */
  error?: string;
}

/** Display label for a row: prefer the CSV label, then the URL host/path, then the id. */
function displayLabel(row: BulkSourceRow): string {
  if (row.label) return row.label.slice(0, 60);
  if (row.url) {
    try {
      return new URL(row.url).hostname;
    } catch {
      return row.url.slice(0, 60);
    }
  }
  return `tmdb ${row.tmdbId}`.slice(0, 60);
}

/**
 * Import remote streams from a pasted CSV.
 *
 * Columns: `tmdb_id,season,episode,url,label,language,quality` — `season` and
 * `episode` are optional (movies, or a whole-title source for a series). Each
 * row resolves its title by tmdb_id, resolves the episode server-side when a
 * season+episode pair is given, SSRF-screens the URL, and upserts into
 * `media_sources`: an existing row with the same (title, episode, url) gets its
 * metadata refreshed (priority/enabled/consent_required are operator-owned and
 * preserved), otherwise a new row is inserted with the standard defaults.
 * Results are per-row — one bad line never aborts the rest.
 */
export async function bulkImportSourcesAction(input: { csv: string }): Promise<BulkImportResult> {
  try {
    await requirePermission(PERMISSIONS.PROVIDER_MANAGE);
  } catch {
    return { ok: false, imported: 0, skipped: 0, failed: 0, rows: [], error: PERMISSION_ERROR };
  }

  const raw = input?.csv ?? '';
  if (!raw.trim()) {
    return { ok: false, imported: 0, skipped: 0, failed: 0, rows: [], error: 'Paste a CSV with at least one data row first.' };
  }

  const rows = parseBulkSourceCsv(raw);
  if (rows.length === 0) {
    return { ok: false, imported: 0, skipped: 0, failed: 0, rows: [], error: 'No data rows found — the CSV needs a tmdb_id and a url per line.' };
  }

  const results: BulkImportRowResult[] = [];
  let imported = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    const result = await importOneRow(row);
    results.push(result);
    if (result.status === 'imported') imported++;
    else if (result.status === 'skipped') skipped++;
    else failed++;
  }

  revalidatePath('/admin/sources');
  return { ok: true, imported, skipped, failed, rows: results };
}

/** Validate + upsert ONE CSV row. Never throws — failures come back as rows. */
async function importOneRow(row: BulkSourceRow): Promise<BulkImportRowResult> {
  const base = { line: row.line, tmdbId: row.tmdbId, label: displayLabel(row) };

  // --- tmdb_id -------------------------------------------------------------
  const tmdbId = Number(row.tmdbId);
  if (!row.tmdbId || !Number.isInteger(tmdbId) || tmdbId <= 0) {
    return { ...base, status: 'error', note: 'tmdb_id must be a positive whole number.' };
  }

  // --- Resolve the title by tmdb_id ----------------------------------------
  const service = getSupabaseServiceClient();
  const { data: title, error: titleError } = await service
    .from('titles')
    .select('id, type, name')
    .eq('tmdb_id', tmdbId)
    .maybeSingle();
  if (titleError) {
    return { ...base, status: 'error', note: `Could not look up tmdb_id ${tmdbId}: ${titleError.message}` };
  }
  if (!title) {
    return { ...base, status: 'error', note: `No catalog title has tmdb_id ${tmdbId}.` };
  }

  // --- Optional season+episode -> episode id --------------------------------
  const seasonRaw = row.season.trim();
  const episodeRaw = row.episode.trim();
  let episodeId: string | null = null;
  if (seasonRaw || episodeRaw) {
    const season = Number(seasonRaw);
    const episode = Number(episodeRaw);
    if (!Number.isInteger(season) || season <= 0 || !Number.isInteger(episode) || episode <= 0) {
      return { ...base, status: 'error', note: 'Season and episode must both be positive whole numbers (or blank for the whole title).' };
    }
    if (title.type !== 'tv') {
      return { ...base, status: 'error', note: 'This title is a movie — season/episode only apply to series.' };
    }
    const resolved = await findEpisodeId(title.id, season, episode);
    if (!resolved) {
      return { ...base, status: 'error', note: `No episode found for S${season} E${episode} — has it been imported?` };
    }
    episodeId = resolved;
  }

  // --- SSRF-safe URL validation (http/https, no creds, no private hosts) -----
  const url = row.url.trim();
  if (!url) {
    return { ...base, status: 'skipped', note: 'No URL on this line.' };
  }
  if (url.length > 2048) {
    return { ...base, status: 'error', note: 'The URL is too long (max 2048 characters).' };
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return { ...base, status: 'error', note: 'Not a valid URL.' };
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return { ...base, status: 'error', note: 'The URL must use http or https.' };
  }
  if (parsedUrl.username.length > 0 || parsedUrl.password.length > 0) {
    return { ...base, status: 'error', note: 'The URL must not contain embedded credentials.' };
  }
  if (isPrivateOrLoopbackHost(parsedUrl.hostname)) {
    return { ...base, status: 'error', note: 'Private, loopback, and link-local hosts are not allowed.' };
  }

  const kind = inferRemoteSourceKind(url);
  const canonicalUrl = parsedUrl.toString();

  // --- Upsert: refresh a matching row, else insert ---------------------------
  const label = row.label.trim().slice(0, 120);
  const language = row.language.trim().slice(0, 10) || 'en';
  const quality = row.quality.trim().slice(0, 20) || 'auto';

  let existingQuery = service
    .from('media_sources')
    .select('id')
    .eq('title_id', title.id)
    .eq('url', canonicalUrl);
  existingQuery = episodeId
    ? existingQuery.eq('episode_id', episodeId)
    : existingQuery.is('episode_id', null);
  const { data: existing, error: existingError } = await existingQuery.maybeSingle();
  if (existingError) {
    return { ...base, status: 'error', note: `Could not check for an existing source: ${existingError.message}` };
  }

  if (existing) {
    const { error: updateError } = await service
      .from('media_sources')
      .update({ kind, label, language, quality })
      .eq('id', existing.id);
    if (updateError) {
      return { ...base, status: 'error', note: `Could not update the existing source: ${updateError.message}` };
    }
    return { ...base, label: title.name, status: 'imported', note: 'updated existing source' };
  }

  const { error: insertError } = await service.from('media_sources').insert({
    title_id: title.id,
    episode_id: episodeId,
    kind,
    url: canonicalUrl,
    label,
    language,
    quality,
    priority: 100,
    enabled: true,
    consent_required: false,
  });
  if (insertError) {
    return { ...base, status: 'error', note: `Could not save the source: ${insertError.message}` };
  }
  return { ...base, label: title.name, status: 'imported', note: 'inserted' };
}

// ---------------------------------------------------------------------------
// Source health checker
// ---------------------------------------------------------------------------

/** Probe cap — a bounded sample keeps the check fast and polite to CDNs. */
const HEALTH_PROBE_LIMIT = 25;

/** Per-source timeout; short so a hung CDN can't block the action. */
const HEALTH_PROBE_TIMEOUT_MS = 6000;

/** One probed source's outcome. */
export interface SourceHealthResult {
  id: string;
  label: string;
  /** Host + truncated path — the raw query string (tokens) never leaves the server. */
  url: string;
  kind: string;
  status: 'healthy' | 'unreachable' | 'skipped';
  /** Human detail: 'HTTP 200', 'Timed out', 'Invalid URL — not probed', … */
  note: string;
  checkedAt: string;
}

/**
 * Probe a capped sample of remote `media_sources` URLs (storage-backed uploads
 * are skipped — they have no url) with a short timeout. HEAD first, falling
 * back to a ranged GET (bytes=0-0) for CDNs that reject HEAD. Response bodies
 * are never read, stored, or logged — only status codes are surfaced.
 */
export async function checkSourceHealthAction(): Promise<{
  ok: boolean;
  results: SourceHealthResult[];
  error?: string;
}> {
  try {
    await requirePermission(PERMISSIONS.PROVIDER_MANAGE);
  } catch {
    return { ok: false, results: [], error: PERMISSION_ERROR };
  }

  const service = getSupabaseServiceClient();
  const { data: rows, error } = await service
    .from('media_sources')
    .select('id, kind, url, label')
    .is('reference', null) // storage-backed uploads have no url to probe
    .not('url', 'is', null)
    .order('updated_at', { ascending: false })
    .limit(HEALTH_PROBE_LIMIT);

  if (error) {
    return { ok: false, results: [], error: `Could not read media sources: ${error.message}` };
  }

  const results = await Promise.all((rows ?? []).map(probeSource));
  return { ok: true, results };
}

/** Probe one source row, returning the result DTO (never throws). */
async function probeSource(row: {
  id: string;
  kind: string;
  url: string | null;
  label: string | null;
}): Promise<SourceHealthResult> {
  const base: SourceHealthResult = {
    id: row.id,
    label: row.label || row.kind,
    url: displayProbeUrl(row.url ?? ''),
    kind: row.kind,
    status: 'unreachable',
    note: '',
    checkedAt: new Date().toISOString(),
  };

  // Re-validate before probing (defense in depth — rows may predate URL checks).
  const rawUrl = row.url ?? '';
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ...base, status: 'skipped', note: 'Invalid URL — not probed.' };
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    isPrivateOrLoopbackHost(url.hostname)
  ) {
    return { ...base, status: 'skipped', note: 'Not a probeable public URL.' };
  }

  const outcome = await probeUrl(url);
  return { ...base, status: outcome.healthy ? 'healthy' : 'unreachable', note: outcome.note };
}

/** Probe one URL: HEAD, then ranged GET on method-not-supported, else report. */
async function probeUrl(url: URL): Promise<{ healthy: boolean; note: string }> {
  const head = await tryFetch(url, { method: 'HEAD' });
  if (head) return head;
  const get = await tryFetch(url, { method: 'GET', headers: { Range: 'bytes=0-0' } });
  return get ?? { healthy: false, note: 'Unreachable — connection failed.' };
}

/**
 * One fetch attempt. Returns null only when the caller should try the fallback
 * (network-level failure, or a CDN that refuses HEAD with 405/501). Response
 * bodies are cancelled immediately — never read, stored, or logged.
 */
async function tryFetch(
  url: URL,
  init: RequestInit,
): Promise<{ healthy: boolean; note: string } | null> {
  try {
    const res = await fetch(url, {
      ...init,
      redirect: 'follow',
      signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
    });
    res.body?.cancel().catch(() => {});
    if (init.method === 'HEAD' && (res.status === 405 || res.status === 501)) return null;
    return { healthy: res.ok, note: `HTTP ${res.status}` };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { healthy: false, note: 'Timed out' };
    }
    return null;
  }
}

/** Host plus a truncated path for the table — never the full query string. */
function displayProbeUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    const path = url.pathname.length > 1 ? url.pathname.slice(0, 48) : '';
    return `${url.hostname}${path}${path.length >= 48 ? '…' : ''}`;
  } catch {
    return rawUrl.slice(0, 48);
  }
}
