import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { NextRequest, NextResponse } from 'next/server';
import { selectHlsRendition } from '@/lib/providers/hls-rendition';
import { decodedAudioTracks, hasHlsPlaybackUri, hlsStartupPlan, httpsUrl, metadataLabel, metadataLanguage, parseHlsMetadata, parseMp4AudioLanguages } from '@/lib/providers/hls-metadata';
import { parseMpegTsAudioLanguages } from '@/lib/providers/mpeg-ts-metadata';
import type { DirectStream, Track } from '@/lib/providers/types';
import { isPrivateOrLoopbackHost } from '@/lib/validation/source';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TOKEN_TTL_MS = 4 * 60 * 60 * 1000;
const TOKEN_VERSION = 'v1';
const TOKEN_CONTEXT = 'vidnest-proxy:aes-256-gcm:v1';
const PLAYLIST_PROBE_BYTES = 1024;
const PLAYLIST_SIGNATURE = '#EXTM3U';
const STARTUP_PROBE_BYTES = 1024;
const STARTUP_METADATA_BYTES = 256 * 1024;
const INIT_METADATA_BYTES = 64 * 1024;
const TMDB_ID_RE = /^[1-9]\d{0,9}$/;
const RESOLVER_TTL_MS = 60_000;
const CATALOG_TTL_MS = 30_000;
const RESOLVER_TIMEOUT_MS = 10_000;
const MANIFEST_TIMEOUT_MS = 4_000;
const CATALOG_BUDGET_MS = 12_000;
const MANIFEST_MAX_BYTES = 1024 * 1024;
const RESOLVER_MAX_BYTES = 1024 * 1024;
const PROBE_CONCURRENCY = 4;
const MAX_CACHE_ENTRIES = 128;
const RECEIVER_CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Range',
  'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Range, Content-Length, Content-Type, ETag, X-Vidnest-Stream-Id',
};

type StreamHeaders = Record<string, string>;
type ProxyPayload = { expiresAt: number; headers: StreamHeaders; url: string };
type GatewaySubtitle = Track & { headers: StreamHeaders };
type ResolvedStream = { url: string; headers: StreamHeaders; subtitles: GatewaySubtitle[]; audioLanguage: string };
type CacheEntry<T> = { expiresAt: number; promise: Promise<T> };
type PlaybackManifest = { index: number; playlist: string; sourceUrl: string; order: number };
type HealthyStartup = Omit<PlaybackManifest, 'order'> & { latencyMs: number };
type CatalogProbe = {
  firstHealthy: Promise<HealthyStartup | undefined>; complete: Promise<DirectStream[]>;
  best?: HealthyStartup; fallback?: PlaybackManifest;
};
const resolverCache = new Map<string, CacheEntry<ResolvedStream[]>>();
const catalogCache = new Map<string, CacheEntry<CatalogProbe>>();

function cached<T>(cache: Map<string, CacheEntry<T>>, key: string, ttl: number, load: () => Promise<T>): Promise<T> {
  const now = Date.now();
  for (const [entryKey, entry] of cache) if (entry.expiresAt <= now) cache.delete(entryKey);
  const existing = cache.get(key);
  if (existing) return existing.promise;
  if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
  const entry: CacheEntry<T> = { expiresAt: now + ttl, promise: Promise.resolve().then(load) };
  cache.set(key, entry);
  void entry.promise.catch(() => { if (cache.get(key) === entry) cache.delete(key); });
  return entry.promise;
}

async function withTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout>;
  const expired = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new DOMException('Request timed out.', 'AbortError'));
    }, ms);
  });
  try {
    return await Promise.race([run(controller.signal), expired]);
  } finally {
    clearTimeout(timeout!);
  }
}

async function boundedText(response: Response, maxBytes: number, signal?: AbortSignal): Promise<string> {
  if (!response.body) return '';
  if (Number(response.headers.get('content-length')) > maxBytes) {
    void response.body.cancel();
    throw new Error('Response exceeds size limit.');
  }
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener('abort', cancel, { once: true });
  let total = 0;
  const decoder = new TextDecoder();
  let text = '';
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException('Request timed out.', 'AbortError');
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maxBytes) throw new Error('Response exceeds size limit.');
      text += decoder.decode(result.value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    cancel();
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

async function verifyStartupBytes(
  resource: { url: string; offset: number; length?: number }, headers: StreamHeaders, signal: AbortSignal,
  options: { decodeAudio: boolean; init?: boolean },
  useRange = true,
): Promise<{ verified: boolean; audioLanguages: string[] }> {
  const maxBytes = options.decodeAudio ? options.init ? INIT_METADATA_BYTES : STARTUP_METADATA_BYTES : STARTUP_PROBE_BYTES;
  const limit = Math.min(maxBytes, resource.length ?? maxBytes);
  const response = await startupFetch(resource.url, {
    headers: { ...headers, 'Accept-Encoding': 'identity', ...(useRange ? { Range: `bytes=${resource.offset}-${resource.offset + limit - 1}` } : {}) },
    cache: 'no-store', signal,
  });
  const rangeStart = /^bytes (\d+)-\d+\/(?:\d+|\*)$/.exec(response.headers.get('content-range') ?? '');
  if (!response.ok || !response.body || !httpsUrl(response.url || resource.url)
    || (resource.offset > 0 && response.status !== 206)
    || (response.status === 206 && (!rangeStart || Number(rangeStart[1]) !== resource.offset))) {
    void response.body?.cancel();
    throw new Error('Startup media is unavailable.');
  }
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  const bytes = new Uint8Array(limit);
  let length = 0;
  let metadataProbeAt = options.init ? 8 : 377;
  try {
    while (length < limit) {
      if (signal.aborted) throw new DOMException('Startup probe timed out.', 'AbortError');
      const chunk = await reader.read();
      if (chunk.done) break;
      const count = Math.min(chunk.value.byteLength, limit - length);
      bytes.set(chunk.value.subarray(0, count), length);
      length += count;
      if (options.decodeAudio && length >= metadataProbeAt) {
        // Geometric rescans keep fragmented responses from turning bounded PSI parsing quadratic.
        metadataProbeAt = length + Math.max(188, Math.floor(length / 8));
        const sample = bytes.subarray(0, length);
        const ts = length >= 377 && bytes[0] === 0x47 && bytes[188] === 0x47 && bytes[376] === 0x47;
        const mp4 = length >= 8 && ['ftyp', 'styp', 'moof'].includes(new TextDecoder().decode(bytes.subarray(4, 8)));
        const metadata = ts ? parseMpegTsAudioLanguages(sample) : mp4 && options.init ? parseMp4AudioLanguages(sample) : undefined;
        if (signal.aborted) throw new DOMException('Startup probe timed out.', 'AbortError');
        if (metadata?.complete) return { verified: true, audioLanguages: metadata.audioLanguages };
        if (mp4 && !options.init) return { verified: true, audioLanguages: [] };
      }
    }
    if (signal.aborted) throw new DOMException('Startup probe timed out.', 'AbortError');
    const box = length >= 8 ? new TextDecoder().decode(bytes.subarray(4, 8)) : '';
    const ts = length >= 377 && bytes[0] === 0x47 && bytes[188] === 0x47 && bytes[376] === 0x47;
    const mp4 = length >= 8 && ['ftyp', 'styp', 'moof'].includes(box);
    if (ts || mp4) {
      const metadata = options.decodeAudio
        ? ts ? parseMpegTsAudioLanguages(bytes.subarray(0, length))
          : options.init ? parseMp4AudioLanguages(bytes.subarray(0, length)) : undefined
        : undefined;
      if (signal.aborted) throw new DOMException('Startup probe timed out.', 'AbortError');
      return { verified: true, audioLanguages: metadata?.audioLanguages ?? [] };
    }
    // Some CDN range handlers truncate TS data despite returning 200. Read only the same bounded prefix normally.
    if (useRange && resource.offset === 0 && response.status === 200 && length >= 189 && length < 377
      && bytes[0] === 0x47 && bytes[188] === 0x47) {
      await reader.cancel();
      return verifyStartupBytes(resource, headers, signal, options, false);
    }
    const binary = bytes.subarray(0, length).some((byte) => byte >= 127 || (byte < 32 && ![9, 10, 13].includes(byte)));
    if (!length || !binary || /^[<{\[]/.test(new TextDecoder().decode(bytes.subarray(0, 64)).trimStart())) {
      throw new Error('Startup media is not video data.');
    }
    return { verified: false, audioLanguages: [] }; // Valid HLS can use an unsupported benchmark format.
  } finally {
    cancel(); // A server ignoring Range must never cause a full video download.
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

function isPublicStartupUrl(value: string): boolean {
  const url = httpsUrl(value);
  if (!url) return false;
  const hostname = new URL(url).hostname;
  return !isPrivateOrLoopbackHost(hostname) && !isIP(hostname.replace(/^\[|\]$/g, ''));
}

async function startupFetch(url: string, init: RequestInit): Promise<Response> {
  for (let redirects = 0; redirects <= 3; redirects++) {
    if (!isPublicStartupUrl(url)) throw new Error('Unsafe startup URL.');
    if (init.signal?.aborted) throw new DOMException('Startup probe timed out.', 'AbortError');
    const response = await fetch(url, { ...init, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    const next = httpsUrl(location, url);
    void response.body?.cancel();
    if (!next || redirects === 3) throw new Error('Unsafe or excessive startup redirects.');
    url = next;
  }
  throw new Error('Startup redirect limit reached.');
}

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
  const key = createHmac('sha256', secret).update(TOKEN_CONTEXT).digest();
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(TOKEN_CONTEXT));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return [TOKEN_VERSION, nonce.toString('base64url'), encrypted.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
}

function readToken(token: string, secret: string): ProxyPayload | null {
  try {
    if (token.length > RESOLVER_MAX_BYTES * 2) return null;
    const parts = token.split('.');
    if (parts.length !== 4 || parts[0] !== TOKEN_VERSION) return null;
    const encoded = parts.slice(1);
    if (encoded.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return null;
    const buffers = encoded.map((part) => Buffer.from(part, 'base64url'));
    if (buffers.some((part, index) => part.toString('base64url') !== encoded[index])) return null;
    const [nonce, encrypted, tag] = buffers;
    if (!nonce || nonce.length !== 12 || !encrypted?.length || !tag || tag.length !== 16) return null;
    const key = createHmac('sha256', secret).update(TOKEN_CONTEXT).digest();
    const cipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
    cipher.setAAD(Buffer.from(TOKEN_CONTEXT));
    cipher.setAuthTag(tag);
    const value: unknown = JSON.parse(Buffer.concat([cipher.update(encrypted), cipher.final()]).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const payload = value as Record<string, unknown>;
    const url = httpsUrl(payload.url);
    const now = Date.now();
    if (!url || typeof payload.expiresAt !== 'number' || !Number.isSafeInteger(payload.expiresAt)
      || payload.expiresAt <= now || payload.expiresAt > now + TOKEN_TTL_MS
      || !payload.headers || typeof payload.headers !== 'object' || Array.isArray(payload.headers)) return null;
    const headers = sanitizeHeaders(payload.headers);
    const entries = Object.entries(payload.headers);
    if (entries.length !== Object.keys(headers).length
      || entries.some(([name, header]) => headers[name] !== header || !httpsUrl(header))) return null;
    return { url, expiresAt: payload.expiresAt, headers };
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

function gatewaySubtitles(input: unknown, sourceUrl: string, headers: StreamHeaders): GatewaySubtitle[] {
  if (!Array.isArray(input)) return [];
  return input.flatMap((candidate: unknown, index) => {
    if (!candidate || typeof candidate !== 'object') return [];
    const value = candidate as Record<string, unknown>;
    const url = httpsUrl(value.url ?? value.file, sourceUrl);
    if (!url) return [];
    const language = metadataLanguage(value.language ?? value.lang ?? value.srclang);
    const label = metadataLabel(value.label ?? value.name ?? value.language ?? value.lang) || language || `Subtitles ${index + 1}`;
    const vtt = !/\.m3u8(?:$|[?#])/i.test(url)
      && (/\.vtt(?:$|[?#])/i.test(url) || value.format === 'vtt' || value.type === 'text/vtt');
    return [{
      id: `sidecar-${index}`, label, language,
      kind: value.kind === 'captions' ? 'captions' as const : 'subtitles' as const,
      ...(vtt ? { url } : {}),
      ...(value.default === true ? { default: true } : {}),
      headers: { ...headers, ...sanitizeHeaders(value.headers) },
    }];
  });
}

async function resolvedStreams(target: URL, secret: string, key: string): Promise<ResolvedStream[]> {
  return cached(resolverCache, key, RESOLVER_TTL_MS, () => withTimeout(RESOLVER_TIMEOUT_MS, async (signal) => {
    // Only title identifiers and provider metadata are shared. Never forward viewer headers.
    const response = await fetch(target, { headers: { Authorization: `Bearer ${secret}` }, cache: 'no-store', signal });
    if (!response.ok) {
      void response.body?.cancel();
      throw new Error('Playback source resolution failed.');
    }
    const body = JSON.parse(await boundedText(response, RESOLVER_MAX_BYTES, signal)) as Record<string, unknown>;
    if (!body || !Array.isArray(body.streams)) return [];
    return body.streams.flatMap((candidate: unknown) => {
      if (!candidate || typeof candidate !== 'object') return [];
      const value = candidate as Record<string, unknown>;
      const url = httpsUrl(value.url);
      if (!url) return [];
      const headers = sanitizeHeaders(value.headers);
      return [{
        url, headers,
        subtitles: gatewaySubtitles(value.subtitles ?? body.subtitles, url, headers),
        audioLanguage: metadataLabel(value.audioLanguage ?? value.language),
      }];
    });
  }));
}

function proxyPath(url: string, headers: StreamHeaders, secret: string): string {
  const token = createToken({ url, headers, expiresAt: Date.now() + TOKEN_TTL_MS }, secret);
  return `/api/vidnest?token=${encodeURIComponent(token)}`;
}

async function streamCatalog(
  streams: ResolvedStream[], secret: string, onHealthy: (startup: HealthyStartup) => void,
  onFallback: (manifest: PlaybackManifest) => void,
): Promise<DirectStream[]> {
  const catalog: DirectStream[] = new Array(streams.length);
  const deadline = Date.now() + CATALOG_BUDGET_MS;
  let next = 0;
  let manifestOrder = 0;
  await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, streams.length) }, async () => {
    while (next < streams.length) {
      const index = next++;
      const stream = streams[index]!;
      let metadata = parseHlsMetadata('');
      let startupLatencyMs: number | undefined;
      let validManifest: PlaybackManifest | undefined;
      let compatibilityFallback = false;
      let audioLanguages: string[] = [];
      try {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error('Metadata discovery deadline reached.');
        await withTimeout(Math.min(MANIFEST_TIMEOUT_MS, remaining), async (signal) => {
          const start = Date.now();
          const response = await startupFetch(stream.url, {
            headers: { ...stream.headers, 'Accept-Encoding': 'identity' }, cache: 'no-store', signal,
          });
          if (!response.ok || !isPublicStartupUrl(response.url || stream.url)) {
            void response.body?.cancel();
            throw new Error('Manifest is unavailable.');
          }
          const sourceUrl = response.url || stream.url;
          const playlist = await boundedText(response, MANIFEST_MAX_BYTES, signal);
          if (signal.aborted) throw new DOMException('Startup probe timed out.', 'AbortError');
          metadata = parseHlsMetadata(playlist);
          if (!hasHlsPlaybackUri(playlist, sourceUrl, isPublicStartupUrl)) throw new Error('Invalid playback manifest.');
          validManifest = { index, playlist, sourceUrl, order: manifestOrder++ };
          let plan = hlsStartupPlan(playlist, sourceUrl);
          if (plan?.variantUrl) {
            const child = await startupFetch(plan.variantUrl, {
              headers: { ...stream.headers, 'Accept-Encoding': 'identity' }, cache: 'no-store', signal,
            });
            if (!child.ok || !isPublicStartupUrl(child.url || plan.variantUrl)) {
              void child.body?.cancel();
              throw new Error('Startup rendition is unavailable.');
            }
            const childUrl = child.url || plan.variantUrl;
            const childPlaylist = await boundedText(child, MANIFEST_MAX_BYTES, signal);
            if (!hasHlsPlaybackUri(childPlaylist, childUrl, isPublicStartupUrl)) throw new Error('Invalid startup rendition.');
            plan = hlsStartupPlan(childPlaylist, childUrl);
          }
          if (!plan?.media) {
            compatibilityFallback = true;
            return;
          }
          const decodeAudio = !metadata.audioTracks.length && !stream.audioLanguage;
          if (plan.init) {
            const init = await verifyStartupBytes(plan.init, stream.headers, signal, { decodeAudio, init: true });
            if (!init.verified) { compatibilityFallback = true; return; }
            audioLanguages = init.audioLanguages;
          }
          const media = await verifyStartupBytes(plan.media, stream.headers, signal, { decodeAudio: decodeAudio && !audioLanguages.length });
          if (!media.verified) {
            compatibilityFallback = true;
            return;
          }
          if (media.audioLanguages.length) audioLanguages = media.audioLanguages;
          if (signal.aborted) throw new DOMException('Startup probe timed out.', 'AbortError');
          startupLatencyMs = Math.max(0, Date.now() - start);
          onHealthy({ index, latencyMs: startupLatencyMs, playlist, sourceUrl });
        });
      } catch (error) {
        compatibilityFallback = error instanceof Error && error.name === 'AbortError';
        // A failed probe must not hide real streams or prevent initial playback.
      }
      if (validManifest && compatibilityFallback) onFallback(validManifest);
      if (!metadata.audioTracks.length && !stream.audioLanguage) metadata.audioTracks = decodedAudioTracks(audioLanguages);
      if (!metadata.audioTracks.length && stream.audioLanguage) {
        metadata.audioTracks.push({
          id: 'muxed', label: stream.audioLanguage, language: metadataLanguage(stream.audioLanguage), default: true,
        });
      }
      catalog[index] = {
        id: String(index), url: proxyPath(stream.url, stream.headers, secret), ...metadata,
        ...(startupLatencyMs !== undefined ? { startupLatencyMs } : {}),
        subtitles: [
          ...metadata.subtitles,
          ...stream.subtitles.map(({ headers, url, ...track }) => ({
            ...track, ...(url ? { url: proxyPath(url, headers, secret) } : {}),
          })),
        ],
      };
    }
  }));
  return catalog;
}

async function catalogProbe(streams: ResolvedStream[], secret: string, key: string): Promise<CatalogProbe> {
  return cached(catalogCache, key, CATALOG_TTL_MS, async () => {
    let first!: (startup: HealthyStartup | undefined) => void;
    const probe: CatalogProbe = {
      firstHealthy: new Promise((resolve) => { first = resolve; }), complete: Promise.resolve([]),
    };
    probe.complete = streamCatalog(streams, secret, (startup) => {
      if (!probe.best || startup.latencyMs < probe.best.latencyMs) probe.best = startup;
      first(startup);
    }, (manifest) => {
      if (!probe.fallback || manifest.order < probe.fallback.order) probe.fallback = manifest;
    });
    void probe.complete.then(() => first(undefined), () => first(undefined));
    return probe;
  });
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
      return proxyPath(url.href, headers, secret);
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
    let rawPlaylist = await boundedText(new Response(body), RESOLVER_MAX_BYTES, request.signal);
    const rendition = request.nextUrl.searchParams.get('rendition');
    if (rendition !== null) {
      const filtered = selectHlsRendition(rawPlaylist, rendition);
      if (!filtered) return jsonError('The requested quality is unavailable.', 404);
      rawPlaylist = filtered;
    }
    const playlist = rewritePlaylist(rawPlaylist, sourceUrl, payload.headers, secret);
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

function castCapability(payload: ProxyPayload, secret: string): NextResponse {
  const token = createToken({ ...payload, expiresAt: Math.min(payload.expiresAt, Date.now() + 15 * 60 * 1000) }, secret);
  return NextResponse.json({ url: `/api/vidnest?token=${encodeURIComponent(token)}` }, {
    headers: { 'Cache-Control': 'private, no-store' },
  });
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
  if (streamIndexRaw !== 'auto' && (!/^\d{1,6}$/.test(streamIndexRaw) || !Number.isSafeInteger(streamIndex) || streamIndex < 0)) {
    return jsonError('Invalid playback stream.', 400);
  }

  const target = new URL('/api/resolve', config.baseUrl);
  target.searchParams.set('tmdbId', tmdbId);
  target.searchParams.set('type', type);
  if (type === 'tv') {
    target.searchParams.set('season', season!);
    target.searchParams.set('episode', episode!);
  }

  const key = sign(target.href, config.secret);
  const streams = await resolvedStreams(target, config.secret, key);
  if (params.get('metadata') === '1' || streamIndexRaw === 'auto') {
    const catalogKey = sign(`${key}:${JSON.stringify(streams)}`, config.secret);
    const probe = await catalogProbe(streams, config.secret, catalogKey);
    if (params.get('metadata') === '1') {
      const catalog = await probe.complete;
      return NextResponse.json({
        streams: catalog, ...(probe.best ? { recommendedStreamId: String(probe.best.index) } : {}),
      }, { headers: { 'Cache-Control': 'private, no-store' } });
    }
    const selected = probe.best ?? await probe.firstHealthy ?? probe.fallback;
    if (!selected) return jsonError('No healthy playback source is available.', streams.length ? 502 : 404);
    const stream = streams[selected.index]!;
    if (params.get('cast') === '1') return castCapability({ url: stream.url, headers: stream.headers, expiresAt: Date.now() + TOKEN_TTL_MS }, config.secret);
    return new NextResponse(rewritePlaylist(selected.playlist, selected.sourceUrl, stream.headers, config.secret), {
      status: 200,
      headers: {
        'Cache-Control': 'private, no-store', 'Content-Type': 'application/vnd.apple.mpegurl',
        'X-Vidnest-Stream-Id': String(selected.index),
      },
    });
  }
  const stream = streams[streamIndex];
  const streamUrl = stream?.url;
  if (!stream || typeof streamUrl !== 'string') return jsonError('No playback source is available.', 404);
  if (params.get('cast') === '1') return castCapability({ url: streamUrl, headers: stream.headers, expiresAt: Date.now() + TOKEN_TTL_MS }, config.secret);

  const token = createToken({
    url: streamUrl,
    headers: stream.headers,
    expiresAt: Date.now() + TOKEN_TTL_MS,
  }, config.secret);
  return proxy(request, token, config.secret);
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: { ...RECEIVER_CORS_HEADERS, 'Cache-Control': 'private, no-store' } });
}

export async function GET(request: NextRequest) {
  const config = getApiConfig();
  if (!config) return jsonError('VidNest playback is not configured.', 503);

  try {
    const token = request.nextUrl.searchParams.get('token');
    if (request.nextUrl.searchParams.has('rendition') && !token) return jsonError('Quality selection requires a playback capability.', 400);
    if (token && request.nextUrl.searchParams.get('cast') === '1') {
      const payload = readToken(token, config.secret);
      return payload ? castCapability(payload, config.secret) : jsonError('Invalid playback token.', 403);
    }
    const response = token ? await proxy(request, token, config.secret) : await resolve(request, config);
    // Only holders of encrypted capabilities can read media from a receiver origin.
    if ((response.ok || response.status === 416) && token) {
      for (const [name, value] of Object.entries(RECEIVER_CORS_HEADERS)) response.headers.set(name, value);
    }
    return response;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') return jsonError('Playback request timed out.', 504);
    return jsonError('Playback is temporarily unavailable.', 502);
  }
}
