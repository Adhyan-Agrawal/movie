/**
 * Pure TMDB → Lumora normalization (no I/O). Extracted from `./tmdb-sync` so it
 * can be unit-tested without network access or the server-only guard — TMDB's
 * API may be unreachable from a given network, so the payload mapping is
 * verified with fixtures instead (tests/unit/tmdb-normalize.test.ts).
 */

const TMDB_IMG = 'https://image.tmdb.org/t/p';

export interface TmdbListResult {
  id: number;
  page?: number;
  results?: { id: number }[];
}

export interface TmdbGenre {
  id: number;
  name: string;
}

export interface TmdbSeason {
  season_number: number;
  name: string | null;
  overview: string | null;
  air_date: string | null;
  poster_path: string | null;
  episode_count: number | null;
}

export interface TmdbMovieDetail {
  id: number;
  imdb_id: string | null;
  title: string;
  original_title: string | null;
  overview: string;
  release_date: string | null;
  runtime: number | null;
  original_language: string | null;
  poster_path: string | null;
  backdrop_path: string | null;
  vote_average: number | null;
  genres: TmdbGenre[];
  release_dates?: { results?: { iso_3166_1: string; release_dates?: { certification: string }[] }[] };
  external_ids?: { imdb_id: string | null };
}

export interface TmdbTvDetail {
  id: number;
  external_ids?: { imdb_id: string | null };
  name: string;
  original_name: string | null;
  overview: string;
  first_air_date: string | null;
  episode_run_time: number[];
  original_language: string | null;
  poster_path: string | null;
  backdrop_path: string | null;
  vote_average: number | null;
  genres: TmdbGenre[];
  content_ratings?: { results?: { iso_3166_1: string; rating: string }[] };
  seasons?: TmdbSeason[];
}

export interface NormalizedSeason {
  titleId: string;
  seasonNumber: number;
  name: string | null;
  overview: string;
  airDate: string | null;
  posterUrl: string | null;
  episodeCount: number | null;
}

export interface NormalizedTitle {
  type: 'movie' | 'tv';
  tmdbId: number;
  imdbId: string | null;
  slug: string;
  name: string;
  originalName: string | null;
  synopsis: string;
  releaseYear: number | null;
  runtimeMinutes: number | null;
  maturity: string;
  originalLanguage: string;
  posterUrl: string | null;
  backdropUrl: string | null;
  score: number | null;
  genres: string[];
  seasons: Omit<NormalizedSeason, 'titleId'>[];
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

export function validYear(date: string | null): number | null {
  if (!date) return null;
  const year = Number(date.slice(0, 4));
  return Number.isInteger(year) && year >= 1878 && year <= 2100 ? year : null;
}

function isHttpUrl(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^https?:\/\//.test(value);
}

/** The UI's placeholder convention: gradient strings, not image URLs. */
export function posterSrc(posterUrl: string | null | undefined): string | null {
  return isHttpUrl(posterUrl) ? posterUrl : null;
}

/** Normalize a TMDB movie detail payload; null when it lacks title/overview. */
export function normalizeMovie(d: TmdbMovieDetail): NormalizedTitle | null {
  if (!d.title || !d.overview) return null;
  const us = (d.release_dates?.results ?? []).find((r) => r.iso_3166_1 === 'US');
  const cert = us?.release_dates?.find((x) => x.certification)?.certification;
  return {
    type: 'movie',
    tmdbId: d.id,
    imdbId: d.imdb_id ?? d.external_ids?.imdb_id ?? null,
    slug: `${slugify(d.title)}-${d.id}`,
    name: d.title,
    originalName: d.original_title && d.original_title !== d.title ? d.original_title : null,
    synopsis: d.overview,
    releaseYear: validYear(d.release_date),
    runtimeMinutes: d.runtime ?? null,
    maturity: cert || 'NR',
    originalLanguage: d.original_language || 'en',
    posterUrl: d.poster_path ? `${TMDB_IMG}/w500${d.poster_path}` : null,
    backdropUrl: d.backdrop_path ? `${TMDB_IMG}/w1280${d.backdrop_path}` : null,
    score: typeof d.vote_average === 'number' ? Math.round(d.vote_average * 10) : null,
    genres: (d.genres ?? []).map((g) => g.name),
    seasons: [],
  };
}

/** Normalize a TMDB TV detail payload; null when it lacks name/overview. */
export function normalizeTv(d: TmdbTvDetail): NormalizedTitle | null {
  if (!d.name || !d.overview) return null;
  const us = (d.content_ratings?.results ?? []).find((r) => r.iso_3166_1 === 'US');
  const runtime = d.episode_run_time?.[0] ?? null;
  return {
    type: 'tv',
    tmdbId: d.id,
    imdbId: d.external_ids?.imdb_id ?? null,
    slug: `${slugify(d.name)}-${d.id}`,
    name: d.name,
    originalName: d.original_name && d.original_name !== d.name ? d.original_name : null,
    synopsis: d.overview,
    releaseYear: validYear(d.first_air_date),
    runtimeMinutes: runtime ?? null,
    maturity: us?.rating || 'NR',
    originalLanguage: d.original_language || 'en',
    posterUrl: d.poster_path ? `${TMDB_IMG}/w500${d.poster_path}` : null,
    backdropUrl: d.backdrop_path ? `${TMDB_IMG}/w1280${d.backdrop_path}` : null,
    score: typeof d.vote_average === 'number' ? Math.round(d.vote_average * 10) : null,
    genres: (d.genres ?? []).map((g) => g.name),
    seasons: (d.seasons ?? [])
      .filter((s) => s.season_number > 0)
      .map((s) => ({
        seasonNumber: s.season_number,
        name: s.name,
        overview: s.overview ?? '',
        airDate: s.air_date,
        posterUrl: s.poster_path ? `${TMDB_IMG}/w500${s.poster_path}` : null,
        episodeCount: s.episode_count,
      })),
  };
}
