import { features } from '@/lib/env';
import type { CastMember, Season, Title, TitleType } from './types';

/**
 * Read API over the catalog (Section 6: services -> repositories).
 *
 * Every read goes to the Postgres-backed repository (`./repository`,
 * server-only) under RLS when Supabase is configured. There is NO mock
 * fallback: if Supabase is not configured, or a repository call fails, list
 * functions return `[]` and single-title lookups return `null` so the UI can
 * render honest empty states instead of fabricated content. The repository
 * module is imported lazily (dynamic import) so it — and the `server-only`
 * server client it pulls in — is never bundled into a client component that
 * happens to import a type from this file.
 */

export interface TitleFilters {
  type?: TitleType;
  genre?: string;
  year?: number;
  minYear?: number;
  maxYear?: number;
  maturity?: string;
  query?: string;
  sort?: 'trending' | 'newest' | 'oldest' | 'az' | 'score';
}

/** Log a repository failure once (safe diagnostics only). */
function warnFailure(fn: string, err: unknown): void {
  console.warn(`catalog.${fn}: repository failed, returning empty result`, {
    message: err instanceof Error ? err.message : String(err),
  });
}

export async function getTitleBySlug(type: TitleType, slug: string): Promise<Title | null> {
  if (!features.supabaseConfigured) return null;
  try {
    const { repoGetTitleBySlug } = await import('./repository');
    return await repoGetTitleBySlug(type, slug);
  } catch (err) {
    warnFailure('getTitleBySlug', err);
    return null;
  }
}

export async function getTitleById(id: string): Promise<Title | null> {
  if (!features.supabaseConfigured) return null;
  try {
    const { repoGetTitleById } = await import('./repository');
    return await repoGetTitleById(id);
  } catch (err) {
    warnFailure('getTitleById', err);
    return null;
  }
}

export async function listAllGenres(): Promise<string[]> {
  if (!features.supabaseConfigured) return [];
  try {
    const { repoListGenres } = await import('./repository');
    return await repoListGenres();
  } catch (err) {
    warnFailure('listAllGenres', err);
    return [];
  }
}

export async function listTitles(filters: TitleFilters = {}): Promise<Title[]> {
  if (!features.supabaseConfigured) return [];
  try {
    const { repoListTitles } = await import('./repository');
    return await repoListTitles(filters);
  } catch (err) {
    warnFailure('listTitles', err);
    return [];
  }
}

/** Similar titles by shared-genre overlap (transparent v1 rule, Section 13). */
export async function getSimilarTitles(title: Title, limit = 6): Promise<Title[]> {
  if (!features.supabaseConfigured) return [];
  try {
    const { repoGetSimilarTitles } = await import('./repository');
    return await repoGetSimilarTitles(title, limit);
  } catch (err) {
    warnFailure('getSimilarTitles', err);
    return [];
  }
}

/**
 * Seasons (with any imported episodes) for a TV title, ordered by season
 * number. Returns [] when the title has no seasons or Supabase is not
 * configured — the UI then renders its honest empty state.
 */
export async function listSeasonsForTitle(titleId: string): Promise<Season[]> {
  if (!features.supabaseConfigured) return [];
  try {
    const { repoListSeasonsForTitle } = await import('./repository');
    return await repoListSeasonsForTitle(titleId);
  } catch (err) {
    warnFailure('listSeasonsForTitle', err);
    return [];
  }
}

/**
 * Cast credits for a title, ordered by billing. Returns [] when the title has
 * no imported cast or Supabase is not configured.
 */
export async function listCastForTitle(titleId: string): Promise<CastMember[]> {
  if (!features.supabaseConfigured) return [];
  try {
    const { repoListCastForTitle } = await import('./repository');
    return await repoListCastForTitle(titleId);
  } catch (err) {
    warnFailure('listCastForTitle', err);
    return [];
  }
}
