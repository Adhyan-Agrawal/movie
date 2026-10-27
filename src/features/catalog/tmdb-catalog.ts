import 'server-only';

import { cache } from 'react';
import { serverEnv } from '@/lib/env';
import { normalizeCast, normalizeEpisodes, normalizeMovie, normalizeTv, slugify, validYear, type TmdbCredits, type TmdbMovieDetail, type TmdbSeasonDetail, type TmdbTvDetail } from './tmdb-normalize';
import type { CastMember, Episode, Season, Title, TitleType } from './types';
import type { TitleFilters } from './queries';
import { normalizeCountryFilter, normalizeLanguageFilter, providerGenre } from './discovery';

type TmdbListItem = { id: number; title?: string; name?: string; original_title?: string; original_name?: string; original_language?: string | null; origin_country?: string[]; overview?: string; release_date?: string; first_air_date?: string; poster_path?: string | null; backdrop_path?: string | null; vote_average?: number; genre_ids?: number[] };
const IMAGE = 'https://image.tmdb.org/t/p';
const CACHE_SECONDS = 21_600;
// Only public provider requests are coalesced; Next owns the bounded-time cache.
const pendingRequests = new Map<string, Promise<unknown>>();
let activeRequests = 0;
const waitingRequests: Array<() => void> = [];

async function request<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const { TMDB_API_BASE_URL, TMDB_API_KEY } = serverEnv();
  if (!TMDB_API_KEY) throw new Error('TMDB_API_KEY is not configured.');
  const url = new URL(`${TMDB_API_BASE_URL}${path}`);
  url.searchParams.set('api_key', TMDB_API_KEY);
  url.searchParams.set('language', 'en-US');
  for (const [key, value] of Object.entries(params)) if (value) url.searchParams.set(key, value);
  const key = url.toString();
  const pending = pendingRequests.get(key);
  if (pending) return pending as Promise<T>;
  if (pendingRequests.size >= 48) throw new Error('TMDB public request queue is full');
  const read = (async () => {
    if (activeRequests >= 6) {
      await new Promise<void>((resolve, reject) => {
        const resume = () => { clearTimeout(timeout); resolve(); };
        const timeout = setTimeout(() => {
          const index = waitingRequests.indexOf(resume);
          if (index !== -1) waitingRequests.splice(index, 1);
          reject(new Error('TMDB request queue deadline exceeded'));
        }, 2500);
        waitingRequests.push(resume);
      });
    } else activeRequests++;
    try {
      const response = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(2500), next: { revalidate: CACHE_SECONDS } });
      if (!response.ok) throw new Error(`TMDB ${path} responded ${response.status}`);
      return await response.json() as T;
    } finally {
      const next = waitingRequests.shift();
      if (next) next();
      else activeRequests--;
    }
  })();
  pendingRequests.set(key, read);
  try { return await read; }
  finally { pendingRequests.delete(key); }
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

const genreNames = cache(async (type: TitleType): Promise<Map<number, string>> => {
  const data = await request<{ genres?: Array<{ id: number; name: string }> }>(`/genre/${type}/list`);
  return new Map((data.genres ?? []).map((genre) => [genre.id, genre.name]));
});

function listTitle(type: TitleType, item: TmdbListItem, genres: Map<number, string>): Title {
  const name = type === 'movie' ? item.title ?? '' : item.name ?? '';
  const date = type === 'movie' ? item.release_date : item.first_air_date;
  const originalName = type === 'movie' ? item.original_title : item.original_name;
  const originalLanguage = item.original_language && /^[a-z]{2}$/i.test(item.original_language) ? item.original_language.toLowerCase() : undefined;
  const originCountries = item.origin_country?.map(normalizeCountryFilter).filter((value): value is string => Boolean(value));
  return { id: `tmdb:${type}:${item.id}`, type, slug: `${slugify(name)}-${item.id}`, name, ...(originalName && originalName !== name ? { originalName } : {}), ...(originalLanguage ? { originalLanguage } : {}), ...(originCountries?.length ? { originCountries } : {}), synopsis: item.overview ?? '', releaseYear: validYear(date ?? null) ?? 0, maturity: type === 'tv' ? 'TV-14' : 'PG-13', genres: (item.genre_ids ?? []).map((id) => genres.get(id)).filter((name): name is string => Boolean(name)), ...(item.poster_path ? { posterUrl: `${IMAGE}/w500${item.poster_path}` } : {}), ...(item.backdrop_path ? { backdropUrl: `${IMAGE}/w1280${item.backdrop_path}` } : {}), ...(typeof item.vote_average === 'number' ? { score: Math.round(item.vote_average * 10) } : {}), tmdbId: String(item.id) };
}

export async function getTmdbTitle(type: TitleType, slug: string): Promise<Title | null> {
  const id = idFromSlug(slug);
  if (!id) return null;
  const append = type === 'movie' ? 'release_dates,external_ids,credits,videos' : 'content_ratings,external_ids,credits,videos';
  const data = await request<TmdbMovieDetail & TmdbTvDetail & { original_language?: string | null; origin_country?: string[]; production_countries?: Array<{ iso_3166_1: string }> }>(`/${type}/${id}`, { append_to_response: append });
  const normalized = type === 'movie' ? normalizeMovie(data) : normalizeTv(data);
  if (!normalized) return null;
  const title = fromNormalized(normalized);
  const originalLanguage = data.original_language && /^[a-z]{2}$/i.test(data.original_language) ? data.original_language.toLowerCase() : undefined;
  if (originalLanguage) title.originalLanguage = originalLanguage;
  const countries = (data.origin_country ?? data.production_countries?.map((country) => country.iso_3166_1))?.map(normalizeCountryFilter).filter((value): value is string => Boolean(value));
  if (countries?.length) title.originCountries = [...new Set(countries)];
  return title;
}

export async function listTmdbTitles(filters: TitleFilters = {}, page = 1, pageSize = 20): Promise<{ titles: Title[]; total: number }> {
  const types: TitleType[] = filters.type ? [filters.type] : ['movie', 'tv'];
  const language = normalizeLanguageFilter(filters.originalLanguage);
  const country = normalizeCountryFilter(filters.country);
  if ((filters.originalLanguage && !language) || (filters.country && !country)) return { titles: [], total: 0 };
  const languages = language?.split('|') ?? [''];
  const size = Math.min(48, Math.max(1, pageSize));
  const offset = (Math.max(1, page) - 1) * size;
  const groups = types.flatMap((type) => languages.map((originalLanguage) => ({ type, originalLanguage })));
  type ListResult = { results?: TmdbListItem[]; total_results?: number };
  const results = await Promise.all(groups.map(async ({ type, originalLanguage }) => {
    // TMDB TV discover has no certification filter. Never silently ignore one.
    if (filters.maturity && (type === 'tv' || !['G', 'PG', 'PG-13', 'R', 'NC-17'].includes(filters.maturity))) return { total: 0, load: async (_page: number): Promise<Title[]> => [] };
    const genres = await genreNames(type);
    const genreId = filters.genre && [...genres].find(([, name]) => name.toLowerCase() === providerGenre(filters.genre!, type).toLowerCase())?.[0];
    if (filters.genre && !genreId) return { total: 0, load: async (_page: number): Promise<Title[]> => [] };
    const date = type === 'movie' ? 'primary_release_date' : 'first_air_date';
    const sort = filters.sort === 'newest' ? `${date}.desc` : filters.sort === 'oldest' ? `${date}.asc` : filters.sort === 'score' ? 'vote_average.desc' : filters.sort === 'az' ? (type === 'movie' ? 'original_title.asc' : 'name.asc') : 'popularity.desc';
    const today = new Date().toISOString().slice(0, 10);
    const minYear = filters.year ?? filters.minYear;
    const maxYear = filters.year ?? filters.maxYear;
    const latest = maxYear ? `${maxYear}-12-31` : today;
    const params = { sort_by: sort, include_adult: 'false', ...(genreId ? { with_genres: String(genreId) } : {}), ...(originalLanguage ? { with_original_language: originalLanguage } : {}), ...(country ? { with_origin_country: country } : {}), ...(minYear ? { [`${date}.gte`]: `${minYear}-01-01` } : {}), [`${date}.lte`]: latest < today ? latest : today, ...(filters.sort === 'score' ? { 'vote_count.gte': '100' } : {}), ...(filters.maturity ? { certification_country: 'US', certification: filters.maturity } : {}) };
    const trending = (!filters.sort || filters.sort === 'trending') && !filters.genre && !language && !country && !minYear && !maxYear && !filters.maturity;
    const path = trending ? `/trending/${type}/week` : `/discover/${type}`;
    const first = await request<ListResult>(path, { ...params, page: '1' });
    const total = Math.min(first.total_results ?? 0, 10_000);
    const loaded = new Map<number, Promise<Title[]>>();
    const map = (data: ListResult) => (data.results ?? []).map((item) => listTitle(type, item, genres));
    loaded.set(1, Promise.resolve(map(first)));
    return { total, load: (providerPage: number) => {
      if (!loaded.has(providerPage)) loaded.set(providerPage, request<ListResult>(path, { ...params, page: String(providerPage) }).then(map));
      return loaded.get(providerPage)!;
    } };
  }));
  const total = results.reduce((sum, result) => sum + result.total, 0);
  if (offset >= total) return { titles: [], total };
  // Seek into the interleaved provider ranks, including exhausted/empty groups.
  let low = 0;
  let high = Math.max(...results.map((result) => result.total));
  const beforeRound = (round: number) => results.reduce((sum, result) => sum + Math.min(round, result.total), 0);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (beforeRound(middle) <= offset) low = middle; else high = middle - 1;
  }
  let skip = offset - beforeRound(low);
  const slots: Array<{ group: number; index: number }> = [];
  for (let round = low; slots.length < size && round < 10_000; round++) {
    for (let group = 0; group < results.length && slots.length < size; group++) {
      if (round >= results[group]!.total) continue;
      if (skip > 0) skip--; else slots.push({ group, index: round });
    }
    if (beforeRound(round + 1) >= total) break;
  }
  const titles = await Promise.all(slots.map(async ({ group, index }) => (await results[group]!.load(Math.floor(index / 20) + 1))[index % 20]));
  return { titles: titles.filter((title): title is Title => Boolean(title?.name)), total };
}

export async function searchTmdbTitles(query: string, filters: TitleFilters = {}): Promise<Title[]> {
  const groups = await Promise.all((filters.type ? [filters.type] : ['movie', 'tv'] as const).map(async (type) => {
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
