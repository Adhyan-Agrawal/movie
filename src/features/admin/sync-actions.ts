'use server';

import { syncCatalogFromTmdb } from '@/features/catalog/tmdb-sync';
import { recordSyncRun } from '@/features/catalog/sync-run-log';
import { requirePermission } from '@/lib/permissions/check';
import { PERMISSIONS } from '@/lib/permissions/permissions';
import type { SyncActionState } from './sync-state';

/**
 * Admin action: TMDB catalog sync (Spec Sections 4, 7, 10) — charts or
 * genre/year-filtered discover, one click.
 *
 * Permission-gated server-side (`catalog.create`) BEFORE any data access —
 * the admin layout gate is the first layer, this is the second, and the RLS
 * policies on titles/genres/title_genres/seasons are the third. Runs as the
 * signed-in admin's session, so every write is attributable.
 *
 * TMDB is fetched SERVER-SIDE with the env key; the key never reaches the
 * browser. Failures (network blocks, TMDB outages) map to an honest error
 * message for the admin UI — never a silent partial success.
 */
export async function syncCatalogAction(
  _prev: SyncActionState,
  formData: FormData,
): Promise<SyncActionState> {
  const str = (name: string) => String(formData.get(name) ?? '').trim();
  const num = (name: string) => {
    const raw = str(name);
    if (!raw) return undefined;
    const n = Number.parseInt(raw, 10);
    return Number.isInteger(n) ? n : undefined;
  };

  const source = str('source') === 'discover' ? 'discover' : 'charts';
  const typeRaw = str('type');
  const type = typeRaw === 'movie' || typeRaw === 'tv' ? typeRaw : 'both';
  const genre = str('genre') || undefined;
  const yearFrom = num('yearFrom');
  const yearTo = num('yearTo');
  const pages = Math.min(Math.max(num('pages') ?? 3, 1), 50);

  if (yearFrom !== undefined && (yearFrom < 1878 || yearFrom > 2100)) {
    return { status: 'error', message: 'Year from must be between 1878 and 2100.' };
  }
  if (yearTo !== undefined && (yearTo < 1878 || yearTo > 2100)) {
    return { status: 'error', message: 'Year to must be between 1878 and 2100.' };
  }
  if (yearFrom !== undefined && yearTo !== undefined && yearFrom > yearTo) {
    return { status: 'error', message: 'Year from must not be after year to.' };
  }

  try {
    await requirePermission(PERMISSIONS.CATALOG_CREATE);
  } catch {
    return { status: 'error', message: 'You need the catalog.create permission to sync.' };
  }

  try {
    const result = await syncCatalogFromTmdb({ source, type, genre, yearFrom, yearTo, pages });
    // Bookkeeping (Spec Section 10): imports row + audit_logs row. Best-effort —
    // recordSyncRun logs and swallows its own failures.
    await recordSyncRun({
      ok: true,
      source: source === 'discover' ? `discover:${type}${genre ? `:${genre}` : ''}` : 'charts',
      result,
    });
    return {
      status: 'ok',
      message: result.message,
      movies: result.movies,
      series: result.series,
      seasons: result.seasons,
      genres: result.genres,
      skipped: result.skipped,
      failed: result.failed,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordSyncRun({
      ok: false,
      source: source === 'discover' ? `discover:${type}${genre ? `:${genre}` : ''}` : 'charts',
      error: message,
    });
    return {
      status: 'error',
      message:
        `Sync failed: ${message} ` +
        'If TMDB is unreachable from this server (some networks/ISPs block api.themoviedb.org), ' +
        'run the sync from a network with access — for example your cloud deployment.',
    };
  }
}
