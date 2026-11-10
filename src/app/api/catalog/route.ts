import { NextRequest, NextResponse } from 'next/server';
import { getPublicHomeData } from '@/features/catalog/data';
import { getTitleBySlug, listCastForTitle, listSeasonsForTitle, listTitlesPage, type TitleFilters } from '@/features/catalog/queries';
import { normalizeCountryFilter, normalizeLanguageFilter } from '@/features/catalog/discovery';
import { features } from '@/lib/env';
import { withPublicCatalogCache } from '@/features/catalog/edge-cache';

export const dynamic = 'force-dynamic';
const HEADERS = { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300' };
const NO_STORE = { 'Cache-Control': 'private, no-store' };

export async function GET(request: NextRequest) {
  try {
    return await withPublicCatalogCache(request, () => readCatalog(request));
  } catch {
    return NextResponse.json({ error: 'Catalog unavailable.' }, { status: 503, headers: NO_STORE });
  }
}

async function readCatalog(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  if (params.get('view') === 'home') {
    const home = await getPublicHomeData();
     const cacheable = features.tmdbConfigured && !home.degraded && Boolean(home.hero)
       && !home.signedIn && home.forYou === null && home.continueWatching.length === 0
       && [home.hero!, ...home.heroTitles, ...home.rows.flatMap((row) => row.titles)].every((title) => /^tmdb:(movie|tv):[1-9][0-9]{0,9}$/.test(title.id));
     return NextResponse.json(home, { headers: cacheable ? HEADERS : NO_STORE });
  }
  const type = params.get('type');
  const slug = params.get('slug');
  if (slug !== null) {
    if ((type !== 'movie' && type !== 'tv') || !slug || slug.length > 200) return NextResponse.json({ title: null }, { status: 400, headers: NO_STORE });
    const title = await getTitleBySlug(type, slug);
    if (!title) return NextResponse.json({ title: null, seasons: [], cast: [] }, { status: 404, headers: NO_STORE });
    const [seasons, cast] = await Promise.all([type === 'tv' ? listSeasonsForTitle(title.id).catch(() => []) : Promise.resolve([]), listCastForTitle(title.id).catch(() => [])]);
    const cacheable = /^tmdb-[1-9][0-9]{0,9}$/.test(slug) && /^tmdb:(movie|tv):[1-9][0-9]{0,9}$/.test(title.id);
    return NextResponse.json({ title, seasons, cast }, { headers: cacheable ? HEADERS : NO_STORE });
  }
  const sort = params.get('sort');
  const language = params.get('originalLanguage');
  const country = params.get('country');
  const limit = Number(params.get('limit') ?? 24);
  const page = Number(params.get('page') ?? 1);
  if ((type && type !== 'movie' && type !== 'tv') || (sort && !['trending', 'newest', 'oldest', 'az', 'score'].includes(sort))
    || !Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(page) || page < 1 || page > 100
    || (language && !normalizeLanguageFilter(language)) || (country && !normalizeCountryFilter(country))) {
    return NextResponse.json({ titles: [], error: 'Invalid catalog filters.' }, { status: 400, headers: NO_STORE });
  }
  const filters: TitleFilters = {
    ...(type ? { type: type as 'movie' | 'tv' } : {}), ...(sort ? { sort: sort as 'trending' | 'newest' | 'oldest' | 'az' | 'score' } : {}),
    ...(language ? { originalLanguage: normalizeLanguageFilter(language)! } : {}), ...(country ? { country: normalizeCountryFilter(country)! } : {}),
    ...(params.get('genre') ? { genre: params.get('genre')!.slice(0, 100) } : {}),
    ...(params.get('query') ? { query: params.get('query')!.slice(0, 200) } : {}),
  };
  const result = await listTitlesPage(filters, page, limit);
  const cacheable = features.tmdbConfigured && result.titles.length > 0
    && result.titles.every((title) => /^tmdb:(movie|tv):[1-9][0-9]{0,9}$/.test(title.id));
  return NextResponse.json(result, { headers: cacheable ? HEADERS : NO_STORE });
}
