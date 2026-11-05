import 'server-only';

import { cache } from 'react';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { serverEnv } from '@/lib/env';
import { normalizeCast, normalizeEpisodes, normalizeMovie, normalizeTv, slugify, tmdbImageUrl, validYear, type TmdbMovieDetail, type TmdbSeasonDetail, type TmdbTvDetail } from './tmdb-normalize';
import type { CastMember, Episode, Season, Title, TitleType } from './types';
import type { TitleFilters } from './queries';
import { normalizeCountryFilter, normalizeLanguageFilter, providerGenre } from './discovery';
import { PublicDataCache } from './public-data-cache';

type TmdbListItem = { id: number; title?: string | null; name?: string | null; original_title?: string | null; original_name?: string | null; original_language?: string | null; origin_country?: string[] | null; overview?: string | null; release_date?: string | null; first_air_date?: string | null; poster_path?: string | null; backdrop_path?: string | null; vote_average?: number | null; genre_ids?: number[] | null };
const CACHE_SECONDS = 21_600;
const LIST_CACHE_SECONDS = 3_600;
const SEARCH_CACHE_SECONDS = 600;
const REQUEST_TIMEOUT_MS = 6_000;
const publicData = new PublicDataCache<unknown>({
  maxEntries: 128,
  maxPending: 48,
  positiveTtlMs: CACHE_SECONDS * 1000,
  negativeTtlMs: 5 * 60 * 1000,
  staleTtlMs: 24 * 60 * 60 * 1000,
  negativeStaleTtlMs: 10 * 60 * 1000,
  errorRetryMs: 30 * 1000,
});
interface RequestState {
  activeRequests: number;
  waitingRequests: Array<{
    resume: (release: () => void) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>;
}
const localRequestState: RequestState = { activeRequests: 0, waitingRequests: [] };
const workerRequestStates = new WeakMap<object, RequestState>();

function requestState(): RequestState {
  if (!('WebSocketPair' in globalThis)) return localRequestState;
  const { ctx } = getCloudflareContext();
  let state = workerRequestStates.get(ctx);
  if (!state) {
    state = { activeRequests: 0, waitingRequests: [] };
    workerRequestStates.set(ctx, state);
  }
  return state;
}

function releaseRequestSlot(state: RequestState): void {
  const waiting = state.waitingRequests.shift();
  if (waiting) {
    clearTimeout(waiting.timeout);
    waiting.resume(() => releaseRequestSlot(state));
  } else {
    state.activeRequests--;
  }
}

async function acquireRequestSlot(state: RequestState): Promise<() => void> {
  if (state.activeRequests < 6) {
    state.activeRequests++;
    return () => releaseRequestSlot(state);
  }
  return new Promise((resume, reject) => {
    const waiting = {
      resume,
      timeout: setTimeout(() => {
        const index = state.waitingRequests.indexOf(waiting);
        if (index !== -1) state.waitingRequests.splice(index, 1);
        reject(new Error('TMDB request queue deadline exceeded'));
      }, REQUEST_TIMEOUT_MS),
    };
    state.waitingRequests.push(waiting);
  });
}

function cacheSeconds(path: string): number {
  if (path.startsWith('/search/')) return SEARCH_CACHE_SECONDS;
  if (path.startsWith('/discover/') || path.startsWith('/trending/')) return LIST_CACHE_SECONDS;
  return CACHE_SECONDS;
}

function cacheTags(path: string): string[] {
  const scope = path.split('/').filter(Boolean).slice(0, 2).join(':');
  return ['tmdb-public', `tmdb:${scope || 'root'}`];
}

function isNegativePayload(value: unknown): boolean {
  if (value === null) return true;
  if (!value || typeof value !== 'object') return false;
  const record = value as { results?: unknown; genres?: unknown };
  return (Array.isArray(record.results) && record.results.length === 0)
    || (Array.isArray(record.genres) && record.genres.length === 0);
}

function publicRequestKey(baseUrl: string, path: string, params: Record<string, string>): string {
  const query = new URLSearchParams({ language: 'en-US' });
  for (const key of Object.keys(params).sort()) if (params[key]) query.set(key, params[key]);
  return `${baseUrl.replace(/\/$/, '')}${path}?${query}`;
}

/** Test/invalidation hook; no resolved value or failed response survives a clear. */
export function clearTmdbPublicDataCache(): void {
  publicData.clear();
}

class TmdbRequestError extends Error {
  constructor(path: string, readonly status: number) {
    super(`TMDB ${path} responded ${status}`);
  }
}

function publicPayload(path: string, value: unknown): Record<string, unknown> {
  const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const rows = (value: unknown) => Array.isArray(value) ? value.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object' && !Array.isArray(row)) : [];
  const text = (value: unknown) => typeof value === 'string' ? value : null;
  const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  const data = record(value);
  const invalid = () => new Error(`TMDB ${path} returned an invalid payload`);
  if (data !== value || data.success === false) throw invalid();
  if (/^\/(search|discover|trending)\//.test(path) && !Array.isArray(data.results)) throw invalid();
  if (path.startsWith('/genre/')) {
    if (!Array.isArray(data.genres)) throw invalid();
    return { ...data, genres: rows(data.genres).filter((genre) => Number.isSafeInteger(genre.id) && typeof genre.name === 'string') };
  }
  const detail = /^\/(movie|tv)\/(\d+)$/.exec(path);
  if (!detail) return data;
  const name = data[detail[1] === 'movie' ? 'title' : 'name'];
  if (data.id !== Number(detail[2]) || !Number.isSafeInteger(data.id) || typeof name !== 'string' || !name.trim()) throw invalid();

  const normalized: Record<string, unknown> = { ...data, overview: text(data.overview) ?? '' };
  for (const field of ['original_title', 'original_name', 'original_language', 'release_date', 'first_air_date', 'poster_path', 'backdrop_path', 'imdb_id']) {
    normalized[field] = text(data[field]);
  }
  normalized.runtime = number(data.runtime);
  normalized.vote_average = number(data.vote_average) !== null && Number(data.vote_average) <= 10 ? data.vote_average : null;
  normalized.episode_run_time = Array.isArray(data.episode_run_time) ? data.episode_run_time.filter((runtime) => number(runtime) !== null) : [];
  normalized.genres = rows(data.genres).filter((genre) => Number.isSafeInteger(genre.id) && typeof genre.name === 'string' && genre.name.trim());
  normalized.origin_country = Array.isArray(data.origin_country) ? data.origin_country.filter((country) => typeof country === 'string') : undefined;
  normalized.production_countries = rows(data.production_countries).filter((country) => typeof country.iso_3166_1 === 'string');
  normalized.external_ids = { imdb_id: text(record(data.external_ids).imdb_id) };
  normalized.release_dates = { results: rows(record(data.release_dates).results).map((country) => ({
    iso_3166_1: text(country.iso_3166_1),
    release_dates: rows(country.release_dates).map((release) => ({ certification: text(release.certification) })),
  })) };
  normalized.content_ratings = { results: rows(record(data.content_ratings).results).map((country) => ({
    iso_3166_1: text(country.iso_3166_1), rating: text(country.rating),
  })) };
  normalized.credits = { cast: rows(record(data.credits).cast).filter((member) => Number.isSafeInteger(member.id) && typeof member.name === 'string').map((member) => ({
    ...member, character: text(member.character), profile_path: text(member.profile_path), known_for_department: text(member.known_for_department),
  })) };
  normalized.videos = { results: rows(record(data.videos).results).filter((video) => typeof video.key === 'string' && /^[A-Za-z0-9_-]+$/.test(video.key)) };
  normalized.seasons = rows(data.seasons).filter((season) => Number.isSafeInteger(season.season_number)).map((season) => ({
    ...season, name: text(season.name), overview: text(season.overview), air_date: text(season.air_date),
    poster_path: text(season.poster_path), episode_count: number(season.episode_count),
  }));
  return normalized;
}

async function request<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const { TMDB_API_BASE_URL, TMDB_API_KEY } = serverEnv();
  if (!TMDB_API_KEY) throw new Error('TMDB_API_KEY is not configured.');
  const url = new URL(`${TMDB_API_BASE_URL}${path}`);
  url.searchParams.set('api_key', TMDB_API_KEY);
  url.searchParams.set('language', 'en-US');
  for (const [key, value] of Object.entries(params)) if (value) url.searchParams.set(key, value);
  const key = publicRequestKey(TMDB_API_BASE_URL, path, params);
  const ttlSeconds = cacheSeconds(path);
  const state = requestState();
  return publicData.read(key, async () => {
    const release = await acquireRequestSlot(state);
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/json' },
        credentials: 'omit',
        redirect: 'manual',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        next: { revalidate: ttlSeconds, tags: cacheTags(path) },
      });
      if (!response.ok) throw new TmdbRequestError(path, response.status);
      return publicPayload(path, await response.json());
    } finally {
      release();
    }
  }, {
    scope: state,
    isNegative: isNegativePayload,
    positiveTtlMs: ttlSeconds * 1000,
  }) as Promise<T>;
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
  return Number.isSafeInteger(id) && id > 0 ? id : null;
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
  const posterUrl = tmdbImageUrl(item.poster_path, 'w500');
  const backdropUrl = tmdbImageUrl(item.backdrop_path, 'w1280');
  return { id: `tmdb:${type}:${item.id}`, type, slug: `${slugify(name)}-${item.id}`, name, ...(originalName && originalName !== name ? { originalName } : {}), ...(originalLanguage ? { originalLanguage } : {}), ...(originCountries?.length ? { originCountries } : {}), synopsis: item.overview ?? '', releaseYear: validYear(date ?? null) ?? 0, maturity: type === 'tv' ? 'TV-14' : 'PG-13', genres: (item.genre_ids ?? []).map((id) => genres.get(id)).filter((genre): genre is string => Boolean(genre)), ...(posterUrl ? { posterUrl } : {}), ...(backdropUrl ? { backdropUrl } : {}), ...(typeof item.vote_average === 'number' ? { score: Math.round(item.vote_average * 10) } : {}), tmdbId: String(item.id) };
}

type TmdbTitleDetail = TmdbMovieDetail & TmdbTvDetail & {
  original_language?: string | null;
  origin_country?: string[];
  production_countries?: Array<{ iso_3166_1: string }>;
};

function titleDetail(type: TitleType, id: string | number): Promise<TmdbTitleDetail> {
  const append = type === 'movie' ? 'release_dates,external_ids,credits,videos' : 'content_ratings,external_ids,credits,videos';
  return request<TmdbTitleDetail>(`/${type}/${id}`, { append_to_response: append });
}

export function getTmdbMovieMetadata(id: string): Promise<TmdbTitleDetail> {
  if (!/^[1-9]\d{0,9}$/.test(id)) return Promise.reject(new Error('Invalid movie identifier.'));
  return titleDetail('movie', id);
}

export function getTmdbShowMetadata(id: string): Promise<TmdbTitleDetail> {
  if (!/^[1-9]\d{0,9}$/.test(id)) return Promise.reject(new Error('Invalid series identifier.'));
  return titleDetail('tv', id);
}

export function getTmdbSeasonMetadata(id: string, season: number): Promise<TmdbSeasonDetail> {
  if (!/^[1-9]\d{0,9}$/.test(id) || !Number.isSafeInteger(season) || season < 0 || season > 999) {
    return Promise.reject(new Error('Invalid season identifier.'));
  }
  return request<TmdbSeasonDetail>(`/tv/${id}/season/${season}`);
}

export async function getTmdbTitle(type: TitleType, slug: string): Promise<Title | null> {
  const id = idFromSlug(slug);
  if (!id) return null;
  let data: TmdbTitleDetail;
  try {
    data = await titleDetail(type, id);
  } catch (error) {
    if (error instanceof TmdbRequestError && error.status === 404) return null;
    throw error;
  }
  const normalized = type === 'movie' ? normalizeMovie(data) : normalizeTv(data);
  // A confirmed title can legitimately have no synopsis. Keep its known listing
  // fields instead of turning missing optional text into a false not-found.
  const title = normalized ? fromNormalized(normalized) : listTitle(type, {
    ...data, genre_ids: data.genres.map((genre) => genre.id),
  }, new Map(data.genres.map((genre) => [genre.id, genre.name])));
  if (!normalized) {
    const runtime = type === 'movie' ? data.runtime : data.episode_run_time[0];
    if (runtime != null && runtime > 0) title.runtimeMinutes = runtime;
    const imdbId = data.imdb_id ?? data.external_ids?.imdb_id;
    if (imdbId) title.imdbId = imdbId;
  }
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
  const detail = await titleDetail('tv', title.tmdbId);
  return Promise.all((detail.seasons ?? []).filter((season) => season.season_number > 0).map(async (season) => {
    const data = await request<TmdbSeasonDetail>(`/tv/${title.tmdbId}/season/${season.season_number}`);
    const episodes = normalizeEpisodes(data).map((episode): Episode => ({ id: `tmdb:episode:${episode.tmdbId}`, seasonNumber: episode.seasonNumber, episodeNumber: episode.episodeNumber, name: episode.name, overview: episode.overview, airDate: episode.airDate, runtimeMinutes: episode.runtimeMinutes, stillUrl: episode.stillUrl }));
    return { id: `tmdb:season:${title.tmdbId}:${season.season_number}`, seasonNumber: season.season_number, name: season.name, overview: season.overview ?? '', airDate: season.air_date, episodeCount: season.episode_count, episodes };
  }));
}

export async function tmdbCast(title: Title): Promise<CastMember[]> {
  if (!title.tmdbId) return [];
  const detail = await titleDetail(title.type, title.tmdbId);
  return normalizeCast(detail.credits).map((member) => ({ personId: `tmdb:person:${member.tmdbId}`, name: member.name, character: member.character, profileUrl: member.profileUrl }));
}
