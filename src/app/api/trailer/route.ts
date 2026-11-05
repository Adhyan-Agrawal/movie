import { NextRequest, NextResponse } from 'next/server';
import { getTmdbMovieMetadata, getTmdbShowMetadata } from '@/features/catalog/tmdb-catalog';
import { resolveTrailer } from '@/features/trailers/resolver';
import { validImdbId, type TrailerInfo } from '@/features/trailers/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function response(trailer: TrailerInfo | null, status = 200) {
  const ttl = trailer ? Math.min(300, Math.floor((trailer.expiresAt - Date.now()) / 1000)) : 0;
  return NextResponse.json({ trailer }, { status, headers: {
    'Cache-Control': ttl > 0 ? `public, max-age=${ttl}, s-maxage=${ttl}` : 'no-store',
    'X-Content-Type-Options': 'nosniff',
  } });
}

export async function GET(request: NextRequest) {
  if (request.signal.aborted) return response(null);
  const params = request.nextUrl.searchParams;
  if ([...params.keys()].some((key) => !['imdbId', 'tmdbId', 'type'].includes(key))
    || [...params.keys()].some((key) => params.getAll(key).length !== 1)) return response(null, 400);
  let imdbId = params.get('imdbId');
  const tmdbId = params.get('tmdbId');
  const type = params.get('type');
  if (imdbId !== null && tmdbId !== null) return response(null, 400);
  if (imdbId !== null ? !validImdbId(imdbId)
    : !tmdbId || !/^[1-9]\d{0,9}$/.test(tmdbId) || (type !== 'movie' && type !== 'tv')) return response(null, 400);
  if (type !== null && type !== 'movie' && type !== 'tv') return response(null, 400);
  try {
    if (!imdbId) {
      const metadata = type === 'movie' ? await getTmdbMovieMetadata(tmdbId!) : await getTmdbShowMetadata(tmdbId!);
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return response(null);
      const externalId = metadata.imdb_id ?? metadata.external_ids?.imdb_id;
      if (metadata.id !== Number(tmdbId) || !validImdbId(externalId)) return response(null);
      imdbId = externalId;
    }
    const trailer = await resolveTrailer(imdbId, request.signal);
    return response(trailer);
  } catch { return response(null); }
}
