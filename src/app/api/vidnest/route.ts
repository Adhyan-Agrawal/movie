import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { after, NextRequest, NextResponse } from 'next/server';
import { inspectVidnest } from '@/features/vidnest/resolver';
import { resolveMegaPlayStreams } from '@/features/megaplay/resolver';
import { selectHlsRendition } from '@/lib/providers/hls-rendition';
import { decodedAudioTracks, hasHlsPlaybackUri, hlsStartupPlan, httpsUrl, metadataLabel, metadataLanguage, parseHlsMetadata, parseMp4AudioLanguages } from '@/lib/providers/hls-metadata';
import { parseMpegTsAudioLanguages } from '@/lib/providers/mpeg-ts-metadata';
import type { DirectStream, Track } from '@/lib/providers/types';
import { isPrivateOrLoopbackHost } from '@/lib/validation/source';
import { requestIp } from '@/lib/request-ip';

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
const RESOLVER_TIMEOUT_MS = 15_000;
const MANIFEST_TIMEOUT_MS = 4_000;
const CATALOG_BUDGET_MS = 12_000;
const MANIFEST_MAX_BYTES = 1024 * 1024;
const RESOLVER_MAX_BYTES = 1024 * 1024;
const PROBE_CONCURRENCY = 4;
const MAX_CACHE_ENTRIES = 128;
const RESOLVER_RATE_LIMIT = 20;
const RESOLVER_RATE_WINDOW_MS = 60_000;
const RECEIVER_CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Range',
  'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Range, Content-Length, Content-Type, ETag, X-Vidnest-Stream-Id',
};

type StreamHeaders = Record<string, string>;
type ProxyPayload = { expiresAt: number; headers: StreamHeaders; url: string };
type ApiConfig = { resolverBaseUrl?: URL; secret: string };
type ResolverCoordinates = {
  tmdbId: string; mediaType: 'movie' | 'tv'; season: number | null; episode: number | null;
};
type GatewaySubtitle = Track & { headers: StreamHeaders };
type ResolvedStream = { url: string; headers: StreamHeaders; subtitles: GatewaySubtitle[]; audioLanguage: string; expiresAt?: number };
type CacheEntry<T> = { expiresAt: number; value: T };
type PlaybackManifest = { index: number; playlist: string; sourceUrl: string; order: number; expiresAt?: number };
type HealthyStartup = Omit<PlaybackManifest, 'order'> & { latencyMs: number };
type CatalogProbe = {
  firstHealthy: Promise<HealthyStartup | undefined>; complete: Promise<DirectStream[]>;
  best?: HealthyStartup; fallback?: PlaybackManifest;
};
type CatalogSnapshot = { catalog: DirectStream[]; best?: HealthyStartup; fallback?: PlaybackManifest };
type CatalogOptions = { signal?: AbortSignal; deadline?: number; seed?: { streams: ResolvedStream[]; snapshot: CatalogSnapshot } };
const resolverCache = new Map<string, CacheEntry<ResolvedStream[]>>();
const catalogCache = new Map<string, CacheEntry<CatalogSnapshot>>();
const resolverRates = new Map<string, { count: number; resetAt: number }>();

function cachedValue<T>(cache: Map<string, CacheEntry<T>>, key: string): T | undefined {
  const now = Date.now();
  for (const [entryKey, entry] of cache) if (entry.expiresAt <= now) cache.delete(entryKey);
  return cache.get(key)?.value;
}

function allowResolverRequest(address: string): boolean {
  const now = Date.now();
  for (const [key, entry] of resolverRates) if (entry.resetAt <= now) resolverRates.delete(key);
  if (resolverRates.size >= MAX_CACHE_ENTRIES && !resolverRates.has(address)) resolverRates.delete(resolverRates.keys().next().value!);
  const entry = resolverRates.get(address);
  if (!entry) {
    resolverRates.set(address, { count: 1, resetAt: now + RESOLVER_RATE_WINDOW_MS });
    return true;
  }
  if (entry.count >= RESOLVER_RATE_LIMIT) return false;
  entry.count++;
  return true;
}

async function withTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>, parentSignal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout>;
  let abort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => {
      controller.abort();
      reject(new DOMException('Request aborted.', 'AbortError'));
    };
  });
  const expired = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new DOMException('Request timed out.', 'AbortError'));
    }, ms);
  });
  try {
    if (parentSignal?.aborted) throw new DOMException('Request aborted.', 'AbortError');
    parentSignal?.addEventListener('abort', abort, { once: true });
    return await Promise.race([run(controller.signal), expired, aborted]);
  } finally {
    clearTimeout(timeout!);
    parentSignal?.removeEventListener('abort', abort);
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
  return !isPrivateOrLoopbackHost(hostname) && !isIP(hostname.replace(/^\[|\]$/g, ''))
    && (upstreamExpiry(url) ?? Infinity) > Date.now();
}

async function startupFetch(url: string, init: RequestInit): Promise<Response> {
  for (let redirects = 0; redirects <= 3; redirects++) {
    if (!isPublicStartupUrl(url)) throw new Error('Unsafe startup URL.');
    if (init.signal?.aborted) throw new DOMException('Startup probe timed out.', 'AbortError');
    const response = await globalThis.fetch(url, { ...init, redirect: 'manual' });
    if (init.signal?.aborted) {
      void response.body?.cancel().catch(() => undefined);
      throw new DOMException('Startup probe timed out.', 'AbortError');
    }
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

function getApiConfig(): ApiConfig | null {
  const secret = process.env.VIDNEST_API_SECRET;
  if (!secret || secret.length < 32) return null;
  // Production must not revive a retired resolver from OpenNext's build-time env defaults.
  const rawUrl = process.env.NODE_ENV === 'test' ? process.env.VIDNEST_API_URL?.trim() : undefined;
  if (!rawUrl) return { secret };
  try {
    const resolverBaseUrl = new URL(rawUrl);
    const hostname = resolverBaseUrl.hostname.replace(/^\[|\]$/g, '');
    if (resolverBaseUrl.protocol !== 'https:' || resolverBaseUrl.username || resolverBaseUrl.password
      || resolverBaseUrl.search || resolverBaseUrl.hash || isPrivateOrLoopbackHost(hostname) || isIP(hostname)) return null;
    return { resolverBaseUrl, secret };
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
    const expiresAt = Math.min(payload.expiresAt, upstreamExpiry(url) ?? Infinity);
    return expiresAt > now ? { url, expiresAt, headers } : null;
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

function normalizeResolvedStreams(body: unknown): ResolvedStream[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
  const payload = body as Record<string, unknown>;
  if (!Array.isArray(payload.streams)) return [];
  const seen = new Set<string>();
  return payload.streams.flatMap((candidate: unknown) => {
    if (!candidate || typeof candidate !== 'object') return [];
    const value = candidate as Record<string, unknown>;
    const declaredType = typeof value.type === 'string' ? value.type.toLowerCase() : '';
    if (declaredType && !['hls', 'unknown', 'application/vnd.apple.mpegurl', 'application/x-mpegurl'].includes(declaredType)) return [];
    const url = httpsUrl(value.url);
    if (!url || !isPublicStartupUrl(url)) return [];
    const expiresAt = upstreamExpiry(url);
    if (expiresAt !== undefined && expiresAt <= Date.now()) return [];
    const headers = sanitizeHeaders(value.headers);
    const identity = `${url}\n${headers.origin ?? ''}\n${headers.referer ?? ''}`;
    if (seen.has(identity)) return [];
    seen.add(identity);
    return [{
      url, headers,
      subtitles: gatewaySubtitles(value.subtitles ?? payload.subtitles, url, headers),
      audioLanguage: metadataLabel(value.audioLanguage ?? value.language),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    }];
  });
}

async function resolvedStreams(
  coordinates: ResolverCoordinates,
  target: URL | undefined,
  secret: string,
  key: string,
  parentSignal?: AbortSignal,
  onPrimary?: (streams: ResolvedStream[]) => void,
): Promise<ResolvedStream[]> {
  if (parentSignal?.aborted) throw new DOMException('Request aborted.', 'AbortError');
  const existing = cachedValue(resolverCache, key);
  if (existing) return existing;
  const streams = await withTimeout(RESOLVER_TIMEOUT_MS, async (signal) => {
    if (!target) {
      // The capability secret never leaves this route or enters local source resolution.
      const [vidnest, megaPlay] = await Promise.allSettled([
        inspectVidnest({ ...coordinates, signal,
          acceptStream: (stream) => normalizeResolvedStreams({ streams: [stream] }).length > 0,
          ...(onPrimary ? { onPrimary: (streams) => onPrimary(normalizeResolvedStreams({ streams })) } : {}) }),
        resolveMegaPlayStreams({ tmdbId: coordinates.tmdbId, mediaType: coordinates.mediaType,
          season: coordinates.season, episode: coordinates.episode, signal }),
      ]);
      const vidnestStreams = vidnest.status === 'fulfilled' ? vidnest.value.streams : [];
      const megaPlayStreams = megaPlay.status === 'fulfilled' ? megaPlay.value : [];
      if (vidnestStreams.length === 0 && megaPlayStreams.length === 0) {
        console.warn(JSON.stringify({
          event: 'embedded_resolvers_empty',
          vidnestStatus: vidnest.status,
          vidnestError: vidnest.status === 'rejected' && vidnest.reason instanceof Error ? vidnest.reason.name : undefined,
          megaPlayStatus: megaPlay.status,
          megaPlayError: megaPlay.status === 'rejected' && megaPlay.reason instanceof Error ? megaPlay.reason.name : undefined,
        }));
      }
      return normalizeResolvedStreams({ streams: [
        ...vidnestStreams,
        ...megaPlayStreams,
      ] });
    }
    // Test fixtures use a separate resolver endpoint; production always runs the embedded engines.
    const response = await fetch(target, { headers: { Authorization: `Bearer ${secret}` }, cache: 'no-store', signal, redirect: 'manual' });
    if (!response.ok) {
      void response.body?.cancel();
      throw new Error('Playback source resolution failed.');
    }
    return normalizeResolvedStreams(JSON.parse(await boundedText(response, RESOLVER_MAX_BYTES, signal)) as unknown);
  }, parentSignal);
  // Never turn an outage or an aborted partial fan-out into a warm result.
  if (streams.length && !parentSignal?.aborted) {
    if (resolverCache.size >= MAX_CACHE_ENTRIES) resolverCache.delete(resolverCache.keys().next().value!);
    resolverCache.set(key, { expiresAt: cacheExpiry(streams, RESOLVER_TTL_MS), value: streams });
  }
  return streams;
}

function capabilityUrl(token: string): string {
  return `/api/vidnest?token=${encodeURIComponent(token)}`;
}

function upstreamExpiry(url: string): number | undefined {
  let expiry: number | undefined;
  for (const [name, value] of new URL(url).searchParams) {
    if (!['exp', 'expires', 'expiry'].includes(name.toLowerCase()) || !/^\d{1,13}$/.test(value)) continue;
    const numeric = Number(value);
    const timestamp = numeric >= 1e12 ? numeric : numeric * 1000;
    if (Number.isSafeInteger(timestamp)) expiry = Math.min(expiry ?? Infinity, timestamp);
  }
  return expiry;
}

function cacheExpiry(streams: ResolvedStream[], ttl: number): number {
  return Math.min(Date.now() + ttl, ...streams.flatMap((stream) => [stream.expiresAt ?? Infinity,
    ...stream.subtitles.map((track) => track.url ? upstreamExpiry(track.url) ?? Infinity : Infinity)]));
}

function manifestExpiry(playlist: string, sourceUrl: string): number | undefined {
  let expiry = upstreamExpiry(sourceUrl) ?? Infinity;
  for (const rawLine of playlist.split(/\r?\n/)) {
    const line = rawLine.trim();
    const uris = line.startsWith('#') ? [...line.matchAll(/URI="([^"]+)"/g)].map((match) => match[1]!) : [line];
    for (const uri of uris) {
      const url = httpsUrl(uri, sourceUrl);
      if (url) expiry = Math.min(expiry, upstreamExpiry(url) ?? Infinity);
    }
  }
  return Number.isFinite(expiry) ? expiry : undefined;
}

function proxyPath(url: string, headers: StreamHeaders, secret: string, expiresAt = Date.now() + TOKEN_TTL_MS): string {
  const token = createToken({ url, headers, expiresAt: Math.min(expiresAt, Date.now() + TOKEN_TTL_MS, upstreamExpiry(url) ?? Infinity) }, secret);
  return capabilityUrl(token);
}

async function streamCatalog(
  streams: ResolvedStream[], secret: string, onHealthy: (startup: HealthyStartup) => void,
  onFallback: (manifest: PlaybackManifest) => void,
  options: CatalogOptions = {},
): Promise<DirectStream[]> {
  const catalog: DirectStream[] = new Array(streams.length);
  const deadline = options.deadline ?? Date.now() + CATALOG_BUDGET_MS;
  const seed = options.seed?.streams.every((stream, index) => JSON.stringify(stream) === JSON.stringify(streams[index]))
    ? options.seed : undefined;
  let next = seed?.streams.length ?? 0;
  let manifestOrder = next;
  if (seed) {
    for (let index = 0; index < next; index++) catalog[index] = seed.snapshot.catalog[index]!;
    if (seed.snapshot.best) onHealthy(seed.snapshot.best);
    if (seed.snapshot.fallback) onFallback(seed.snapshot.fallback);
  }
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
        if (remaining <= 0 || options.signal?.aborted) throw new Error('Metadata discovery deadline reached.');
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
           validManifest = { index, playlist, sourceUrl, order: manifestOrder++, expiresAt: manifestExpiry(playlist, sourceUrl) };
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
             validManifest.expiresAt = Math.min(validManifest.expiresAt ?? Infinity, manifestExpiry(childPlaylist, childUrl) ?? Infinity);
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
           if ((validManifest.expiresAt ?? Infinity) <= Date.now()) throw new Error('Startup media expired.');
           startupLatencyMs = Math.max(0, Date.now() - start);
           onHealthy({ index, latencyMs: startupLatencyMs, playlist, sourceUrl,
             ...(Number.isFinite(validManifest.expiresAt) ? { expiresAt: validManifest.expiresAt } : {}) });
        }, options.signal);
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
      const expiresAt = Math.min(Date.now() + TOKEN_TTL_MS, stream.expiresAt ?? Infinity);
      catalog[index] = {
        id: String(index), url: proxyPath(stream.url, stream.headers, secret, expiresAt), ...metadata,
        expiresAt: Math.min(expiresAt, ...stream.subtitles.map((track) => track.url ? upstreamExpiry(track.url) ?? Infinity : Infinity)),
        ...(startupLatencyMs !== undefined ? { startupLatencyMs } : {}),
        subtitles: [
          ...metadata.subtitles,
          ...stream.subtitles.map(({ headers, url, ...track }) => ({
            ...track, ...(url ? { url: proxyPath(url, headers, secret, expiresAt) } : {}),
          })),
        ],
      };
    }
  }));
  return catalog;
}

async function catalogProbe(streams: ResolvedStream[], secret: string, key: string, options: CatalogOptions = {}): Promise<CatalogProbe> {
  const existing = cachedValue(catalogCache, key);
  if (existing) {
    return {
      firstHealthy: Promise.resolve(existing.best),
      complete: Promise.resolve(existing.catalog),
      ...(existing.best ? { best: existing.best } : {}),
      ...(existing.fallback ? { fallback: existing.fallback } : {}),
    };
  }
  let first!: (startup: HealthyStartup | undefined) => void;
  const probe: CatalogProbe = {
    firstHealthy: new Promise((resolve) => { first = resolve; }), complete: Promise.resolve([]),
  };
  const startupExpiries = new Map<number, number>();
  probe.complete = streamCatalog(streams, secret, (startup) => {
    if ((startup.expiresAt ?? Infinity) <= Date.now()) return;
    if (startup.expiresAt !== undefined) startupExpiries.set(startup.index, startup.expiresAt);
    if (!probe.best || (probe.best.expiresAt ?? Infinity) <= Date.now() || startup.latencyMs < probe.best.latencyMs) probe.best = startup;
    first(startup);
  }, (manifest) => {
    if ((manifest.expiresAt ?? Infinity) <= Date.now()) return;
    if (!probe.fallback || (probe.fallback.expiresAt ?? Infinity) <= Date.now() || manifest.order < probe.fallback.order) probe.fallback = manifest;
  }, options).then((catalog) => {
    for (const [index, expiresAt] of startupExpiries) {
      if (expiresAt <= Date.now() && catalog[index]) delete catalog[index]!.startupLatencyMs;
    }
    if (probe.best && (probe.best.expiresAt ?? Infinity) <= Date.now()) probe.best = undefined;
    if (probe.fallback && (probe.fallback.expiresAt ?? Infinity) <= Date.now()) probe.fallback = undefined;
    if ((probe.best || probe.fallback) && !options.signal?.aborted) {
      if (catalogCache.size >= MAX_CACHE_ENTRIES) catalogCache.delete(catalogCache.keys().next().value!);
      catalogCache.set(key, {
        expiresAt: Math.min(cacheExpiry(streams, CATALOG_TTL_MS), probe.best?.expiresAt ?? Infinity, probe.fallback?.expiresAt ?? Infinity),
        value: { catalog, ...(probe.best ? { best: probe.best } : {}), ...(probe.fallback ? { fallback: probe.fallback } : {}) },
      });
    }
    return catalog;
  });
  void probe.complete.then(() => first(undefined), () => first(undefined));
  return probe;
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
  let cancelled = false;
  let finished = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (cancelled || finished) return;
      if (bufferedIndex < buffered.length) {
        controller.enqueue(buffered[bufferedIndex++]!);
        return;
      }

      try {
        const result = await reader.read();
        if (cancelled) return;
        if (result.done) {
          finished = true;
          reader.releaseLock();
          controller.close();
        }
        else controller.enqueue(result.value);
      } catch (error) {
        if (cancelled) return;
        finished = true;
        reader.releaseLock();
        controller.error(error);
      }
    },
    async cancel(reason) {
      cancelled = true;
      if (finished) return;
      try {
        await reader.cancel(reason);
      } catch {
        // A replaced or abandoned media request must not surface a late upstream abort.
      } finally {
        finished = true;
        reader.releaseLock();
      }
    },
  });
}

async function probePlaylist(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<{
  body: ReadableStream<Uint8Array>;
  playlist: boolean;
  contentType?: string;
}> {
  const reader = body.getReader();
  const buffered: Uint8Array[] = [];
  const probe = new Uint8Array(PLAYLIST_PROBE_BYTES);
  let probeLength = 0;
  let playlist = false;
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });

  try {
    while (probeLength < PLAYLIST_PROBE_BYTES) {
      if (signal.aborted) throw new DOMException('Playback probe timed out.', 'AbortError');
      const result = await reader.read();
      if (signal.aborted) throw new DOMException('Playback probe timed out.', 'AbortError');
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
  } catch (error) {
    cancel();
    reader.releaseLock();
    throw error;
  } finally {
    signal.removeEventListener('abort', cancel);
  }

  const boxType = probeLength >= 8 ? new TextDecoder().decode(probe.subarray(4, 8)) : '';
  const contentType = probeLength >= 377 && probe[0] === 0x47 && probe[188] === 0x47 && probe[376] === 0x47
    ? 'video/mp2t'
    : ['ftyp', 'styp', 'moof'].includes(boxType) ? 'video/mp4' : undefined;
  return { body: replayStream(reader, buffered), playlist, contentType };
}

function rewritePlaylist(
  playlist: string, sourceUrl: string, headers: StreamHeaders, secret: string, expiresAt?: number,
): string {
  const proxyUrl = (value: string) => {
    const url = httpsUrl(value, sourceUrl);
    if (!url || !isPublicStartupUrl(url)) throw new Error('Unsafe playback playlist URL.');
    return proxyPath(url, headers, secret, expiresAt);
  };

  return playlist
    .replace(/^\uFEFF/, '')
    .split(/(\r?\n)/)
    .map((line) => {
      if (!line.trim()) return line;
      if (!line.trimStart().startsWith('#')) return proxyUrl(line.trim());
      return line.replace(/URI="([^"]*)"/g, (_match, value: string) => `URI="${proxyUrl(value)}"`);
    })
    .join('');
}

async function proxy(request: NextRequest, token: string, secret: string): Promise<NextResponse> {
  // Bound headers, signature sniffing and manifests, not the returned media body.
  return withTimeout(MANIFEST_TIMEOUT_MS, (deadlineSignal) => proxyStream(
    request, token, secret, AbortSignal.any([request.signal, deadlineSignal]),
  ), request.signal);
}

async function proxyStream(request: NextRequest, token: string, secret: string, signal: AbortSignal): Promise<NextResponse> {
  const payload = readToken(token, secret);
  if (!payload) return jsonError('Invalid or expired playback token.', 403);

  const upstreamHeaders = new Headers(payload.headers);
  upstreamHeaders.set('Accept-Encoding', 'identity');
  for (const name of ['range', 'if-range']) {
    const value = request.headers.get(name);
    if (value !== null) upstreamHeaders.set(name, value);
  }

  let response = await startupFetch(payload.url, { headers: upstreamHeaders, cache: 'no-store', signal });
  if (response.status === 416) {
    const headers = new Headers({ 'Cache-Control': 'private, no-store' });
    const contentRange = response.headers.get('content-range');
    if (contentRange) headers.set('Content-Range', contentRange);
    await response.body?.cancel();
    return new NextResponse(null, { status: 416, headers });
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    return jsonError('Playback stream is unavailable.', 502);
  }

  let sourceUrl = response.url || payload.url;
  let inspected = isPlaylist(response, sourceUrl)
    ? { body: response.body, playlist: true, contentType: undefined }
    : await probePlaylist(response.body, signal);
  let completePlaylistFetched = false;

  // An opaque manifest's requested range may omit its signature entirely.
  if (request.headers.has('range') && !inspected.playlist && !inspected.contentType
    && !/^(?:audio|video|image)\//i.test(response.headers.get('content-type') ?? '')) {
    const fullHeaders = new Headers(upstreamHeaders);
    fullHeaders.delete('range');
    fullHeaders.delete('if-range');
    const fullResponse = await startupFetch(payload.url, { headers: fullHeaders, cache: 'no-store', signal });
    if (fullResponse.ok && fullResponse.body) {
      const fullUrl = fullResponse.url || payload.url;
      const fullInspection = isPlaylist(fullResponse, fullUrl)
        ? { body: fullResponse.body, playlist: true, contentType: undefined }
        : await probePlaylist(fullResponse.body, signal);
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
      response = await startupFetch(payload.url, { headers: upstreamHeaders, cache: 'no-store', signal });
      if (!response.ok || !response.body) return jsonError('Playback stream is unavailable.', 502);
      sourceUrl = response.url || payload.url;
      body = response.body;
    }
    let rawPlaylist = await boundedText(new Response(body), RESOLVER_MAX_BYTES, signal);
    const rendition = request.nextUrl.searchParams.get('rendition');
    if (rendition !== null) {
      const filtered = selectHlsRendition(rawPlaylist, rendition);
      if (!filtered) return jsonError('The requested quality is unavailable.', 404);
      rawPlaylist = filtered;
    }
    const playlist = rewritePlaylist(rawPlaylist, sourceUrl, payload.headers, secret, payload.expiresAt);
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
  return NextResponse.json({ url: capabilityUrl(token) }, {
    headers: { 'Cache-Control': 'private, no-store' },
  });
}

async function resolve(request: NextRequest, config: ApiConfig): Promise<NextResponse> {
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

  const coordinates: ResolverCoordinates = {
    tmdbId,
    mediaType: type,
    season: type === 'tv' ? Number(season) : null,
    episode: type === 'tv' ? Number(episode) : null,
  };
  let target: URL | undefined;
  if (config.resolverBaseUrl) {
    target = new URL('/api/resolve', config.resolverBaseUrl);
    target.searchParams.set('tmdbId', tmdbId);
    target.searchParams.set('type', type);
    if (type === 'tv') {
      target.searchParams.set('season', season!);
      target.searchParams.set('episode', episode!);
    }
  }

  const resolverIdentity = target?.href
    ?? `embedded:${type}:${tmdbId}:${coordinates.season ?? ''}:${coordinates.episode ?? ''}`;
  const key = sign(resolverIdentity, config.secret);
  if (params.get('metadata') === '1' || streamIndexRaw === 'auto') {
    const metadataRequest = params.get('metadata') === '1';
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.signal.addEventListener('abort', abort, { once: true });
    if (request.signal.aborted) abort();
    const catalogKey = (streams: ResolvedStream[]) => sign(`${key}:${JSON.stringify(streams)}`, config.secret);
    const coldAuto = !metadataRequest && !target && !cachedValue(resolverCache, key);
    let primaryStreams: ResolvedStream[] = [];
    let primaryProbe: Promise<CatalogProbe> | undefined;
    let deadline: number | undefined;
    let first!: (state: { streams: ResolvedStream[]; probe: CatalogProbe } | undefined) => void;
    const primaryReady = new Promise<{ streams: ResolvedStream[]; probe: CatalogProbe } | undefined>((resolve) => { first = resolve; });
    const allStreams = resolvedStreams(coordinates, target, config.secret, key, controller.signal, coldAuto ? (streams) => {
      if (!streams.length || cacheExpiry(streams, Infinity) <= Date.now() + RESOLVER_TIMEOUT_MS + CATALOG_BUDGET_MS) {
        first(undefined); return;
      }
      primaryStreams = streams;
      deadline = Date.now() + CATALOG_BUDGET_MS;
      primaryProbe = catalogProbe(streams, config.secret, catalogKey(streams), { signal: controller.signal, deadline });
      void primaryProbe.then((probe) => first({ streams, probe }), () => first(undefined));
    } : undefined);
    const catalogReady = allStreams.then(async (streams) => {
      const primary = await primaryProbe;
      const seed = primary ? { streams: primaryStreams, snapshot: {
        catalog: await primary.complete,
        ...(primary.best ? { best: primary.best } : {}),
        ...(primary.fallback ? { fallback: primary.fallback } : {}),
      } } : undefined;
      const probe = await catalogProbe(streams, config.secret, catalogKey(streams), {
        signal: controller.signal, deadline, seed,
      });
      return { streams, probe };
    });
    const completion = catalogReady.then(async (state) => {
      await state.probe.complete;
      return state;
    }).finally(() => request.signal.removeEventListener('abort', abort));
    let deferred = false;
    if (!metadataRequest) {
      try {
        after(() => completion.then(() => undefined, () => undefined));
        deferred = true;
      } catch {
        // Direct invocations without a Next request scope must cancel and drain the tail.
      }
    }
    void completion.catch(() => undefined);
    try {
      if (metadataRequest) {
        const { probe } = await completion;
        const catalog = await probe.complete;
        return NextResponse.json({
          streams: catalog, ...(probe.best ? { recommendedStreamId: String(probe.best.index) } : {}),
          ...(catalog.length ? { expiresAt: Math.min(...catalog.map((stream) => stream.expiresAt ?? Date.now())) } : {}),
        }, { headers: { 'Cache-Control': 'private, no-store' } });
      }
      const primary = coldAuto ? await Promise.race([primaryReady, catalogReady.then(() => undefined)]) : undefined;
      let selected: HealthyStartup | PlaybackManifest | undefined = primary && (primary.probe.best ?? await primary.probe.firstHealthy);
      if (selected && (selected.expiresAt ?? Infinity) <= Date.now()) selected = undefined;
      let streams = primary?.streams ?? [];
      if (!selected) {
        const state = await catalogReady;
        streams = state.streams;
        selected = state.probe.best ?? await state.probe.firstHealthy ?? state.probe.fallback;
        if (selected && (selected.expiresAt ?? Infinity) <= Date.now()) selected = state.probe.fallback;
      }
      if (!deferred) {
        controller.abort();
        await Promise.allSettled([completion, primaryProbe?.then((probe) => probe.complete)]);
      }
      if (!selected) return jsonError('No healthy playback source is available.', streams.length ? 502 : 404);
      const stream = streams[selected.index]!;
      const expiresAt = Math.min(Date.now() + TOKEN_TTL_MS, stream.expiresAt ?? Infinity, selected.expiresAt ?? Infinity);
      if (expiresAt <= Date.now()) return jsonError('Playback source expired.', 502);
      if (params.get('cast') === '1') return castCapability({ url: stream.url, headers: stream.headers, expiresAt }, config.secret);
      return new NextResponse(rewritePlaylist(selected.playlist, selected.sourceUrl, stream.headers, config.secret, expiresAt), {
        status: 200,
        headers: {
          'Cache-Control': 'private, no-store', 'Content-Type': 'application/vnd.apple.mpegurl',
          'X-Vidnest-Stream-Id': String(selected.index),
        },
      });
    } catch (error) {
      controller.abort();
      await Promise.allSettled([completion, primaryProbe?.then((probe) => probe.complete)]);
      throw error;
    }
  }
  const streams = await resolvedStreams(coordinates, target, config.secret, key, request.signal);
  const stream = streams[streamIndex];
  const streamUrl = stream?.url;
  if (!stream || typeof streamUrl !== 'string') return jsonError('No playback source is available.', 404);
  const expiresAt = Math.min(Date.now() + TOKEN_TTL_MS, stream.expiresAt ?? Infinity);
  if (params.get('cast') === '1') return castCapability({ url: streamUrl, headers: stream.headers, expiresAt }, config.secret);

  const token = createToken({
    url: streamUrl,
    headers: stream.headers,
    expiresAt,
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
    if (!token) {
      const address = requestIp(request.headers);
      if (!address && process.env.NODE_ENV === 'production') return jsonError('Playback request identity is unavailable.', 503);
      if (address && !allowResolverRequest(address)) return jsonError('Too many playback resolution requests.', 429);
    }
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
    const causeCode = error instanceof Error && error.cause && typeof error.cause === 'object'
      && 'code' in error.cause && typeof error.cause.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(error.cause.code)
      ? error.cause.code : undefined;
    console.warn(JSON.stringify({
      event: 'vidnest_route_error',
      errorName: error instanceof Error ? error.name : 'UnknownError',
      ...(causeCode ? { causeCode } : {}),
    }));
    if (error instanceof Error && error.name === 'AbortError') return jsonError('Playback request timed out.', 504);
    return jsonError('Playback is temporarily unavailable.', 502);
  }
}
