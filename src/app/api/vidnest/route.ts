import { createHmac, timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TOKEN_TTL_MS = 5 * 60 * 1000;
const TMDB_ID_RE = /^[1-9]\d{0,9}$/;

type StreamHeaders = Record<string, string>;
type ProxyPayload = { expiresAt: number; headers: StreamHeaders; url: string };

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status, headers: { 'Cache-Control': 'private, no-store' } });
}

function getApiConfig(): { baseUrl: URL; secret: string } | null {
  const secret = process.env.VIDNEST_API_SECRET;
  const rawUrl = process.env.VIDNEST_API_URL ?? 'https://vidnest-pi.vercel.app';
  if (!secret || secret.length < 32) return null;
  try {
    const baseUrl = new URL(rawUrl);
    return baseUrl.protocol === 'https:' ? { baseUrl, secret } : null;
  } catch {
    return null;
  }
}

function sign(value: string, secret: string): string {
  const key = createHmac('sha256', secret).update('vidnest-proxy').digest();
  return createHmac('sha256', key).update(value).digest('base64url');
}

function createToken(payload: ProxyPayload, secret: string): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encoded}.${sign(encoded, secret)}`;
}

function readToken(token: string, secret: string): ProxyPayload | null {
  const [encoded, signature] = token.split('.');
  if (!encoded || !signature) return null;
  const expected = Buffer.from(sign(encoded, secret));
  const received = Buffer.from(signature);
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return null;

  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as ProxyPayload;
    const url = new URL(payload.url);
    if (url.protocol !== 'https:' || payload.expiresAt < Date.now() || !payload.headers) return null;
    return payload;
  } catch {
    return null;
  }
}

function sanitizeHeaders(input: unknown): StreamHeaders {
  if (!input || typeof input !== 'object') return {};
  const headers: StreamHeaders = {};
  for (const name of ['referer', 'origin']) {
    const value = (input as Record<string, unknown>)[name];
    if (typeof value !== 'string') continue;
    try {
      if (new URL(value).protocol === 'https:') headers[name] = value;
    } catch {
      continue;
    }
  }
  return headers;
}

function isPlaylist(response: Response, url: string): boolean {
  return response.headers.get('content-type')?.toLowerCase().includes('mpegurl') || /\.m3u8(?:$|\?)/i.test(url);
}

function rewritePlaylist(playlist: string, sourceUrl: string, headers: StreamHeaders, secret: string): string {
  const proxyUrl = (value: string) => {
    try {
      const url = new URL(value, sourceUrl);
      if (url.protocol !== 'https:') return value;
      const token = createToken({ url: url.href, headers, expiresAt: Date.now() + TOKEN_TTL_MS }, secret);
      return `/api/vidnest?token=${encodeURIComponent(token)}`;
    } catch {
      return value;
    }
  };

  return playlist
    .split(/(\r?\n)/)
    .map((line) => {
      if (!line || line === '\n' || line === '\r\n') return line;
      if (!line.startsWith('#')) return proxyUrl(line);
      return line.replace(/URI="([^"]+)"/g, (_match, value: string) => `URI="${proxyUrl(value)}"`);
    })
    .join('');
}

async function proxy(request: NextRequest, token: string, secret: string): Promise<NextResponse> {
  const payload = readToken(token, secret);
  if (!payload) return jsonError('Invalid or expired playback token.', 403);

  const response = await fetch(payload.url, { headers: payload.headers, cache: 'no-store', signal: request.signal });
  if (!response.ok || !response.body) return jsonError('Playback stream is unavailable.', 502);

  if (isPlaylist(response, payload.url)) {
    const playlist = rewritePlaylist(await response.text(), payload.url, payload.headers, secret);
    return new NextResponse(playlist, {
      headers: { 'Cache-Control': 'private, no-store', 'Content-Type': 'application/vnd.apple.mpegurl' },
    });
  }

  const headers = new Headers({ 'Cache-Control': 'private, no-store' });
  const contentType = response.headers.get('content-type');
  const contentLength = response.headers.get('content-length');
  if (contentType) headers.set('Content-Type', contentType);
  if (contentLength) headers.set('Content-Length', contentLength);
  return new NextResponse(response.body, { headers, status: response.status });
}

async function resolve(request: NextRequest, config: { baseUrl: URL; secret: string }): Promise<NextResponse> {
  const params = request.nextUrl.searchParams;
  const tmdbId = params.get('tmdbId');
  const type = params.get('type');
  const season = params.get('season');
  const episode = params.get('episode');
  if (!tmdbId || !TMDB_ID_RE.test(tmdbId) || (type !== 'movie' && type !== 'tv')) return jsonError('Invalid playback request.', 400);
  if (type === 'tv' && (!season || !episode || !/^\d{1,3}$/.test(season) || !/^\d{1,3}$/.test(episode))) {
    return jsonError('TV playback requires a numeric season and episode.', 400);
  }

  const target = new URL('/api/resolve', config.baseUrl);
  target.searchParams.set('tmdbId', tmdbId);
  target.searchParams.set('type', type);
  if (type === 'tv') {
    target.searchParams.set('season', season!);
    target.searchParams.set('episode', episode!);
  }

  const response = await fetch(target, {
    headers: { Authorization: `Bearer ${config.secret}` },
    cache: 'no-store',
    signal: request.signal,
  });
  if (!response.ok) return jsonError('Playback source resolution failed.', 502);

  const body = await response.json() as { streams?: Array<{ url?: unknown; headers?: unknown }> };
  const stream = body.streams?.find((candidate) => typeof candidate.url === 'string' && candidate.url.startsWith('https://'));
  const streamUrl = stream?.url;
  if (typeof streamUrl !== 'string') return jsonError('No playback source is available.', 404);

  const token = createToken({
    url: streamUrl,
    headers: sanitizeHeaders(stream?.headers),
    expiresAt: Date.now() + TOKEN_TTL_MS,
  }, config.secret);
  return proxy(request, token, config.secret);
}

export async function GET(request: NextRequest) {
  const config = getApiConfig();
  if (!config) return jsonError('VidNest playback is not configured.', 503);

  try {
    const token = request.nextUrl.searchParams.get('token');
    return token ? await proxy(request, token, config.secret) : await resolve(request, config);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') return jsonError('Playback request timed out.', 504);
    return jsonError('Playback is temporarily unavailable.', 502);
  }
}
