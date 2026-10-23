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
  /**
   * Cap the rows read. ALWAYS set this for shelf/list views: an unbounded read
   * pulls the whole catalog (with its genre joins) on every render, which is
   * what exhausted the Supabase egress quota.
   */
  limit?: number;
}

/** Log a repository failure once (safe diagnostics only). */
function warnFailure(fn: string, err: unknown): void {
  console.warn(`catalog.${fn}: repository failed, returning empty result`, {
    message: err instanceof Error ? err.message : String(err),
  });
}

export async function getTitleBySlug(type: TitleType, slug: string): Promise<Title | null> {
  if (features.tmdbConfigured) {
    try {
      const { getTmdbTitle } = await import('./tmdb-catalog');
      return await getTmdbTitle(type, slug);
    } catch (err) {
      warnFailure('getTmdbTitle', err);
      return null;
    }
  }
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
  if (features.tmdbConfigured) {
    try {
      const { listTmdbGenres } = await import('./tmdb-catalog');
      return await listTmdbGenres();
    } catch (err) {
      warnFailure('listTmdbGenres', err);
      return [];
    }
  }
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
  if (features.tmdbConfigured) {
    try {
      const { listTmdbTitles, searchTmdbTitles } = await import('./tmdb-catalog');
      if (filters.query) return await searchTmdbTitles(filters.query);
      const result = await listTmdbTitles(filters);
      return filters.limit ? result.titles.slice(0, filters.limit) : result.titles;
    } catch (err) {
      warnFailure('listTmdbTitles', err);
      return [];
    }
  }
  if (!features.supabaseConfigured) return [];
  try {
    const { repoListTitles } = await import('./repository');
    return await repoListTitles(filters);
  } catch (err) {
    warnFailure('listTitles', err);
    return [];
  }
}

export interface TitlePage {
  titles: Title[];
  total: number;
}

export async function listTitlesPage(filters: TitleFilters, page: number, pageSize: number): Promise<TitlePage> {
  if (features.tmdbConfigured) {
    try {
      const { listTmdbTitles, searchTmdbTitles } = await import('./tmdb-catalog');
      if (filters.query) {
        const titles = await searchTmdbTitles(filters.query);
        return { titles: titles.slice((page - 1) * pageSize, page * pageSize), total: titles.length };
      }
      const result = await listTmdbTitles(filters, page);
      return { titles: result.titles.slice(0, pageSize), total: result.total };
    } catch (err) {
      warnFailure('listTmdbTitlesPage', err);
      return { titles: [], total: 0 };
    }
  }
  if (!features.supabaseConfigured) return { titles: [], total: 0 };
  try {
    const { repoListTitlesPage } = await import('./repository');
    const result = await repoListTitlesPage(filters, page, pageSize);
    return { titles: result.rows, total: result.total };
  } catch (err) {
    warnFailure('listTitlesPage', err);
    return { titles: [], total: 0 };
  }
}

export async function listTitleRoutes(): Promise<Array<Pick<Title, 'slug' | 'type'>>> {
  if (features.tmdbConfigured) return [];
  if (!features.supabaseConfigured) return [];
  try {
    const { repoListTitleRoutes } = await import('./repository');
    return await repoListTitleRoutes();
  } catch (err) {
    warnFailure('listTitleRoutes', err);
    return [];
  }
}

/** Similar titles by shared-genre overlap (transparent v1 rule, Section 13). */
export async function getSimilarTitles(title: Title, limit = 6): Promise<Title[]> {
  if (features.tmdbConfigured) {
    const candidates = await listTitles({ type: title.type, limit: 20 });
    return candidates.filter((candidate) => candidate.id !== title.id).slice(0, limit);
  }
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
  if (features.tmdbConfigured) {
    const [, type, tmdbId] = titleId.split(':');
    if (type !== 'tv' || !tmdbId) return [];
    try {
      const { tmdbSeasons } = await import('./tmdb-catalog');
      return await tmdbSeasons({ id: titleId, type: 'tv', slug: `tv-${tmdbId}`, name: '', synopsis: '', releaseYear: 0, maturity: 'TV-14', genres: [], tmdbId });
    } catch (err) {
      warnFailure('tmdbSeasons', err);
      return [];
    }
  }
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
  if (features.tmdbConfigured) {
    const [, type, tmdbId] = titleId.split(':');
    if ((type !== 'movie' && type !== 'tv') || !tmdbId) return [];
    try {
      const { tmdbCast } = await import('./tmdb-catalog');
      return await tmdbCast({ id: titleId, type, slug: `${type}-${tmdbId}`, name: '', synopsis: '', releaseYear: 0, maturity: type === 'tv' ? 'TV-14' : 'PG-13', genres: [], tmdbId });
    } catch (err) {
      warnFailure('tmdbCast', err);
      return [];
    }
  }
  if (!features.supabaseConfigured) return [];
  try {
    const { repoListCastForTitle } = await import('./repository');
    return await repoListCastForTitle(titleId);
  } catch (err) {
    warnFailure('listCastForTitle', err);
    return [];
  }
}
