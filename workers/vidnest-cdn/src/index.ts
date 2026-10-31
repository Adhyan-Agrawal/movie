const TOKEN_CONTEXT = 'vidnest-proxy:aes-256-gcm:v1';
const TOKEN_TTL_MS = 4 * 60 * 60 * 1000;
const MAX_TOKEN_LENGTH = 16 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_MEDIA_CACHE_BYTES = 32 * 1024 * 1024;
const MAX_SUBTITLE_CACHE_BYTES = 2 * 1024 * 1024;
const MANIFEST_CACHE_SECONDS = 10;
const SUBTITLE_CACHE_SECONDS = 60 * 60;
const MEDIA_CACHE_SECONDS = 24 * 60 * 60;
const CACHE_KEY_ORIGIN = 'https://vidnest-cache.invalid';
const EDGE_PATH = '/media';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Range, If-Range',
  'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Range, Content-Length, Content-Type, ETag, Last-Modified',
};

const RESPONSE_HEADERS = [
  'accept-ranges',
  'content-length',
  'content-range',
  'content-type',
  'etag',
  'last-modified',
] as const;

type SafeHeaders = Record<string, string>;
type Capability = { expiresAt: number; headers: SafeHeaders; url: string };

export interface Env {
  VIDNEST_API_SECRET: string;
  VIDNEST_ORIGIN_URL: string;
}

export interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface EdgeCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

export interface WorkerServices {
  cache: EdgeCache;
  fetch: typeof globalThis.fetch;
}

function base64UrlDecode(value: string): Uint8Array | null {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const padding = '='.repeat((4 - value.length % 4) % 4);
    const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + padding);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return base64UrlEncode(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
}

function base64UrlEncode(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function safeHttpsUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.length > 8192 || /[\r\n]/.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function safeHeaders(value: unknown): SafeHeaders | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result: SafeHeaders = {};
  const entries = Object.entries(value);
  if (entries.length > 2) return null;
  for (const [name, header] of entries) {
    if (name !== 'origin' && name !== 'referer') return null;
    if (typeof header !== 'string' || header !== header.trim() || !safeHttpsUrl(header)) return null;
    result[name] = header;
  }
  return result;
}

async function decryptCapability(token: string, secret: string, now: number): Promise<Capability | null> {
  if (!secret || secret.length < 32 || !token || token.length > MAX_TOKEN_LENGTH) return null;
  try {
    const parts = token.split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') return null;
    const nonce = base64UrlDecode(parts[1]!);
    const ciphertext = base64UrlDecode(parts[2]!);
    const tag = base64UrlDecode(parts[3]!);
    if (nonce?.length !== 12 || !ciphertext?.length || tag?.length !== 16) return null;

    const context = new TextEncoder().encode(TOKEN_CONTEXT);
    const hmac = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    const derived = await crypto.subtle.sign('HMAC', hmac, context);
    const key = await crypto.subtle.importKey('raw', derived, 'AES-GCM', false, ['decrypt']);
    const encrypted = new Uint8Array(ciphertext.length + tag.length);
    encrypted.set(ciphertext);
    encrypted.set(tag, ciphertext.length);
    const plaintext = await crypto.subtle.decrypt({
      name: 'AES-GCM', iv: nonce, additionalData: context, tagLength: 128,
    }, key, encrypted);
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const payload = value as Record<string, unknown>;
    const url = safeHttpsUrl(payload.url);
    const headers = safeHeaders(payload.headers);
    if (!url || !headers || typeof payload.expiresAt !== 'number' || !Number.isSafeInteger(payload.expiresAt)
      || payload.expiresAt <= now || payload.expiresAt > now + TOKEN_TTL_MS) return null;
    return { expiresAt: payload.expiresAt, headers, url };
  } catch {
    return null;
  }
}

function originBaseUrl(value: string): URL | null {
  const normalized = safeHttpsUrl(value);
  if (!normalized) return null;
  const url = new URL(normalized);
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (url.search || url.hash || url.pathname !== '/' || hostname === 'localhost' || hostname.endsWith('.localhost')
    || hostname.endsWith('.local') || hostname.endsWith('.internal') || hostname.endsWith('.home.arpa')
    || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':')) return null;
  return url;
}

function sanitizedHeaders(source?: Headers): Headers {
  const headers = new Headers({ ...CORS_HEADERS, 'Cache-Control': 'private, no-store' });
  if (!source) return headers;
  for (const name of RESPONSE_HEADERS) {
    const value = source.get(name);
    if (value !== null) headers.set(name, value);
  }
  return headers;
}

function errorResponse(status: number, method: string, message = 'Playback request failed.'): Response {
  const headers = sanitizedHeaders();
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(method === 'HEAD' ? null : JSON.stringify({ error: message }), { status, headers });
}

function clientResponse(response: Response, method: string): Response {
  const head = method === 'HEAD';
  if (head) void response.body?.cancel().catch(() => undefined);
  return new Response(head ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: sanitizedHeaders(response.headers),
  });
}

function isHls(headers: Headers): boolean {
  const contentType = headers.get('content-type')?.toLowerCase() ?? '';
  return contentType.includes('mpegurl') || contentType.includes('m3u8');
}

async function boundedText(response: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
  if (!response.body) return '';
  const declared = response.headers.get('content-length');
  if (declared && Number(declared) > maxBytes) {
    await response.body.cancel();
    throw new Error('Response exceeds edge limit.');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  try {
    while (true) {
      if (signal.aborted) throw new DOMException('Request aborted.', 'AbortError');
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) throw new Error('Response exceeds edge limit.');
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function childEdgeUrl(value: string, origin: URL, edgePath: string): string {
  if (/^data:/i.test(value)) return value;
  const child = new URL(value, origin);
  if (child.origin !== origin.origin || child.pathname !== '/api/vidnest') {
    throw new Error('Origin returned an unprotected manifest URI.');
  }
  const allowed = new Set(['token', 'rendition']);
  if ([...child.searchParams.keys()].some((name) => !allowed.has(name))) {
    throw new Error('Origin returned an invalid manifest capability.');
  }
  const tokens = child.searchParams.getAll('token');
  if (tokens.length !== 1 || !tokens[0] || tokens[0].length > MAX_TOKEN_LENGTH) {
    throw new Error('Origin returned an invalid manifest capability.');
  }
  const result = new URL('https://vidnest-edge.invalid');
  result.pathname = edgePath;
  result.searchParams.set('token', tokens[0]);
  const rendition = child.searchParams.get('rendition');
  if (rendition !== null) {
    if (!/^\d{1,6}$/.test(rendition)) throw new Error('Origin returned an invalid rendition.');
    result.searchParams.set('rendition', rendition);
  }
  return `${result.pathname}${result.search}`;
}

function rewriteManifest(playlist: string, origin: URL, edgePath: string): string {
  return playlist
    .split(/(\r?\n)/)
    .map((line) => {
      if (!line || line === '\n' || line === '\r\n') return line;
      if (!line.startsWith('#')) return childEdgeUrl(line, origin, edgePath);
      return line.replace(/URI="([^"]+)"/g, (_match, value: string) => `URI="${childEdgeUrl(value, origin, edgePath)}"`);
    })
    .join('');
}

async function cacheKey(capability: Capability, rendition: string | null): Promise<Request> {
  const canonical = JSON.stringify({
    headers: Object.entries(capability.headers).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
    rendition,
    url: capability.url,
  });
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical)));
  return new Request(`${CACHE_KEY_ORIGIN}/v1/${base64UrlEncode(digest)}`);
}

function contentLength(headers: Headers): number | null {
  const raw = headers.get('content-length');
  if (!raw || !/^\d{1,12}$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

function cacheTtl(response: Response, capability: Capability, manifest: boolean): number {
  if (response.status !== 200 || response.headers.has('set-cookie')) return 0;
  if (manifest) return MANIFEST_CACHE_SECONDS;
  const length = contentLength(response.headers);
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  const pathname = new URL(capability.url).pathname.toLowerCase();
  if (/\.(?:key|bin)$/.test(pathname)) return 0;
  if (contentType === 'text/vtt') {
    return length !== null && length > 0 && length <= MAX_SUBTITLE_CACHE_BYTES ? SUBTITLE_CACHE_SECONDS : 0;
  }
  const media = contentType.startsWith('video/') || contentType.startsWith('audio/')
    || contentType === 'application/mp4' || contentType === 'application/mpeg';
  return media && length !== null && length > 0 && length <= MAX_MEDIA_CACHE_BYTES ? MEDIA_CACHE_SECONDS : 0;
}

function scheduleCachePut(
  cache: EdgeCache, key: Request, response: Response, ttl: number, context: WorkerExecutionContext,
): void {
  if (!ttl) return;
  // The origin stays private/no-store for clients. Only this bounded internal copy is shared,
  // and every read is still preceded by capability authentication and expiry validation.
  const cached = response.clone();
  const headers = new Headers(cached.headers);
  headers.set('Cache-Control', `public, max-age=${ttl}`);
  const stored = new Response(cached.body, { status: cached.status, statusText: cached.statusText, headers });
  context.waitUntil(cache.put(key, stored).catch(() => undefined));
}

function defaultServices(): WorkerServices {
  const storage = globalThis.caches as CacheStorage & { default: Cache };
  return {
    cache: storage.default as unknown as EdgeCache,
    fetch: (input, init) => globalThis.fetch(input, init),
  };
}

export async function handleRequest(
  request: Request,
  env: Env,
  context: WorkerExecutionContext,
  services: WorkerServices = defaultServices(),
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestUrl = new URL(request.url);
  if (requestUrl.pathname !== EDGE_PATH) {
    return errorResponse(404, method, 'Playback endpoint not found.');
  }
  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: sanitizedHeaders() });
  }
  if (method !== 'GET' && method !== 'HEAD') {
    const response = errorResponse(405, method, 'Method not allowed.');
    response.headers.set('Allow', 'GET, HEAD, OPTIONS');
    return response;
  }

  const allowedQuery = new Set(['token', 'rendition']);
  if ([...requestUrl.searchParams.keys()].some((name) => !allowedQuery.has(name))) {
    return errorResponse(400, method, 'Invalid playback request.');
  }
  const tokens = requestUrl.searchParams.getAll('token');
  if (tokens.length !== 1 || !tokens[0]) return errorResponse(403, method, 'A playback capability is required.');

  // Authorization and expiry validation always happen before deriving or reading the shared cache key.
  const capability = await decryptCapability(tokens[0], env.VIDNEST_API_SECRET, Date.now());
  if (!capability) return errorResponse(403, method, 'Invalid or expired playback capability.');
  const origin = originBaseUrl(env.VIDNEST_ORIGIN_URL);
  if (!origin) return errorResponse(503, method, 'VidNest edge origin is not configured.');
  const rendition = requestUrl.searchParams.get('rendition');
  if (rendition !== null && !/^\d{1,6}$/.test(rendition)) {
    return errorResponse(400, method, 'Invalid rendition.');
  }

  const range = request.headers.get('range');
  const ifRange = request.headers.get('if-range');
  if ((range && range.length > 256) || (ifRange && ifRange.length > 256)) {
    return errorResponse(400, method, 'Invalid range request.');
  }
  const ranged = range !== null;
  const key = await cacheKey(capability, rendition);
  if (!ranged) {
    const hit = await services.cache.match(key);
    if (hit) return clientResponse(hit, method);
  }

  const originUrl = new URL('/api/vidnest', origin);
  originUrl.searchParams.set('token', tokens[0]);
  if (rendition !== null) originUrl.searchParams.set('rendition', rendition);
  const originHeaders = new Headers();
  if (range !== null) originHeaders.set('Range', range);
  if (ifRange !== null) originHeaders.set('If-Range', ifRange);
  const originRequest = new Request(originUrl, {
    method,
    headers: originHeaders,
    redirect: 'manual',
    signal: request.signal,
  });
  const upstream = await services.fetch(originRequest);
  if (upstream.status >= 300 && upstream.status < 400) {
    await upstream.body?.cancel();
    return errorResponse(502, method, 'VidNest origin returned an unsafe redirect.');
  }
  if (method === 'HEAD') return clientResponse(upstream, method);
  if (upstream.status === 416) {
    await upstream.body?.cancel();
    return new Response(null, { status: 416, headers: sanitizedHeaders(upstream.headers) });
  }
  if (!upstream.ok || !upstream.body) {
    await upstream.body?.cancel();
    return errorResponse(upstream.status >= 400 && upstream.status <= 599 ? upstream.status : 502, method);
  }

  if (isHls(upstream.headers)) {
    try {
      const playlist = await boundedText(upstream, MAX_MANIFEST_BYTES, request.signal);
      const rewritten = rewriteManifest(playlist, origin, EDGE_PATH);
      const headers = sanitizedHeaders(upstream.headers);
      const length = new TextEncoder().encode(rewritten).byteLength;
      headers.set('Content-Type', 'application/vnd.apple.mpegurl');
      headers.set('Content-Length', String(length));
      headers.delete('Content-Range');
      const response = new Response(rewritten, { status: 200, headers });
      const ttl = upstream.headers.has('set-cookie') ? 0 : cacheTtl(response, capability, true);
      scheduleCachePut(services.cache, key, response, ttl, context);
      return response;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      return errorResponse(502, method, 'VidNest manifest is unavailable.');
    }
  }

  const response = clientResponse(upstream, method);
  scheduleCachePut(services.cache, key, response, ranged ? 0 : cacheTtl(upstream, capability, false), context);
  return response;
}

const worker = {
  fetch(request: Request, env: Env, context: WorkerExecutionContext): Promise<Response> {
    return handleRequest(request, env, context);
  },
};

export default worker;
