import 'server-only';

import { serverEnv } from '@/lib/env';
import { normalizeCast, normalizeEpisodes, normalizeMovie, normalizeTv, slugify, validYear, type TmdbCredits, type TmdbMovieDetail, type TmdbSeasonDetail, type TmdbTvDetail } from './tmdb-normalize';
import type { CastMember, Episode, Season, Title, TitleType } from './types';
import type { TitleFilters } from './queries';

type TmdbListItem = { id: number; title?: string; name?: string; overview?: string; release_date?: string; first_air_date?: string; poster_path?: string | null; backdrop_path?: string | null; vote_average?: number; genre_ids?: number[] };
const IMAGE = 'https://image.tmdb.org/t/p';
const CACHE_SECONDS = 21_600;

async function request<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const { TMDB_API_BASE_URL, TMDB_API_KEY } = serverEnv();
  if (!TMDB_API_KEY) throw new Error('TMDB_API_KEY is not configured.');
  const url = new URL(`${TMDB_API_BASE_URL}${path}`);
  url.searchParams.set('api_key', TMDB_API_KEY);
  url.searchParams.set('language', 'en-US');
  for (const [key, value] of Object.entries(params)) if (value) url.searchParams.set(key, value);
  const response = await fetch(url, { headers: { accept: 'application/json' }, next: { revalidate: CACHE_SECONDS } });
  if (!response.ok) throw new Error(`TMDB ${path} responded ${response.status}`);
  return response.json() as Promise<T>;
}

function maturity(value: string): Title['maturity'] {
  return (['G', 'PG', 'PG-13', 'R', 'NC-17', 'TV-MA', 'TV-14', 'TV-PG'] as const).includes(value as never)
    ? value as Title['maturity']
    : 'PG-13';
}

function fromNormalized(value: NonNullable<ReturnType<typeof normalizeMovie>>): Title {
  return { id: `tmdb:${value.type}:${value.tmdbId}`, type: value.type, slug: value.slug, name: value.name, ...(value.originalName ? { originalName: value.originalName } : {}), synopsis: value.synopsis, releaseYear: value.releaseYear ?? 0, ...(value.runtimeMinutes != null ? { runtimeMinutes: value.runtimeMinutes } : {}), maturity: maturity(value.maturity), genres: value.genres, ...(value.posterUrl ? { posterUrl: value.posterUrl } : {}), ...(value.backdropUrl ? { backdropUrl: value.backdropUrl } : {}), ...(value.trailerUrl ? { trailerUrl: value.trailerUrl } : {}), ...(value.score != null ? { score: value.score } : {}), tmdbId: String(value.tmdbId), ...(value.imdbId ? { imdbId: value.imdbId } : {}) };
}

function idFromSlug(slug: string): number | null {
  const id = Number(/-(\d+)$/.exec(slug)?.[1]);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function genreNames(type: TitleType): Promise<Map<number, string>> {
  const data = await request<{ genres?: Array<{ id: number; name: string }> }>(`/genre/${type}/list`);
  return new Map((data.genres ?? []).map((genre) => [genre.id, genre.name]));
}

function listTitle(type: TitleType, item: TmdbListItem, genres: Map<number, string>): Title {
  const name = type === 'movie' ? item.title ?? '' : item.name ?? '';
  const date = type === 'movie' ? item.release_date : item.first_air_date;
  return { id: `tmdb:${type}:${item.id}`, type, slug: `${slugify(name)}-${item.id}`, name, synopsis: item.overview ?? '', releaseYear: validYear(date ?? null) ?? 0, maturity: type === 'tv' ? 'TV-14' : 'PG-13', genres: (item.genre_ids ?? []).map((id) => genres.get(id)).filter((name): name is string => Boolean(name)), ...(item.poster_path ? { posterUrl: `${IMAGE}/w500${item.poster_path}` } : {}), ...(item.backdrop_path ? { backdropUrl: `${IMAGE}/w1280${item.backdrop_path}` } : {}), ...(typeof item.vote_average === 'number' ? { score: Math.round(item.vote_average * 10) } : {}), tmdbId: String(item.id) };
}

export async function getTmdbTitle(type: TitleType, slug: string): Promise<Title | null> {
  const id = idFromSlug(slug);
  if (!id) return null;
  const append = type === 'movie' ? 'release_dates,external_ids,credits,videos' : 'content_ratings,external_ids,credits,videos';
  const data = await request<TmdbMovieDetail & TmdbTvDetail>(`/${type}/${id}`, { append_to_response: append });
  const normalized = type === 'movie' ? normalizeMovie(data) : normalizeTv(data);
  return normalized ? fromNormalized(normalized) : null;
}

export async function listTmdbTitles(filters: TitleFilters = {}, page = 1): Promise<{ titles: Title[]; total: number }> {
  const types: TitleType[] = filters.type ? [filters.type] : ['movie', 'tv'];
  const results = await Promise.all(types.map(async (type) => {
    const genres = await genreNames(type);
    const genreId = filters.genre && [...genres].find(([, name]) => name.toLowerCase() === filters.genre!.toLowerCase())?.[0];
    const date = type === 'movie' ? 'primary_release_date' : 'first_air_date';
    const sort = filters.sort === 'newest' ? `${date}.desc` : filters.sort === 'oldest' ? `${date}.asc` : filters.sort === 'score' ? 'vote_average.desc' : 'popularity.desc';
    const data = await request<{ results?: TmdbListItem[]; total_results?: number }>(`/discover/${type}`, { page: String(page), sort_by: sort, include_adult: 'false', ...(genreId ? { with_genres: String(genreId) } : {}), ...(filters.minYear ? { [`${date}.gte`]: `${filters.minYear}-01-01` } : {}), ...(filters.maxYear ? { [`${date}.lte`]: `${filters.maxYear}-12-31` } : {}) });
    return { titles: (data.results ?? []).map((item) => listTitle(type, item, genres)), total: data.total_results ?? 0 };
  }));
  return { titles: results.flatMap((result) => result.titles), total: results.reduce((sum, result) => sum + result.total, 0) };
}

export async function searchTmdbTitles(query: string): Promise<Title[]> {
  const groups = await Promise.all((['movie', 'tv'] as const).map(async (type) => {
    const [genres, data] = await Promise.all([genreNames(type), request<{ results?: TmdbListItem[] }>(`/search/${type}`, { query, include_adult: 'false' })]);
    return (data.results ?? []).map((item) => listTitle(type, item, genres));
  }));
  return groups.flat().slice(0, 24);
}

export async function listTmdbGenres(): Promise<string[]> {
  const maps = await Promise.all([genreNames('movie'), genreNames('tv')]);
  return [...new Set(maps.flatMap((map) => [...map.values()]))].sort((a, b) => a.localeCompare(b));
}

export async function tmdbSeasons(title: Title): Promise<Season[]> {
  if (title.type !== 'tv' || !title.tmdbId) return [];
  const detail = await request<TmdbTvDetail>(`/tv/${title.tmdbId}`);
  return Promise.all((detail.seasons ?? []).filter((season) => season.season_number > 0).map(async (season) => {
    const data = await request<TmdbSeasonDetail>(`/tv/${title.tmdbId}/season/${season.season_number}`);
    const episodes = normalizeEpisodes(data).map((episode): Episode => ({ id: `tmdb:episode:${episode.tmdbId}`, seasonNumber: episode.seasonNumber, episodeNumber: episode.episodeNumber, name: episode.name, overview: episode.overview, airDate: episode.airDate, runtimeMinutes: episode.runtimeMinutes, stillUrl: episode.stillUrl }));
    return { id: `tmdb:season:${title.tmdbId}:${season.season_number}`, seasonNumber: season.season_number, name: season.name, overview: season.overview ?? '', airDate: season.air_date, episodeCount: season.episode_count, episodes };
  }));
}

export async function tmdbCast(title: Title): Promise<CastMember[]> {
  if (!title.tmdbId) return [];
  const data = await request<TmdbCredits>(`/${title.type}/${title.tmdbId}/credits`);
  return normalizeCast(data).map((member) => ({ personId: `tmdb:person:${member.tmdbId}`, name: member.name, character: member.character, profileUrl: member.profileUrl }));
}
