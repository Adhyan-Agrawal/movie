import { createHmac, timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TOKEN_TTL_MS = 4 * 60 * 60 * 1000;
const PLAYLIST_PROBE_BYTES = 1024;
const PLAYLIST_SIGNATURE = '#EXTM3U';
const TMDB_ID_RE = /^[1-9]\d{0,9}$/;
const MAX_STREAM_INDEX = 10;

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
  for (const [rawName, rawValue] of Object.entries(input)) {
    const name = rawName.toLowerCase();
    if (name !== 'referer' && name !== 'origin') continue;
    if (typeof rawValue !== 'string' || /[\r\n]/.test(rawValue)) continue;
    const value = rawValue.trim();
    try {
      if (new URL(value).protocol === 'https:') headers[name] = value;
    } catch {
      continue;
    }
  }
  return headers;
}

function isPlaylist(response: Response, url: string): boolean {
  const contentType = response.headers.get('content-type')?.toLowerCase();
  return Boolean(contentType?.includes('mpegurl') || contentType?.includes('m3u8') || /\.m3u8(?:$|[?#])/i.test(url));
}

function replayStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  buffered: Uint8Array[],
): ReadableStream<Uint8Array> {
  let bufferedIndex = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (bufferedIndex < buffered.length) {
        controller.enqueue(buffered[bufferedIndex++]!);
        return;
      }

      try {
        const result = await reader.read();
        if (result.done) controller.close();
        else controller.enqueue(result.value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

async function probePlaylist(body: ReadableStream<Uint8Array>): Promise<{
  body: ReadableStream<Uint8Array>;
  playlist: boolean;
  contentType?: string;
}> {
  const reader = body.getReader();
  const buffered: Uint8Array[] = [];
  const probe = new Uint8Array(PLAYLIST_PROBE_BYTES);
  let probeLength = 0;
  let playlist = false;

  while (probeLength < PLAYLIST_PROBE_BYTES) {
    const result = await reader.read();
    if (result.done) break;

    buffered.push(result.value);
    const copyLength = Math.min(result.value.byteLength, PLAYLIST_PROBE_BYTES - probeLength);
    probe.set(result.value.subarray(0, copyLength), probeLength);
    probeLength += copyLength;

    const prefix = new TextDecoder().decode(probe.subarray(0, probeLength)).replace(/^\uFEFF/, '').trimStart();
    if (prefix.startsWith(PLAYLIST_SIGNATURE)) {
      playlist = true;
      break;
    }
    if (probeLength >= PLAYLIST_SIGNATURE.length + 3 && prefix && !PLAYLIST_SIGNATURE.startsWith(prefix)) break;
  }

  const boxType = probeLength >= 8 ? new TextDecoder().decode(probe.subarray(4, 8)) : '';
  const contentType = probeLength >= 377 && probe[0] === 0x47 && probe[188] === 0x47 && probe[376] === 0x47
    ? 'video/mp2t'
    : ['ftyp', 'styp', 'moof'].includes(boxType) ? 'video/mp4' : undefined;
  return { body: replayStream(reader, buffered), playlist, contentType };
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

  const upstreamHeaders = new Headers(payload.headers);
  upstreamHeaders.set('Accept-Encoding', 'identity');
  for (const name of ['range', 'if-range']) {
    const value = request.headers.get(name);
    if (value !== null) upstreamHeaders.set(name, value);
  }

  let response = await fetch(payload.url, { headers: upstreamHeaders, cache: 'no-store', signal: request.signal });
  if (response.status === 416) {
    const headers = new Headers({ 'Cache-Control': 'private, no-store' });
    const contentRange = response.headers.get('content-range');
    if (contentRange) headers.set('Content-Range', contentRange);
    await response.body?.cancel();
    return new NextResponse(null, { status: 416, headers });
  }
  if (!response.ok || !response.body) return jsonError('Playback stream is unavailable.', 502);

  let sourceUrl = response.url || payload.url;
  let inspected = isPlaylist(response, sourceUrl)
    ? { body: response.body, playlist: true, contentType: undefined }
    : await probePlaylist(response.body);
  let completePlaylistFetched = false;

  // An opaque manifest's requested range may omit its signature entirely.
  if (request.headers.has('range') && !inspected.playlist && !inspected.contentType
    && !/^(?:audio|video|image)\//i.test(response.headers.get('content-type') ?? '')) {
    const fullHeaders = new Headers(upstreamHeaders);
    fullHeaders.delete('range');
    fullHeaders.delete('if-range');
    const fullResponse = await fetch(payload.url, { headers: fullHeaders, cache: 'no-store', signal: request.signal });
    if (fullResponse.ok && fullResponse.body) {
      const fullUrl = fullResponse.url || payload.url;
      const fullInspection = isPlaylist(fullResponse, fullUrl)
        ? { body: fullResponse.body, playlist: true, contentType: undefined }
        : await probePlaylist(fullResponse.body);
      if (fullInspection.playlist) {
        await inspected.body.cancel();
        response = fullResponse;
        sourceUrl = fullUrl;
        inspected = fullInspection;
        completePlaylistFetched = true;
      } else {
        inspected.contentType = fullInspection.contentType;
        await fullInspection.body.cancel();
      }
    } else {
      await fullResponse.body?.cancel();
    }
  }

  if (inspected.playlist) {
    // Rewriting changes byte offsets, so playlists must use their complete representation.
    let body = inspected.body;
    if (request.headers.has('range') && !completePlaylistFetched) {
      await body.cancel();
      upstreamHeaders.delete('range');
      upstreamHeaders.delete('if-range');
      response = await fetch(payload.url, { headers: upstreamHeaders, cache: 'no-store', signal: request.signal });
      if (!response.ok || !response.body) return jsonError('Playback stream is unavailable.', 502);
      sourceUrl = response.url || payload.url;
      body = response.body;
    }
    const playlist = rewritePlaylist(await new Response(body).text(), sourceUrl, payload.headers, secret);
    return new NextResponse(playlist, {
      headers: { 'Cache-Control': 'private, no-store', 'Content-Type': 'application/vnd.apple.mpegurl' },
      status: 200,
    });
  }

  const headers = new Headers({ 'Cache-Control': 'private, no-store' });
  for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
    // Fetch decodes compressed bodies; the upstream encoded length no longer applies.
    if (name === 'content-length' && response.headers.has('content-encoding')
      && response.headers.get('content-encoding')?.toLowerCase() !== 'identity') continue;
    const value = response.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  if (inspected.contentType) headers.set('Content-Type', inspected.contentType);
  return new NextResponse(inspected.body, { headers, status: response.status });
}

async function resolve(request: NextRequest, config: { baseUrl: URL; secret: string }): Promise<NextResponse> {
  const params = request.nextUrl.searchParams;
  const tmdbId = params.get('tmdbId');
  const type = params.get('type');
  const season = params.get('season');
  const episode = params.get('episode');
  const streamIndexRaw = params.get('stream') ?? '0';
  const streamIndex = Number(streamIndexRaw);
  if (!tmdbId || !TMDB_ID_RE.test(tmdbId) || (type !== 'movie' && type !== 'tv')) return jsonError('Invalid playback request.', 400);
  if (type === 'tv' && (!season || !episode || !/^\d{1,3}$/.test(season) || !/^\d{1,3}$/.test(episode))) {
    return jsonError('TV playback requires a numeric season and episode.', 400);
  }
  if (!Number.isInteger(streamIndex) || streamIndex < 0 || streamIndex > MAX_STREAM_INDEX) {
    return jsonError('Invalid playback stream.', 400);
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
  const streams = body.streams?.filter((candidate) => typeof candidate.url === 'string' && candidate.url.startsWith('https://')) ?? [];
  const stream = streams[streamIndex];
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
