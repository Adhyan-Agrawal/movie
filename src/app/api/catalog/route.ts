import { NextRequest, NextResponse } from 'next/server';
import { getHomeData } from '@/features/catalog/data';
import { getTitleBySlug, listCastForTitle, listSeasonsForTitle, listTitlesPage, type TitleFilters } from '@/features/catalog/queries';
import { normalizeCountryFilter, normalizeLanguageFilter } from '@/features/catalog/discovery';

export const dynamic = 'force-dynamic';
const HEADERS = { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300' };

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  if (params.get('view') === 'home') return NextResponse.json(await getHomeData({ personalize: false }), { headers: HEADERS });
  const type = params.get('type');
  const slug = params.get('slug');
  if (slug !== null) {
    if ((type !== 'movie' && type !== 'tv') || !slug || slug.length > 200) return NextResponse.json({ title: null }, { status: 400, headers: HEADERS });
    const title = await getTitleBySlug(type, slug);
    if (!title) return NextResponse.json({ title: null, seasons: [], cast: [] }, { status: 404, headers: HEADERS });
    const [seasons, cast] = await Promise.all([type === 'tv' ? listSeasonsForTitle(title.id).catch(() => []) : Promise.resolve([]), listCastForTitle(title.id).catch(() => [])]);
    return NextResponse.json({ title, seasons, cast }, { headers: HEADERS });
  }
  const sort = params.get('sort');
  const language = params.get('originalLanguage');
  const country = params.get('country');
  const limit = Number(params.get('limit') ?? 24);
  const page = Number(params.get('page') ?? 1);
  if ((type && type !== 'movie' && type !== 'tv') || (sort && !['trending', 'newest', 'oldest', 'az', 'score'].includes(sort))
    || !Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(page) || page < 1 || page > 100
    || (language && !normalizeLanguageFilter(language)) || (country && !normalizeCountryFilter(country))) {
    return NextResponse.json({ titles: [], error: 'Invalid catalog filters.' }, { status: 400, headers: HEADERS });
  }
  const filters: TitleFilters = {
    ...(type ? { type: type as 'movie' | 'tv' } : {}), ...(sort ? { sort: sort as 'trending' | 'newest' | 'oldest' | 'az' | 'score' } : {}),
    ...(language ? { originalLanguage: normalizeLanguageFilter(language)! } : {}), ...(country ? { country: normalizeCountryFilter(country)! } : {}),
    ...(params.get('genre') ? { genre: params.get('genre')!.slice(0, 100) } : {}),
    ...(params.get('query') ? { query: params.get('query')!.slice(0, 200) } : {}),
  };
  return NextResponse.json(await listTitlesPage(filters, page, limit), { headers: HEADERS });
}
