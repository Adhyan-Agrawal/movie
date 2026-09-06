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

/** One `/tv/{id}/season/{n}` payload (trimmed to the fields we store). */
export interface TmdbSeasonDetail {
  id?: number;
  season_number?: number | null;
  episodes?: TmdbEpisodeEntry[];
}

export interface TmdbEpisodeEntry {
  id: number;
  episode_number: number;
  name: string | null;
  overview: string | null;
  air_date: string | null;
  runtime: number | null;
  still_path: string | null;
}

/** A `credits` append_to_response payload (trimmed to the cast we keep). */
export interface TmdbCredits {
  cast?: TmdbCastEntry[];
}

export interface TmdbCastEntry {
  id: number;
  name: string | null;
  character: string | null;
  known_for_department: string | null;
  profile_path: string | null;
  order: number | null;
}

/** A `videos` append_to_response payload (trimmed to the trailers we keep). */
export interface TmdbVideos {
  results?: TmdbVideoEntry[];
}

export interface TmdbVideoEntry {
  key: string | null;
  name: string | null;
  site: string | null;
  type: string | null;
  official: boolean | null;
}

/**
 * Pick the best official YouTube trailer URL from a `videos` payload, or null.
 * Preference: official Trailer > any Trailer > official Teaser > any Teaser.
 */
export function normalizeTrailer(videos: TmdbVideos | undefined): string | null {
  const results = (videos?.results ?? []).filter(
    (v) => v.site === 'YouTube' && typeof v.key === 'string' && v.key.length > 0,
  );
  const byType = (type: string) => {
    const official = results.find((v) => v.type === type && v.official);
    return official ?? results.find((v) => v.type === type);
  };
  const pick = byType('Trailer') ?? byType('Teaser');
  return pick?.key ? `https://www.youtube.com/watch?v=${pick.key}` : null;
}

/** Extract the YouTube video key (for embeds) from a watch URL, or null. */
export function youtubeKey(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = /[?&]v=([A-Za-z0-9_-]{6,20})/.exec(url);
  return m?.[1] ?? null;
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
  credits?: TmdbCredits;
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
  credits?: TmdbCredits;
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

/** Top-billed cast member, mapped to `people` + `title_people` rows. */
export interface NormalizedCastMember {
  tmdbId: number;
  name: string;
  character: string | null;
  profileUrl: string | null;
  knownFor: string | null;
  creditOrder: number;
}

/** One episode of one season, mapped to an `episodes` row. */
export interface NormalizedEpisode {
  seasonNumber: number;
  episodeNumber: number;
  name: string;
  overview: string;
  airDate: string | null;
  runtimeMinutes: number | null;
  stillUrl: string | null;
  tmdbId: number;
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
  /** Top-billed cast (movies and TV share TMDB's `credits` payload shape). */
  cast: NormalizedCastMember[];
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
    cast: normalizeCast(d.credits),
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
    cast: normalizeCast(d.credits),
  };
}

/** Cap on stored cast members per title — top-billed only (v1 has no crew). */
export const MAX_CAST_MEMBERS = 15;

/**
 * Normalize a TMDB `credits` payload into top-billed cast. Keeps the first
 * {@link MAX_CAST_MEMBERS} entries that are plausibly actors: TMDB credits can
 * include voice-only or in-memory-only entries with no profile art; a profile
 * path OR a known-for department of "Acting" filters the obvious non-actors
 * without dropping unphotographed guest cast.
 */
export function normalizeCast(
  credits: TmdbCredits | undefined,
  max = MAX_CAST_MEMBERS,
): NormalizedCastMember[] {
  return (credits?.cast ?? [])
    .filter((c) => c.id && c.name && (c.profile_path || c.known_for_department === 'Acting'))
    .slice(0, max)
    .map((c, i) => ({
      tmdbId: c.id,
      name: c.name as string,
      character: c.character || null,
      profileUrl: c.profile_path ? `${TMDB_IMG}/w185${c.profile_path}` : null,
      knownFor: c.known_for_department || null,
      creditOrder: typeof c.order === 'number' && c.order >= 0 ? c.order : i,
    }));
}

/**
 * Normalize a `/tv/{id}/season/{n}` payload into episode rows. Skips entries
 * without an id, a name, or a positive episode number (TMDB occasionally
 * returns placeholder rows for unaired episodes).
 */
export function normalizeEpisodes(season: TmdbSeasonDetail): NormalizedEpisode[] {
  return (season.episodes ?? [])
    .filter((e) => e.id && e.episode_number > 0 && e.name)
    .map((e) => ({
      seasonNumber: season.season_number ?? 0,
      episodeNumber: e.episode_number,
      name: e.name as string,
      overview: e.overview ?? '',
      airDate: e.air_date,
      runtimeMinutes: e.runtime ?? null,
      stillUrl: e.still_path ? `${TMDB_IMG}/w300${e.still_path}` : null,
      tmdbId: e.id,
    }));
}
