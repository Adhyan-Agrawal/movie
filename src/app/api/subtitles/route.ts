import { createHmac } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import {
  normalizeSubtitleCatalog,
  readSubtitleToken,
  tracksWithTokens,
  type SubtitleTrack,
} from '@/features/player/wyzie-subtitles';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CATALOG_TTL_MS = 10 * 60 * 1000;
const VTT_CACHE_TTL_MS = 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_CACHE_ENTRIES = 128;
const MAX_VTT_BYTES = 2 * 1024 * 1024;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const TMDB_ID_RE = /^[1-9]\d{0,9}$/;
const SEASON_RE = /^(?:0|[1-9]\d{0,2})$/;
const EPISODE_RE = /^[1-9]\d{0,2}$/;

type CatalogRequest = { tmdbId: number; type: 'movie' | 'tv'; season?: number; episode?: number };
type CacheEntry = { expiresAt: number; promise: Promise<SubtitleTrack[]> };
type WyzieModule = typeof import('wyzie-lib');

const catalogCache = new Map<string, CacheEntry>();
const vttCache = new Map<string, { expiresAt: number; promise: Promise<string> }>();
const rateBuckets = new Map<string, { count: number; resetAt: number }>();
let configuredKey: string | undefined;

function privateHeaders(contentType?: string): HeadersInit {
  return {
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    ...(contentType ? { 'Content-Type': contentType } : {}),
  };
}

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: privateHeaders() });
}

function rateLimited(request: NextRequest, kind: 'catalog' | 'download', secret: string): boolean {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const address = forwarded || request.headers.get('x-real-ip')?.trim() || 'unknown';
  const identity = createHmac('sha256', secret).update(address).digest('base64url');
  const key = `${kind}:${identity}`;
  const now = Date.now();
  for (const [entryKey, bucket] of rateBuckets) if (bucket.resetAt <= now) rateBuckets.delete(entryKey);
  const bucket = rateBuckets.get(key);
  const limit = kind === 'catalog' ? 30 : 120;
  if (!bucket) {
    if (rateBuckets.size >= 2048) rateBuckets.delete(rateBuckets.keys().next().value!);
    rateBuckets.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  bucket.count += 1;
  return bucket.count > limit;
}

function parseCatalogRequest(params: URLSearchParams): CatalogRequest | null {
  const tmdbId = params.get('tmdbId');
  const type = params.get('type');
  const season = params.get('season');
  const episode = params.get('episode');
  if (!tmdbId || !TMDB_ID_RE.test(tmdbId) || (type !== 'movie' && type !== 'tv')) return null;

  if (type === 'movie') {
    if ((season !== null && season !== '') || (episode !== null && episode !== '')) return null;
    return { tmdbId: Number(tmdbId), type };
  }

  if (!season || !episode || !SEASON_RE.test(season) || !EPISODE_RE.test(episode)) return null;
  return { tmdbId: Number(tmdbId), type, season: Number(season), episode: Number(episode) };
}

async function withTimeout<T>(run: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new DOMException('Request timed out.', 'AbortError')), REQUEST_TIMEOUT_MS);
  });
  try {
    return await Promise.race([run(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fetchVtt(wyzie: WyzieModule, sourceUrl: string): Promise<string> {
  const url = new URL(wyzie.withDownloadOptions(sourceUrl, { to: 'vtt' }));
  if (url.protocol !== 'https:' || url.hostname !== 'sub.wyzie.io' || url.username || url.password) {
    throw new Error('Invalid subtitle download URL.');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
    if (!response.ok || !response.body || Number(response.headers.get('content-length')) > MAX_VTT_BYTES) {
      void response.body?.cancel();
      throw new Error('Subtitle download failed.');
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > MAX_VTT_BYTES) {
        void reader.cancel();
        throw new Error('Subtitle response is too large.');
      }
      chunks.push(result.value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const vtt = new TextDecoder().decode(bytes).replace(/^\uFEFF/, '');
    if (!/^WEBVTT(?:[ \t]|\r?\n|$)/.test(vtt)) throw new Error('Invalid subtitle response.');
    return `${vtt.trim()}\n\n`;
  } finally {
    clearTimeout(timer);
  }
}

function configureWyzie(wyzie: WyzieModule, apiKey: string): void {
  if (configuredKey === apiKey) return;
  wyzie.configure({ key: apiKey });
  configuredKey = apiKey;
}

function cacheKey(request: CatalogRequest): string {
  return request.type === 'movie'
    ? `movie:${request.tmdbId}`
    : `tv:${request.tmdbId}:${request.season}:${request.episode}`;
}

function cachedCatalog(key: string, load: () => Promise<SubtitleTrack[]>): Promise<SubtitleTrack[]> {
  const now = Date.now();
  for (const [entryKey, entry] of catalogCache) if (entry.expiresAt <= now) catalogCache.delete(entryKey);
  const existing = catalogCache.get(key);
  if (existing) return existing.promise;
  if (catalogCache.size >= MAX_CACHE_ENTRIES) catalogCache.delete(catalogCache.keys().next().value!);

  const entry: CacheEntry = { expiresAt: now + CATALOG_TTL_MS, promise: Promise.resolve().then(load) };
  catalogCache.set(key, entry);
  void entry.promise.catch(() => {
    if (catalogCache.get(key) === entry) catalogCache.delete(key);
  });
  return entry.promise;
}

function cachedVtt(key: string, load: () => Promise<string>): Promise<string> {
  const now = Date.now();
  for (const [entryKey, entry] of vttCache) if (entry.expiresAt <= now) vttCache.delete(entryKey);
  const existing = vttCache.get(key);
  if (existing) return existing.promise;
  if (vttCache.size >= MAX_CACHE_ENTRIES) vttCache.delete(vttCache.keys().next().value!);
  const entry = { expiresAt: now + VTT_CACHE_TTL_MS, promise: Promise.resolve().then(load) };
  vttCache.set(key, entry);
  void entry.promise.catch(() => { if (vttCache.get(key) === entry) vttCache.delete(key); });
  return entry.promise;
}

function catalogErrorCode(error: unknown, wyzie: WyzieModule): string {
  if (error instanceof wyzie.WyzieError) {
    if (error.status === 429) return 'rate_limited';
    if (error.status === 401 || error.status === 403) return 'not_authorized';
    if (error.status === 503) return 'provider_unavailable';
  }
  if (error instanceof Error && error.name === 'AbortError') return 'provider_timeout';
  return 'provider_error';
}

async function catalog(request: CatalogRequest, apiKey: string, tokenSecret: string): Promise<NextResponse> {
  const wyzie = await import('wyzie-lib');
  configureWyzie(wyzie, apiKey);
  try {
    const tracks = await cachedCatalog(cacheKey(request), async () => {
      const params: import('wyzie-lib').SearchSubtitlesParams = request.type === 'tv' ? {
        tmdb_id: request.tmdbId, season: request.season!, episode: request.episode!,
        source: 'all',
        limit: 200,
        sort: 'downloads',
      } : { tmdb_id: request.tmdbId, source: 'all', limit: 200, sort: 'downloads' };
      const results = await withTimeout(() => wyzie.searchSubtitles(params));
      return tracksWithTokens(normalizeSubtitleCatalog(results), tokenSecret);
    });
    return json({ tracks, configured: true, available: true });
  } catch (error) {
    return json({ tracks: [], configured: true, available: false, code: catalogErrorCode(error, wyzie) });
  }
}

async function download(token: string, apiKey: string, tokenSecret: string): Promise<NextResponse> {
  const payload = readSubtitleToken(token, tokenSecret);
  if (!payload) return json({ error: 'Invalid or expired subtitle token.' }, 403);

  try {
    const wyzie = await import('wyzie-lib');
    configureWyzie(wyzie, apiKey);
    const vtt = await cachedVtt(token, () => fetchVtt(wyzie, payload.url));
    return new NextResponse(vtt, { status: 200, headers: {
      ...privateHeaders('text/vtt; charset=utf-8'),
      'Access-Control-Allow-Origin': '*',
    } });
  } catch {
    return json({ error: 'Subtitle is temporarily unavailable.' }, 502);
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const apiKey = process.env.WYZIE_API_KEY?.trim();
  if (!apiKey) return json({ tracks: [], configured: false });
  const tokenSecret = process.env.WYZIE_SUBTITLE_TOKEN_SECRET?.trim() || apiKey;

  const token = request.nextUrl.searchParams.get('token');
  if (token) {
    if (rateLimited(request, 'download', tokenSecret)) return json({ error: 'Too many subtitle requests.' }, 429);
    return download(token, apiKey, tokenSecret);
  }

  const catalogRequest = parseCatalogRequest(request.nextUrl.searchParams);
  if (!catalogRequest) return json({ error: 'Invalid subtitle request.' }, 400);
  if (rateLimited(request, 'catalog', tokenSecret)) return json({ tracks: [], configured: true, available: false, code: 'rate_limited' }, 429);
  return catalog(catalogRequest, apiKey, tokenSecret);
}
