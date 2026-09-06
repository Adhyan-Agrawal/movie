import 'server-only';

import { serverEnv } from '@/lib/env';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import {
  normalizeMovie,
  normalizeTv,
  slugify,
  type NormalizedTitle,
  type TmdbGenre,
  type TmdbListResult,
  type TmdbMovieDetail,
  type TmdbTvDetail,
} from './tmdb-normalize';

/**
 * TMDB catalog sync (Spec Sections 4, 7, 10).
 *
 * Imports real movies + TV series from TMDB into the live catalog, upserted
 * idempotently by natural keys. Two sources:
 *   - CHARTS: popular + top-rated lists per type.
 *   - DISCOVER: TMDB /discover with genre / year-range filters and deep
 *     pagination, so the admin can import any slice of the catalog (e.g. all
 *     horror movies from the 1980s), not just chart front pages.
 * Full details (external ids, genres, certifications, runtimes, artwork URLs)
 * are fetched per title; TV details also populate the `seasons` table.
 *
 * Writes go through the RLS-scoped server client as the signed-in
 * admin/editor — the caller MUST hold `catalog.create` (enforced by the server
 * action). The search-to-import path (`importTitlesForSearch`) is the one
 * exception: it runs for any searcher via the service client, because
 * anonymous users cannot hold catalog.create; it is capped and documented.
 *
 * Only PUBLIC TMDB metadata and TMDB-hosted artwork URLs are stored (allowed
 * with attribution under TMDB terms); no provider media is fetched or embedded
 * here (Spec Section 9 provider-authorization rule).
 */

export interface SyncResult {
  ok: boolean;
  /** Human-readable summary for the admin UI. */
  message: string;
  movies: number;
  series: number;
  seasons: number;
  genres: number;
  skipped: number;
  failed: number;
}

export interface SyncFilters {
  /** `charts` = popular + top-rated; `discover` = genre/year browsing. */
  source: 'charts' | 'discover';
  type: 'movie' | 'tv' | 'both';
  /** Genre NAME as shown in the UI (e.g. 'Horror'); resolved to a TMDB genre id. */
  genre?: string;
  yearFrom?: number;
  yearTo?: number;
  /** Discover/charts pages to walk — 20 titles per page per list. */
  pages: number;
}

const REQUEST_TIMEOUT_MS = 15_000;
/** Detail fetches run in small batches to be polite to the TMDB API. */
const DETAIL_CONCURRENCY = 8;

async function tmdbFetch(path: string, params: Record<string, string>): Promise<unknown> {
  const { TMDB_API_BASE_URL, TMDB_API_KEY } = serverEnv();
  if (!TMDB_API_KEY) {
    throw new Error('TMDB_API_KEY is not configured — set it in the environment to sync.');
  }
  const url = new URL(`${TMDB_API_BASE_URL}${path}`);
  url.searchParams.set('api_key', TMDB_API_KEY);
  for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v);

  const res = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`TMDB ${path} responded ${res.status}`);
  return res.json();
}

/** Run async work in fixed-size batches (throttled concurrency). */
async function mapBatch<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }
  return out;
}

/** TMDB genre list for one media type: [{ id, name }]. */
async function fetchTmdbGenres(kind: 'movie' | 'tv'): Promise<TmdbGenre[]> {
  const data = (await tmdbFetch(`/genre/${kind}/list`, {})) as { genres?: TmdbGenre[] };
  return data.genres ?? [];
}

/** Resolve a UI genre name (case-insensitive) to the TMDB genre id. */
async function resolveGenreId(genre: string, kinds: ('movie' | 'tv')[]): Promise<number | null> {
  const wanted = genre.trim().toLowerCase();
  for (const kind of kinds) {
    const genres = await fetchTmdbGenres(kind).catch(() => [] as TmdbGenre[]);
    const hit = genres.find((g) => g.name.toLowerCase() === wanted);
    if (hit) return hit.id;
  }
  return null;
}

/** Collect unique TMDB ids for one media type according to the filters. */
async function collectIds(
  kind: 'movie' | 'tv',
  filters: Pick<SyncFilters, 'source' | 'genre' | 'yearFrom' | 'yearTo' | 'pages'>,
  genreId: number | null,
): Promise<number[]> {
  const ids = new Set<number>();
  const yearKey = kind === 'movie' ? 'primary_release_date' : 'first_air_date';

  for (let page = 1; page <= filters.pages; page++) {
    const lists: string[] = [];
    if (filters.source === 'charts') {
      lists.push('popular', 'top_rated');
    } else {
      lists.push('discover');
    }

    for (const list of lists) {
      const params: Record<string, string> =
        list === 'discover'
          ? {
              page: String(page),
              sort_by: 'popularity.desc',
              include_adult: 'false',
              ...(genreId ? { with_genres: String(genreId) } : {}),
              ...(filters.yearFrom ? { [`${yearKey}.gte`]: `${filters.yearFrom}-01-01` } : {}),
              ...(filters.yearTo ? { [`${yearKey}.lte`]: `${filters.yearTo}-12-31` } : {}),
            }
          : { page: String(page), language: 'en-US' };
      try {
        const data = (await tmdbFetch(`/${kind}/${list}`, params)) as TmdbListResult;
        for (const r of data.results ?? []) ids.add(r.id);
      } catch (err) {
        console.warn(`catalog.sync: ${kind}/${list} page ${page} failed`, {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return [...ids];
}

async function fetchTitle(kind: 'movie' | 'tv', id: number): Promise<NormalizedTitle | null> {
  const append = kind === 'movie' ? 'release_dates,external_ids' : 'content_ratings,external_ids';
  const detail = (await tmdbFetch(`/${kind}/${id}`, {
    append_to_response: append,
    language: 'en-US',
  })) as TmdbMovieDetail & TmdbTvDetail;
  return kind === 'movie' ? normalizeMovie(detail) : normalizeTv(detail);
}

/** Shared import: upsert normalized titles (+ genre links + TV seasons). */
async function upsertTitles(titles: NormalizedTitle[]): Promise<SyncResult['seasons']> {
  if (titles.length === 0) return 0;
  const db = await getSupabaseServerClient();
  return upsertTitlesWith(db, titles);
}

async function upsertTitlesWith(
  db: Awaited<ReturnType<typeof getSupabaseServerClient>> | import('@/lib/supabase/service').SupabaseServiceClient,
  titles: NormalizedTitle[],
): Promise<SyncResult['seasons']> {
  if (titles.length === 0) return 0;
  const now = new Date().toISOString();

  // Genres (upsert by slug).
  const genreNames = [...new Set(titles.flatMap((t) => t.genres))].sort();
  if (genreNames.length) {
    const genreRows = genreNames.map((name) => ({ slug: slugify(name), name }));
    const { error: genreErr } = await db.from('genres').upsert(genreRows, { onConflict: 'slug' });
    if (genreErr) throw new Error(`genres upsert failed: ${genreErr.message}`);
  }
  const { data: genres, error: genreSelErr } = await db.from('genres').select('id, slug');
  if (genreSelErr) throw new Error(`genres read failed: ${genreSelErr.message}`);
  const genreId = new Map((genres ?? []).map((g) => [g.slug, g.id]));

  // Titles (upsert by slug, published + public).
  const titleRows = titles.map((t) => ({
    type: t.type,
    tmdb_id: t.tmdbId,
    imdb_id: t.imdbId,
    slug: t.slug,
    name: t.name,
    original_name: t.originalName,
    synopsis: t.synopsis,
    release_year: t.releaseYear,
    runtime_minutes: t.runtimeMinutes,
    maturity: t.maturity,
    original_language: t.originalLanguage,
    poster_url: t.posterUrl,
    backdrop_url: t.backdropUrl,
    editorial_score: t.score,
    status: 'published' as const,
    visibility: 'public' as const,
    published_at: now,
  }));
  const { error: titleErr } = await db.from('titles').upsert(titleRows, { onConflict: 'slug' });
  if (titleErr) throw new Error(`titles upsert failed: ${titleErr.message}`);
  const { data: dbTitles, error: titleSelErr } = await db.from('titles').select('id, slug');
  if (titleSelErr) throw new Error(`titles read failed: ${titleSelErr.message}`);
  const titleId = new Map((dbTitles ?? []).map((t) => [t.slug, t.id]));

  // Genre links.
  const joinRows = titles.flatMap((t) => {
    const tid = titleId.get(t.slug);
    return tid
      ? t.genres.flatMap((g) => {
          const gid = genreId.get(slugify(g));
          return gid ? [{ title_id: tid, genre_id: gid }] : [];
        })
      : [];
  });
  if (joinRows.length) {
    const { error: joinErr } = await db
      .from('title_genres')
      .upsert(joinRows, { onConflict: 'title_id,genre_id' });
    if (joinErr) throw new Error(`title_genres upsert failed: ${joinErr.message}`);
  }

  // Seasons for TV.
  const seasonRows = titles.flatMap((t) => {
    const tid = titleId.get(t.slug);
    return tid
      ? t.seasons.map((s) => ({
          title_id: tid,
          season_number: s.seasonNumber,
          name: s.name,
          overview: s.overview,
          air_date: s.airDate,
          poster_url: s.posterUrl,
          episode_count: s.episodeCount,
        }))
      : [];
  });
  if (seasonRows.length) {
    const { error: seasonErr } = await db
      .from('seasons')
      .upsert(seasonRows, { onConflict: 'title_id,season_number' });
    if (seasonErr) throw new Error(`seasons upsert failed: ${seasonErr.message}`);
  }
  return seasonRows.length;
}

/**
 * Sync the catalog from TMDB. Throws on total TMDB unreachability so the action
 * can surface an honest error (e.g. networks/ISPs that block TMDB).
 */
export async function syncCatalogFromTmdb(filters: SyncFilters): Promise<SyncResult> {
  const kinds: ('movie' | 'tv')[] =
    filters.type === 'both' ? ['movie', 'tv'] : [filters.type];
  const genreId = filters.genre && filters.source === 'discover' ? await resolveGenreId(filters.genre, kinds) : null;
  if (filters.genre && filters.source === 'discover' && genreId === null) {
    throw new Error(`Genre "${filters.genre}" was not found on TMDB.`);
  }

  const idLists = await Promise.all(kinds.map((kind) => collectIds(kind, filters, genreId)));
  const pairs = idLists.flatMap((ids, i) => ids.map((id) => ({ kind: kinds[i]!, id })));
  if (pairs.length === 0) {
    throw new Error(
      'TMDB returned no titles for these filters — check the server network connection to api.themoviedb.org.',
    );
  }

  const titles = (
    await mapBatch(pairs, DETAIL_CONCURRENCY, ({ kind, id }) =>
      fetchTitle(kind, id).catch(() => null),
    )
  ).filter((t): t is NormalizedTitle => t !== null);

  const seasons = await upsertTitles(titles);
  const movies = titles.filter((t) => t.type === 'movie').length;
  const series = titles.filter((t) => t.type === 'tv').length;
  const scope =
    filters.source === 'discover'
      ? `${filters.type === 'both' ? 'movies and series' : filters.type === 'movie' ? 'movies' : 'series'}` +
        `${filters.genre ? ` · ${filters.genre}` : ''}` +
        `${filters.yearFrom || filters.yearTo ? ` · ${filters.yearFrom ?? '…'}–${filters.yearTo ?? '…'}` : ''}`
      : 'charts';

  return {
    ok: true,
    message: `Synced ${movies} movies and ${series} series (${scope}).`,
    movies,
    series,
    seasons,
    genres: new Set(titles.flatMap((t) => t.genres)).size,
    skipped: 0,
    failed: pairs.length - titles.length,
  };
}

/**
 * Search-to-import (Spec Section 4: search-to-title). When a user searches for
 * something the local catalog doesn't have, query TMDB, import the top matches
 * (full details), and return them alongside local results. Runs via the service
 * client because searchers are not catalog editors; the import is capped at
 * `maxImports` titles per query.
 */
export async function importTitlesForSearch(
  query: string,
  maxImports = 6,
): Promise<NormalizedTitle[]> {
  const q = query.trim();
  if (!q) return [];

  const results = await Promise.all(
    (['movie', 'tv'] as const).map((kind) =>
      tmdbFetch(`/search/${kind}`, { query: q, include_adult: 'false', language: 'en-US' }).catch(
        () => null,
      ),
    ),
  );

  const ids: { kind: 'movie' | 'tv'; id: number }[] = [];
  for (const [i, r] of results.entries()) {
    const kind = i === 0 ? 'movie' : 'tv';
    for (const item of ((r as TmdbListResult | null)?.results ?? []).slice(0, maxImports)) {
      ids.push({ kind, id: item.id });
    }
  }
  if (ids.length === 0) return [];

  const titles = (
    await mapBatch(ids.slice(0, maxImports * 2), DETAIL_CONCURRENCY, ({ kind, id }) =>
      fetchTitle(kind, id).catch(() => null),
    )
  ).filter((t): t is NormalizedTitle => t !== null);

  if (titles.length) {
    // Service client: searchers are not catalog editors, so RLS would reject
    // anonymous imports. This is the documented search-to-title cache path —
    // capped per query, metadata only.
    const { getSupabaseServiceClient } = await import('@/lib/supabase/service');
    await upsertTitlesWith(getSupabaseServiceClient(), titles);
  }
  return titles;
}
