import { fetchHome as localHome, listTitles as localTitles, searchTitles as localSearch, getTitleBySlug as localTitle, listSeasons, listCast, type TitleQuery } from './api';
import type { CastMember, HomeData, MediaRow, Season, Title, TitleFilters, TitleType } from './types';
import { WEB_URL as BASE, webRuntimeConfig } from './runtime-config';

type TitleDetails = { title: Title | null; seasons: Season[]; cast: CastMember[] };
const publicCache = new Map<string, { expiresAt: number; value: Promise<unknown> }>();
const homeCache = new Map<string, { expiresAt: number; value: HomeData }>();
const HOME_TTL_MS = 30_000;
const MAX_HOME_ORIGINS = 3;
const MAX_HOME_CHARS = 256_000;
let homeGeneration = 0;
type PublicHome = { hero?: Title | null; heroTitles?: Title[]; rows: MediaRow[]; collections?: HomeData['collections'];
  signedIn?: boolean; continueWatching?: unknown[]; forYou?: unknown; degraded?: boolean };

export function isAccountCatalogId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

function pick<T extends object>(value: T, keys: readonly (keyof T)[]): T {
  return Object.fromEntries(keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]])) as T;
}

function publicTitle(title: Title): Title {
  if (!title || typeof title.id !== 'string' || (title.type !== 'movie' && title.type !== 'tv')
    || typeof title.slug !== 'string' || typeof title.name !== 'string' || !Array.isArray(title.genres)) {
    throw new Error('Invalid catalog title');
  }
  return pick(title, ['id', 'type', 'slug', 'name', 'originalName', 'originalLanguage', 'originCountries', 'synopsis',
    'releaseYear', 'runtimeMinutes', 'maturity', 'genres', 'posterUrl', 'backdropUrl', 'trailerUrl', 'score', 'tmdbId', 'imdbId']);
}

function publicFilters(filters: TitleFilters): TitleFilters {
  return pick(filters, ['type', 'genre', 'sort', 'originalLanguage', 'country']);
}

// Only successful public DTOs are cached. Authenticated legacy fallbacks stay outside this cache.
function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const existing = publicCache.get(key);
  if (existing && existing.expiresAt > Date.now()) return existing.value as Promise<T>;
  if (publicCache.size >= 64) publicCache.delete(publicCache.keys().next().value!);
  const entry = { expiresAt: Infinity, value: load().then((value) => {
    entry.expiresAt = Date.now() + 60_000;
    return value;
  }).catch((error) => {
    if (publicCache.get(key) === entry) publicCache.delete(key);
    throw error;
  }) };
  publicCache.set(key, entry);
  return entry.value;
}

async function catalog<T>(params: URLSearchParams, notFound?: T, options: { refresh?: boolean; onResponse?: (response: Response) => void } = {}): Promise<T> {
  if (!webRuntimeConfig.available) throw new Error('Catalog URL is unavailable');
  const base = new URL(BASE);
  if (base.username || base.password || !['https:', 'http:'].includes(base.protocol)) throw new Error('Invalid catalog base URL');
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => { controller.abort(); reject(new Error('Catalog timed out')); }, 8000);
  });
  try {
    return await Promise.race([deadline, (async () => {
      const response = await fetch(`${BASE}/api/catalog?${params.toString()}`, {
        method: 'GET', signal: controller.signal, credentials: 'omit', redirect: 'error',
        ...(options.refresh ? { cache: 'no-store' as const } : {}),
      });
      if (response.status === 404 && notFound !== undefined) return notFound;
      if (!response.ok) throw new Error('Catalog unavailable');
      options.onResponse?.(response);
      return await response.json() as T;
    })()]);
  } finally { clearTimeout(timeout); }
}

function publicShape(value: unknown, keys: readonly string[]): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every((key) => keys.includes(key));
}

function cacheableHome(home: PublicHome): boolean {
  const title = (value: Title) => publicShape(value, ['id', 'type', 'slug', 'name', 'originalName', 'originalLanguage', 'originCountries',
    'synopsis', 'releaseYear', 'runtimeMinutes', 'maturity', 'genres', 'posterUrl', 'backdropUrl', 'trailerUrl', 'score', 'tmdbId', 'imdbId'])
    && typeof value.tmdbId === 'string' && /^[1-9]\d{0,9}$/.test(value.tmdbId)
    && value.id === `tmdb:${value.type}:${value.tmdbId}` && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.slug) && value.slug.endsWith(`-${value.tmdbId}`)
    && typeof value.name === 'string' && !!value.name.trim() && typeof value.synopsis === 'string'
    && Number.isInteger(value.releaseYear) && value.releaseYear >= 0 && value.releaseYear <= 9999
    && ['G', 'PG', 'PG-13', 'R', 'NC-17', 'TV-MA', 'TV-14', 'TV-PG'].includes(value.maturity)
    && Array.isArray(value.genres) && value.genres.every((genre) => typeof genre === 'string')
    && (['originalName', 'originalLanguage', 'posterUrl', 'backdropUrl', 'trailerUrl', 'imdbId'] as const)
      .every((key) => value[key] === undefined || typeof value[key] === 'string')
    && (value.originCountries === undefined || (Array.isArray(value.originCountries) && value.originCountries.every((country) => typeof country === 'string' && /^[A-Z]{2}$/.test(country))))
    && (value.runtimeMinutes === undefined || (Number.isFinite(value.runtimeMinutes) && value.runtimeMinutes >= 0))
    && (value.score === undefined || (Number.isFinite(value.score) && value.score >= 0 && value.score <= 100));
  const filters = (value: TitleFilters) => publicShape(value, ['type', 'genre', 'sort', 'originalLanguage', 'country'])
    && Object.values(value).every((field) => typeof field === 'string');
  return publicShape(home, ['hero', 'heroTitles', 'rows', 'collections', 'signedIn', 'continueWatching', 'forYou', 'degraded'])
    && home.signedIn === false && home.degraded === false && home.forYou === null
    && Array.isArray(home.continueWatching) && home.continueWatching.length === 0
    && (home.hero === null || (home.hero !== undefined && title(home.hero)))
    && (home.heroTitles === undefined || (Array.isArray(home.heroTitles) && home.heroTitles.length <= 12 && home.heroTitles.every(title)))
    && home.rows.length <= 32 && home.rows.every((row) => publicShape(row, ['id', 'collectionId', 'heading', 'reason', 'href', 'filters', 'titles'])
      && typeof row.id === 'string' && typeof row.heading === 'string' && row.titles.length <= 100 && row.titles.every(title)
      && (['collectionId', 'reason', 'href'] as const).every((key) => row[key] === undefined || typeof row[key] === 'string')
      && (row.filters === undefined || filters(row.filters)))
    && (home.collections === undefined || (home.collections.length <= 32 && home.collections.every((collection) => publicShape(collection, ['id', 'label', 'href', 'filters'])
      && typeof collection.id === 'string' && typeof collection.label === 'string' && typeof collection.href === 'string' && filters(collection.filters))));
}

/** Fresh settled public data only. The legacy RLS fallback never enters this cache. */
export function getCachedHome(): HomeData | null {
  if (!webRuntimeConfig.available) return null;
  const now = Date.now();
  for (const [key, entry] of homeCache) if (entry.expiresAt <= now) homeCache.delete(key);
  const entry = homeCache.get(BASE);
  return entry ? JSON.parse(JSON.stringify(entry.value)) as HomeData : null;
}

export async function fetchHome(options: { refresh?: boolean } = {}): Promise<HomeData> {
  const cacheKey = BASE;
  if (!options.refresh) {
    const cached = getCachedHome();
    if (cached) return cached;
  } else {
    homeGeneration++;
    homeCache.delete(cacheKey);
  }
  const generation = homeGeneration;
  try {
    let publicResponse = false;
    const home = await catalog<PublicHome>(new URLSearchParams({ view: 'home' }), undefined, {
      refresh: options.refresh,
      onResponse: (response) => {
        const policy = response.headers.get('cache-control') ?? '';
        publicResponse = response.status === 200 && !response.redirected && !response.headers.has('set-cookie')
          && /^application\/json\b/i.test(response.headers.get('content-type') ?? '')
          && /(?:^|,)\s*public\s*(?:,|$)/i.test(policy) && !/(?:^|,)\s*(?:private|no-store)\b/i.test(policy)
          && !/(?:^|,)\s*(?:cookie|authorization|\*)\s*(?:,|$)/i.test(response.headers.get('vary') ?? '');
      },
    });
    if (!Array.isArray(home.rows) || home.signedIn || home.continueWatching?.length || home.forYou) throw new Error('Invalid public catalog');
    const data: HomeData = {
      hero: (home.heroTitles?.length ? home.heroTitles : home.hero ? [home.hero] : []).map(publicTitle),
      rows: home.rows.map((row) => ({ ...pick(row, ['id', 'collectionId', 'heading', 'reason', 'href']), titles: row.titles.map(publicTitle),
        ...(row.filters ? { filters: publicFilters(row.filters) } : {}) })),
      collections: (home.collections ?? []).map((collection) => ({ ...pick(collection, ['id', 'label', 'href']), filters: publicFilters(collection.filters) })),
    };
    if (publicResponse && generation === homeGeneration && cacheableHome(home)) {
      const serialized = JSON.stringify(data);
      if (serialized.length <= MAX_HOME_CHARS) {
        const now = Date.now();
        for (const [key, entry] of homeCache) if (entry.expiresAt <= now) homeCache.delete(key);
        homeCache.delete(cacheKey);
        if (homeCache.size >= MAX_HOME_ORIGINS) homeCache.delete(homeCache.keys().next().value!);
        homeCache.set(cacheKey, { expiresAt: now + HOME_TTL_MS, value: JSON.parse(serialized) as HomeData });
      }
    }
    return data;
  } catch { return localHome(); }
}

export async function listTitles(query: TitleQuery & { query?: string } = {}): Promise<Title[]> {
  const page = Math.min(100, Math.max(1, Math.floor(query.page ?? 1)));
  const limit = Math.min(100, Math.max(1, Math.floor(query.pageSize ?? 40)));
  const params = new URLSearchParams({ page: String(page), limit: String(limit) });
  for (const name of ['type', 'genre', 'sort', 'originalLanguage', 'country', 'query'] as const) if (query[name]) params.set(name, query[name]!);
  try {
    return await cached(`list:${params.toString()}`, async () => {
      const result = await catalog<{ titles: Title[] }>(params);
      if (!Array.isArray(result.titles)) throw new Error('Invalid catalog');
      return result.titles.map(publicTitle);
    });
  } catch (error) {
    // The legacy API cannot answer country or combined search filters honestly.
    if (query.country || (query.query && (query.genre || query.type || query.originalLanguage || query.sort || page !== 1))) throw error;
    return query.query ? localSearch(query.query, limit) : localTitles({ ...query, page, pageSize: limit });
  }
}

export async function searchTitles(query: string, limit = 40): Promise<Title[]> {
  const trimmed = query.trim();
  return trimmed ? listTitles({ query: trimmed, pageSize: limit }) : [];
}

export async function getTitleDetails(type: TitleType, slug: string): Promise<TitleDetails> {
  try {
    return await cached(`detail:${type}:${slug}`, async () => {
      const details = await catalog<TitleDetails>(new URLSearchParams({ type, slug }), { title: null, seasons: [], cast: [] });
      if (details.title === null) return { title: null, seasons: [], cast: [] };
      if (!Array.isArray(details.seasons) || !Array.isArray(details.cast)) throw new Error('Invalid catalog details');
      return { title: publicTitle(details.title),
        seasons: details.seasons.map((season) => ({ ...pick(season, ['id', 'seasonNumber', 'name', 'overview', 'airDate', 'episodeCount']),
          episodes: season.episodes.map((episode) => pick(episode, ['id', 'seasonNumber', 'episodeNumber', 'name', 'overview', 'airDate', 'runtimeMinutes', 'stillUrl'])) })),
        cast: details.cast.map((member) => pick(member, ['personId', 'name', 'character', 'profileUrl'])),
      };
    });
  } catch {
    const title = await localTitle(type, slug);
    const [seasons, cast] = title ? await Promise.all([type === 'tv' ? listSeasons(title.id) : Promise.resolve([]), listCast(title.id)]) : [[], []];
    return { title, seasons, cast };
  }
}

export async function getTitleBySlug(type: TitleType, slug: string): Promise<Title | null> {
  return (await getTitleDetails(type, slug)).title;
}
