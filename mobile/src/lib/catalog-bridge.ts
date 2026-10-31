import { fetchHome as localHome, listTitles as localTitles, searchTitles as localSearch, getTitleBySlug as localTitle, listSeasons, listCast, type TitleQuery } from './api';
import type { CastMember, HomeData, MediaRow, Season, Title, TitleFilters, TitleType } from './types';

const BASE = (process.env.EXPO_PUBLIC_WEB_URL ?? 'https://hulkofyt.eu.org').replace(/\/$/, '');
type TitleDetails = { title: Title | null; seasons: Season[]; cast: CastMember[] };
const publicCache = new Map<string, { expiresAt: number; value: Promise<unknown> }>();

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

async function catalog<T>(params: URLSearchParams, notFound?: T): Promise<T> {
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
      });
      if (response.status === 404 && notFound !== undefined) return notFound;
      if (!response.ok) throw new Error('Catalog unavailable');
      return await response.json() as T;
    })()]);
  } finally { clearTimeout(timeout); }
}

export async function fetchHome(): Promise<HomeData> {
  try {
    const home = await catalog<{ hero?: Title | null; heroTitles?: Title[]; rows: MediaRow[]; collections?: HomeData['collections'];
      signedIn?: boolean; continueWatching?: unknown[]; forYou?: unknown }>(new URLSearchParams({ view: 'home' }));
    if (!Array.isArray(home.rows) || home.signedIn || home.continueWatching?.length || home.forYou) throw new Error('Invalid public catalog');
    return {
      hero: (home.heroTitles?.length ? home.heroTitles : home.hero ? [home.hero] : []).map(publicTitle),
      rows: home.rows.map((row) => ({ ...pick(row, ['id', 'collectionId', 'heading', 'reason', 'href']), titles: row.titles.map(publicTitle),
        ...(row.filters ? { filters: publicFilters(row.filters) } : {}) })),
      collections: (home.collections ?? []).map((collection) => ({ ...pick(collection, ['id', 'label', 'href']), filters: publicFilters(collection.filters) })),
    };
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
