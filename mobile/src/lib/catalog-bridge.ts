import { fetchHome as localHome, listTitles as localTitles, getTitleBySlug as localTitle, listSeasons, listCast, type TitleQuery } from './api';
import type { CastMember, HomeData, Season, Title, TitleType } from './types';

const BASE = (process.env.EXPO_PUBLIC_WEB_URL ?? 'https://hulkofyt.eu.org').replace(/\/$/, '');
const detailCache = new Map<string, { expiresAt: number; value: Promise<{ title: Title | null; seasons: Season[]; cast: CastMember[] }> }>();

async function catalog<T>(params: URLSearchParams): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`${BASE}/api/catalog?${params.toString()}`, { signal: controller.signal, credentials: 'omit' });
    if (!response.ok) throw new Error('Catalog unavailable');
    return await response.json() as T;
  } finally { clearTimeout(timeout); }
}

export async function fetchHome(): Promise<HomeData> {
  try {
    const home = await catalog<{ hero?: Title | null; heroTitles?: Title[]; rows: HomeData['rows']; collections?: HomeData['collections'] }>(new URLSearchParams({ view: 'home' }));
    if (!Array.isArray(home.rows)) throw new Error('Invalid catalog');
    return { hero: home.heroTitles?.length ? home.heroTitles : home.hero ? [home.hero] : [], rows: home.rows, ...(home.collections ? { collections: home.collections } : {}) };
  } catch { return localHome(); }
}

export async function listTitles(query: TitleQuery & { query?: string } = {}): Promise<Title[]> {
  const params = new URLSearchParams({ page: String(query.page ?? 1), limit: String(Math.min(100, query.pageSize ?? 40)) });
  for (const name of ['type', 'genre', 'sort', 'originalLanguage', 'country', 'query'] as const) if (query[name]) params.set(name, query[name]!);
  try {
    const result = await catalog<{ titles: Title[] }>(params);
    if (!Array.isArray(result.titles)) throw new Error('Invalid catalog');
    return result.titles;
  } catch { return localTitles(query); }
}

export async function searchTitles(query: string): Promise<Title[]> {
  return listTitles({ query, pageSize: 40 });
}

export function getTitleDetails(type: TitleType, slug: string): Promise<{ title: Title | null; seasons: Season[]; cast: CastMember[] }> {
  const key = `${type}:${slug}`;
  const existing = detailCache.get(key);
  if (existing && existing.expiresAt > Date.now()) return existing.value;
  if (detailCache.size >= 64) detailCache.delete(detailCache.keys().next().value!);
  const value = catalog<{ title: Title | null; seasons: Season[]; cast: CastMember[] }>(new URLSearchParams({ type, slug })).catch(async () => {
    const title = await localTitle(type, slug);
    const [seasons, cast] = title ? await Promise.all([type === 'tv' ? listSeasons(title.id) : Promise.resolve([]), listCast(title.id)]) : [[], []];
    return { title, seasons, cast };
  });
  detailCache.set(key, { expiresAt: Date.now() + 60_000, value });
  return value;
}

export async function getTitleBySlug(type: TitleType, slug: string): Promise<Title | null> {
  return (await getTitleDetails(type, slug)).title;
}
