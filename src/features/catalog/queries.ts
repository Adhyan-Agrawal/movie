import { features } from '@/lib/env';
import type { Title, TitleType } from './types';
import { MOCK_TITLES } from './mock-data';

/**
 * Read API over the catalog (Section 6: services -> repositories).
 *
 * When Supabase is configured these delegate to the Postgres-backed repository
 * (`./repository`, server-only) so the app reads REAL catalog data under RLS.
 * If Supabase is not configured, or a repository call fails, we fall back to the
 * local mock catalog so the app stays fully runnable and never hard-errors on a
 * transient DB issue. The repository module is imported lazily (dynamic import)
 * so it — and the `server-only` server client it pulls in — is never bundled
 * into a client component that happens to import a type from this file.
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

/** Log a repository failure once (safe diagnostics only) then fall back. */
function warnFallback(fn: string, err: unknown): void {
  console.warn(`catalog.${fn}: repository failed, using mock fallback`, {
    message: err instanceof Error ? err.message : String(err),
  });
}

export async function getTitleBySlug(type: TitleType, slug: string): Promise<Title | null> {
  if (features.supabaseConfigured) {
    try {
      const { repoGetTitleBySlug } = await import('./repository');
      return await repoGetTitleBySlug(type, slug);
    } catch (err) {
      warnFallback('getTitleBySlug', err);
    }
  }
  return MOCK_TITLES.find((t) => t.type === type && t.slug === slug) ?? null;
}

export async function getTitleById(id: string): Promise<Title | null> {
  if (features.supabaseConfigured) {
    try {
      const { repoGetTitleById } = await import('./repository');
      return await repoGetTitleById(id);
    } catch (err) {
      warnFallback('getTitleById', err);
    }
  }
  return MOCK_TITLES.find((t) => t.id === id) ?? null;
}

export async function listAllGenres(): Promise<string[]> {
  if (features.supabaseConfigured) {
    try {
      const { repoListGenres } = await import('./repository');
      const genres = await repoListGenres();
      if (genres.length) return genres;
    } catch (err) {
      warnFallback('listAllGenres', err);
    }
  }
  const set = new Set<string>();
  for (const t of MOCK_TITLES) for (const g of t.genres) set.add(g);
  return [...set].sort((a, b) => a.localeCompare(b));
}

function sortTitles(titles: Title[], sort: TitleFilters['sort']): Title[] {
  const copy = [...titles];
  switch (sort) {
    case 'newest':
      return copy.sort((a, b) => b.releaseYear - a.releaseYear);
    case 'oldest':
      return copy.sort((a, b) => a.releaseYear - b.releaseYear);
    case 'az':
      return copy.sort((a, b) => a.name.localeCompare(b.name));
    case 'score':
      return copy.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    case 'trending':
    default:
      return copy.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  }
}

function listMockTitles(filters: TitleFilters): Title[] {
  const out = MOCK_TITLES.filter((t) => {
    if (filters.type && t.type !== filters.type) return false;
    if (filters.genre && !t.genres.some((g) => g.toLowerCase() === filters.genre!.toLowerCase())) return false;
    if (filters.year && t.releaseYear !== filters.year) return false;
    if (filters.minYear && t.releaseYear < filters.minYear) return false;
    if (filters.maxYear && t.releaseYear > filters.maxYear) return false;
    if (filters.maturity && t.maturity !== filters.maturity) return false;
    if (filters.query) {
      const q = filters.query.toLowerCase();
      const hay = `${t.name} ${t.originalName ?? ''} ${t.genres.join(' ')} ${t.synopsis}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  return sortTitles(out, filters.sort);
}

export async function listTitles(filters: TitleFilters = {}): Promise<Title[]> {
  if (features.supabaseConfigured) {
    try {
      const { repoListTitles } = await import('./repository');
      return await repoListTitles(filters);
    } catch (err) {
      warnFallback('listTitles', err);
    }
  }
  return listMockTitles(filters);
}

/** Similar titles by shared-genre overlap (transparent v1 rule, Section 13). */
export async function getSimilarTitles(title: Title, limit = 6): Promise<Title[]> {
  if (features.supabaseConfigured) {
    try {
      const { repoGetSimilarTitles } = await import('./repository');
      return await repoGetSimilarTitles(title, limit);
    } catch (err) {
      warnFallback('getSimilarTitles', err);
    }
  }
  return MOCK_TITLES.filter((t) => t.id !== title.id)
    .map((t) => ({ t, overlap: t.genres.filter((g) => title.genres.includes(g)).length }))
    .filter((x) => x.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap || (b.t.score ?? 0) - (a.t.score ?? 0))
    .slice(0, limit)
    .map((x) => x.t);
}
