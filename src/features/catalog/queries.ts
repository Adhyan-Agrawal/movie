import { cache } from 'react';
import { features } from '@/lib/env';
import type { CastMember, Season, Title, TitleType } from './types';
import { matchesDiscovery } from './discovery';

/**
 * Read API over the catalog (Section 6: services -> repositories).
 *
 * Public discovery reads prefer TMDB, with a Postgres-backed repository
 * (`./repository`, server-only) fallback under anonymous RLS, never the viewer's
 * editor/session context. There is NO mock
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
  originalLanguage?: string;
  country?: string;
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
  console.warn(`catalog.${fn}: read failed`, {
    message: err instanceof Error ? err.message : String(err),
  });
}

// Bound response latency; the read-only TMDB fetch can still finish warming its
// existing public Next cache. No account-scoped repository data is cached here.
async function withReadDeadline<T>(read: Promise<T>, timeoutMs = 8000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Catalog read deadline exceeded')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

// React cache is scoped to the render request, including metadata. Repository
// reads use anonymous RLS; admin reads have a separate, session-scoped entry point.
export const getTitleBySlug = cache(async (type: TitleType, slug: string): Promise<Title | null> => {
  const canonical = /^tmdb-[1-9][0-9]{0,9}$/.test(slug);
  if (slug.startsWith('tmdb-') && !canonical) return null;
  // New provider URLs are unambiguous. Only legacy/owned URLs need a DB lookup.
  if (!canonical && features.supabaseConfigured) {
    const { repoGetTitleBySlug } = await import('./repository');
    const stored = await repoGetTitleBySlug(type, slug);
    if (stored) return stored;
  }
  if (!features.tmdbConfigured || !/-(?:[1-9][0-9]{0,9})$/.test(slug)) return null;
  const { getTmdbTitle } = await import('./tmdb-catalog');
  const title = await withReadDeadline(getTmdbTitle(type, slug));
  if (!title || canonical) return title;
  // Preserve shipped pretty URLs only for their exact public provider title.
  const { slugify } = await import('./tmdb-normalize');
  const id = /-([1-9][0-9]{0,9})$/.exec(slug)![1];
  return slug === `${slugify(title.name)}-${id}` ? title : null;
});

export const getTitleById = cache(async (id: string): Promise<Title | null> => {
  if (id.startsWith('tmdb:')) {
    const match = /^tmdb:(movie|tv):[1-9][0-9]{0,9}$/.exec(id);
    if (!match || match[0] !== id || !features.tmdbConfigured) return null;
    const { getTmdbTitleById } = await import('./tmdb-catalog');
    return await withReadDeadline(getTmdbTitleById(id));
  }
  if (!features.supabaseConfigured) return null;
  try {
    const { repoGetTitleById } = await import('./repository');
    return await repoGetTitleById(id);
  } catch (err) {
    warnFailure('getTitleById', err);
    return null;
  }
});

export const listAllGenres = cache(async (): Promise<string[]> => {
  if (features.tmdbConfigured) {
    try {
      const { listTmdbGenres } = await import('./tmdb-catalog');
      return await withReadDeadline(listTmdbGenres());
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
});

export async function listTitles(filters: TitleFilters = {}): Promise<Title[]> {
  if (features.tmdbConfigured) {
    try {
      const { listTmdbTitles, searchTmdbTitles } = await import('./tmdb-catalog');
      if (filters.query) {
        const titles = await withReadDeadline(searchTmdbTitles(filters.query, filters));
        return titles.filter((title) => matchesDiscovery(title, filters)).slice(0, filters.limit ?? 24);
      }
      const result = await withReadDeadline(listTmdbTitles(filters, 1, filters.limit ?? 20));
      return filters.limit ? result.titles.slice(0, filters.limit) : result.titles;
    } catch (err) {
      warnFailure('listTmdbTitles', err);
      throw err;
    }
  }
  if (!features.supabaseConfigured) return [];
  try {
    const { repoListTitles } = await import('./repository');
    const titles = await repoListTitles(filters);
    return titles.filter((title) => matchesDiscovery(title, filters));
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
        const titles = (await withReadDeadline(searchTmdbTitles(filters.query, filters))).filter((title) => matchesDiscovery(title, filters));
        return { titles: titles.slice((page - 1) * pageSize, page * pageSize), total: titles.length };
      }
      return await withReadDeadline(listTmdbTitles(filters, page, pageSize));
    } catch (err) {
      warnFailure('listTmdbTitlesPage', err);
      throw err;
    }
  }
  if (!features.supabaseConfigured) return { titles: [], total: 0 };
  try {
    const { repoListTitlesPage } = await import('./repository');
    const result = await repoListTitlesPage(filters, page, pageSize);
    const titles = result.rows.filter((title) => matchesDiscovery(title, filters));
    return { titles, total: result.total };
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
export const getSimilarTitles = cache(async (title: Title, limit = 6): Promise<Title[]> => {
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
});

/**
 * Seasons (with any imported episodes) for a TV title, ordered by season
 * number. Returns [] when the title has no seasons or Supabase is not
 * configured — the UI then renders its honest empty state.
 */
export const listSeasonsForTitle = cache(async (titleId: string): Promise<Season[]> => {
  if (features.tmdbConfigured) {
    const [, type, tmdbId] = titleId.split(':');
    if (type !== 'tv' || !tmdbId) return [];
    try {
      const { tmdbSeasons } = await import('./tmdb-catalog');
      return await withReadDeadline(tmdbSeasons({ id: titleId, type: 'tv', slug: `tv-${tmdbId}`, name: '', synopsis: '', releaseYear: 0, maturity: 'TV-14', genres: [], tmdbId }), 3000);
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
});

/**
 * Cast credits for a title, ordered by billing. Returns [] when the title has
 * no imported cast or Supabase is not configured.
 */
export const listCastForTitle = cache(async (titleId: string): Promise<CastMember[]> => {
  if (features.tmdbConfigured) {
    const [, type, tmdbId] = titleId.split(':');
    if ((type !== 'movie' && type !== 'tv') || !tmdbId) return [];
    try {
      const { tmdbCast } = await import('./tmdb-catalog');
      return await withReadDeadline(tmdbCast({ id: titleId, type, slug: `${type}-${tmdbId}`, name: '', synopsis: '', releaseYear: 0, maturity: type === 'tv' ? 'TV-14' : 'PG-13', genres: [], tmdbId }), 3000);
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
});
