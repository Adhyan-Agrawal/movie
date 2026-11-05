if (typeof window !== 'undefined') {
  throw new Error('The VidNest resolver is server-only.');
}

const API_BASE_URL = 'https://new.vidnest.fun';
const SITE_BASE_URL = 'https://vidnest.fun';
const NONCE_BYTES = 16;
const IV_BYTES = 12;
const DEFAULT_SERVER_TIMEOUT_MS = 4_000;
const DEFAULT_KEY_LOOKUP_TIMEOUT_MS = 10_000;
const KEY_PAGE_FALLBACK = '/movie/324857';
const CHUNK_PATTERN = /\/_next\/static\/chunks\/[a-zA-Z0-9]+\.js/g;
const MAX_PAGE_BYTES = 512 * 1024;
const MAX_CHUNK_BYTES = 512 * 1024;
const MAX_CHUNKS = 16;
const MAX_CHUNK_CONCURRENCY = 4;
const MAX_CHUNK_AGGREGATE_BYTES = 2 * 1024 * 1024;
const MAX_KEY_CANDIDATES = 512;
const MAX_PROVIDER_BYTES = 256 * 1024;
const MAX_STREAM_CANDIDATES = 128;
const MAX_STREAMS = 32;
const MAX_URL_LENGTH = 4_096;
const MAX_TYPE_LENGTH = 128;

const HEADERS: HeadersInit = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
  Accept: 'application/json, text/javascript, */*; q=0.01',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: `${SITE_BASE_URL}/`,
  Origin: SITE_BASE_URL,
};

const PAGE_HEADERS: HeadersInit = {
  ...HEADERS,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

const DEFAULT_SERVERS = [
  'nextgencloudfabric',
  'hollymoviehd',
  'klikxxi',
  'rpmvid',
  'allmovies',
  'flixhq',
] as const;
const MAX_SERVERS = DEFAULT_SERVERS.length;

const CARRIED_HEADERS = ['referer', 'origin'] as const;

export type VidnestMediaType = 'movie' | 'tv';

export type InspectVidnestInput = {
  tmdbId: string;
  mediaType?: VidnestMediaType;
  season?: number | null;
  episode?: number | null;
  signal?: AbortSignal;
  onPrimary?: (streams: VidnestStream[]) => void;
};

export type VidnestStream = {
  url: string;
  type: string | null;
  headers: Record<string, string>;
};

export type VidnestResolution = {
  provider: 'vidnest';
  streams: VidnestStream[];
};

type ResolverContext = Required<Pick<InspectVidnestInput, 'tmdbId' | 'mediaType'>> & {
  season: number | null;
  episode: number | null;
};

type KeyProbe = { sealed: string; nonce: string };
type FetchImplementation = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type CreateVidnestResolverOptions = {
  fetchImpl?: FetchImplementation;
  servers?: readonly string[];
  serverTimeoutMs?: number;
  keyLookupTimeoutMs?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

class ResponseSizeError extends Error {}
type ByteBudget = { remaining: number };

function isPublicHostname(value: string): boolean {
  const host = value.replace(/^\[|\]$/g, '').replace(/\.+$/, '').toLowerCase();
  if (!host || !host.includes('.') || host.includes(':') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return false;
  if (host.length > 253 || host.split('.').some((label) =>
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return false;
  return host !== 'localhost' && !host.endsWith('.localhost') && !host.endsWith('.local')
    && !host.endsWith('.internal') && !host.endsWith('.home') && !host.endsWith('.lan')
    && !host.endsWith('.test') && !host.endsWith('.invalid') && !host.endsWith('.example')
    && !host.endsWith('.onion') && !host.endsWith('.arpa');
}

function publicHttpsUrl(value: string): string | null {
  if (!value || value.length > MAX_URL_LENGTH || /[\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || !isPublicHostname(url.hostname)
      || url.href.length > MAX_URL_LENGTH) return null;
    return url.href;
  } catch {
    return null;
  }
}

async function boundedText(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
  sharedBudget?: ByteBudget,
): Promise<string> {
  if (!response.body) return '';
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > maxBytes) {
    void response.body.cancel().catch(() => undefined);
    throw new ResponseSizeError('VidNest response exceeds its size limit.');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  let text = '';
  let total = 0;
  try {
    while (true) {
      if (signal.aborted) throw new DOMException('VidNest request timed out.', 'AbortError');
      const chunk = await reader.read();
      if (chunk.done) return text + decoder.decode();
      if (sharedBudget) {
        if (chunk.value.byteLength > sharedBudget.remaining) {
          sharedBudget.remaining = 0;
          throw new ResponseSizeError('VidNest response exceeds its aggregate size limit.');
        }
        sharedBudget.remaining -= chunk.value.byteLength;
      }
      total += chunk.value.byteLength;
      if (total > maxBytes) throw new ResponseSizeError('VidNest response exceeds its size limit.');
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel();
    reader.releaseLock();
  }
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array {
  const standard = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(standard + '='.repeat((4 - (standard.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function newNonce(): string {
  return toBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
}

async function sealingKey(nonce: string, appKey: string): Promise<CryptoKey> {
  const material = new TextEncoder().encode(`${nonce}|${appKey}`);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', material);
  return globalThis.crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['decrypt']);
}

async function unseal(sealed: string, nonce: string, appKey: string): Promise<string> {
  const bytes = fromBase64Url(sealed);
  if (bytes.length < IV_BYTES + 16) throw new Error('The sealed payload is too short.');
  const plain = await globalThis.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytes.subarray(0, IV_BYTES) },
    await sealingKey(nonce, appKey),
    bytes.subarray(IV_BYTES),
  );
  return new TextDecoder().decode(plain);
}

async function withDeadline<T>(
  timeoutMs: number,
  parentSignal: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  const abortError = () => new DOMException('VidNest request timed out.', 'AbortError');
  let rejectAbort!: (reason: DOMException) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const rejectOnAbort = () => rejectAbort(abortError());
  controller.signal.addEventListener('abort', rejectOnAbort, { once: true });
  parentSignal?.addEventListener('abort', forwardAbort, { once: true });
  if (parentSignal?.aborted) controller.abort();
  const deadline = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const execution = Promise.resolve().then(() => {
      if (controller.signal.aborted) throw abortError();
      return run(controller.signal);
    });
    return await Promise.race([execution, aborted]);
  } finally {
    clearTimeout(deadline);
    controller.signal.removeEventListener('abort', rejectOnAbort);
    parentSignal?.removeEventListener('abort', forwardAbort);
  }
}

async function waitWithoutCancelling<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw new DOMException('VidNest request was aborted.', 'AbortError');
  let rejectAbort!: (reason: DOMException) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(new DOMException('VidNest request was aborted.', 'AbortError'));
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function carriedHeaders(raw: unknown): Record<string, string> {
  if (!isRecord(raw)) return {};
  const headers: Record<string, string> = {};
  for (const name of CARRIED_HEADERS) {
    const alternate = name === 'referer' ? 'Referer' : 'Origin';
    const value = raw[name] ?? raw[alternate];
    if (typeof value !== 'string') continue;
    const url = publicHttpsUrl(value);
    if (url) headers[name] = url;
  }
  return headers;
}

function streamType(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const type = value.trim();
  return type && type.length <= MAX_TYPE_LENGTH && !/[\u0000-\u001f\u007f]/.test(type) ? type : null;
}

function urlOf(raw: Record<string, unknown>): string | null {
  for (const key of ['url', 'file', 'link', 'playlist']) {
    const value = raw[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function streamFrom(raw: unknown): VidnestStream | null {
  if (!isRecord(raw)) return null;
  const url = urlOf(raw);
  const safeUrl = typeof url === 'string' ? publicHttpsUrl(url) : null;
  if (!safeUrl) return null;
  return {
    url: safeUrl,
    type: streamType(raw.type),
    headers: carriedHeaders(raw.headers),
  };
}

function limitedStreams(candidates: readonly unknown[]): VidnestStream[] {
  const streams: VidnestStream[] = [];
  const limit = Math.min(candidates.length, MAX_STREAM_CANDIDATES);
  for (let index = 0; index < limit && streams.length < MAX_STREAMS; index += 1) {
    const stream = streamFrom(candidates[index]);
    if (stream) streams.push(stream);
  }
  return streams;
}

function streamsFrom(payload: unknown): VidnestStream[] {
  if (Array.isArray(payload)) return limitedStreams(payload);
  if (!isRecord(payload)) return [];
  for (const key of ['streams', 'sources']) {
    const candidates = payload[key];
    if (Array.isArray(candidates)) return limitedStreams(candidates);
  }
  const data = isRecord(payload.data) ? payload.data : undefined;
  const nestedStream = data?.stream ? streamFrom(data.stream) : null;
  if (nestedStream) return [nestedStream];
  const stream = streamFrom(payload);
  return stream ? [stream] : [];
}

function normalizedTimeout(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 1 && value <= 30_000 ? Math.floor(value) : fallback;
}

export function createVidnestResolver({
  fetchImpl,
  servers = DEFAULT_SERVERS,
  serverTimeoutMs = DEFAULT_SERVER_TIMEOUT_MS,
  keyLookupTimeoutMs = DEFAULT_KEY_LOOKUP_TIMEOUT_MS,
}: CreateVidnestResolverOptions = {}) {
  let appKey: string | null = null;
  const activeServers = [...new Set(servers.slice(0, MAX_SERVERS)
    .filter((server) => /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(server)))];
  const providerTimeoutMs = normalizedTimeout(serverTimeoutMs, DEFAULT_SERVER_TIMEOUT_MS);
  const lookupTimeoutMs = normalizedTimeout(keyLookupTimeoutMs, DEFAULT_KEY_LOOKUP_TIMEOUT_MS);
  const request: FetchImplementation = async (input, init) => {
    if (init?.signal?.aborted) throw new DOMException('VidNest request aborted.', 'AbortError');
    const requestInit: RequestInit = { ...init, redirect: 'manual' };
    const response = await (fetchImpl ? fetchImpl(input, requestInit) : globalThis.fetch(input, requestInit));
    if (init?.signal?.aborted) {
      void response.body?.cancel().catch(() => undefined);
      throw new DOMException('VidNest request aborted.', 'AbortError');
    }
    return response;
  };

  async function firstThatOpens(
    candidates: readonly string[],
    probe: KeyProbe,
    signal: AbortSignal,
  ): Promise<string | null> {
    for (const candidate of candidates) {
      if (signal.aborted) return null;
      try {
        await unseal(probe.sealed, probe.nonce, candidate);
        return candidate;
      } catch {
        // AES-GCM authentication rejects every candidate except the active key.
      }
    }
    return null;
  }

  async function chunksOf(
    path: string,
    signal: AbortSignal,
    inspectBatch: (sources: readonly string[]) => Promise<string | null>,
  ): Promise<{ key: string | null; sources: string[] }> {
    const page = await request(`${SITE_BASE_URL}${path}`, {
      headers: PAGE_HEADERS,
      cache: 'no-store',
      signal,
    });
    if (!page.ok) {
      void page.body?.cancel().catch(() => undefined);
      return { key: null, sources: [] };
    }
    const html = await boundedText(page, MAX_PAGE_BYTES, signal);
    const chunks: string[] = [];
    const seenChunks = new Set<string>();
    for (const match of html.matchAll(CHUNK_PATTERN)) {
      const chunk = match[0];
      if (seenChunks.has(chunk)) continue;
      seenChunks.add(chunk);
      chunks.push(chunk);
      if (chunks.length === MAX_CHUNKS) break;
    }
    const sources: string[] = [];
    const aggregateBudget: ByteBudget = { remaining: MAX_CHUNK_AGGREGATE_BYTES };
    let stop = false;
    for (let offset = 0; offset < chunks.length && !stop; offset += MAX_CHUNK_CONCURRENCY) {
      const batch = chunks.slice(offset, offset + MAX_CHUNK_CONCURRENCY);
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      const lookups = batch.map((chunk) => withDeadline(lookupTimeoutMs, controller.signal, async (chunkSignal) => {
        if (aggregateBudget.remaining === 0) return null;
        const response = await request(new URL(chunk, SITE_BASE_URL).href, {
          headers: PAGE_HEADERS, cache: 'no-store', signal: chunkSignal,
        });
        if (!response.ok) {
          void response.body?.cancel().catch(() => undefined);
          return null;
        }
        const source = await boundedText(response, MAX_CHUNK_BYTES, chunkSignal, aggregateBudget);
        if (!source || chunkSignal.aborted) return null;
        sources.push(source);
        return inspectBatch([source]);
      }).catch((error) => {
        if (signal.aborted || error instanceof ResponseSizeError) {
          stop = true;
          controller.abort();
        }
        return null;
      }));
      try {
        // Authenticate completed chunks immediately, rather than waiting for
        // unrelated slow chunks in the same bounded batch.
        const key = await Promise.any(lookups.map(async (lookup) => {
          const found = await lookup;
          if (!found || stop) throw new Error('No authenticated key in this chunk.');
          return found;
        })).catch(() => null);
        if (key) {
          controller.abort();
          await Promise.allSettled(lookups);
          return { key, sources };
        }
      } finally {
        signal.removeEventListener('abort', abort);
      }
    }
    return { key: null, sources };
  }

  async function discoverKey(probe: KeyProbe, context: ResolverContext, parentSignal?: AbortSignal): Promise<string | null> {
    try {
      return await withDeadline(lookupTimeoutMs, parentSignal, async (signal) => {
        const titlePage = context.mediaType === 'tv'
          ? `/tv/${context.tmdbId}/${context.season}/${context.episode}`
          : `/movie/${context.tmdbId}`;
        const seenCandidates = new Set<string>();
        let candidateBudget = MAX_KEY_CANDIDATES;

        async function keyFromSources(sources: readonly string[], pattern: RegExp): Promise<string | null> {
          if (candidateBudget === 0) return null;
          const candidates: string[] = [];
          sourceLoop:
          for (const source of sources) {
            for (const match of source.matchAll(new RegExp(pattern.source, 'g'))) {
              const candidate = match[1];
              if (!candidate || seenCandidates.has(candidate)) continue;
              seenCandidates.add(candidate);
              candidates.push(candidate);
              candidateBudget -= 1;
              if (candidateBudget === 0) break sourceLoop;
            }
          }
          return firstThatOpens(candidates, probe, signal);
        }

        for (const path of new Set([titlePage, KEY_PAGE_FALLBACK])) {
          if (candidateBudget === 0) return null;
          let chunkScan: { key: string | null; sources: string[] };
          try {
            chunkScan = await chunksOf(path, signal, (sources) => keyFromSources(
              sources,
              /"([A-Za-z0-9_-]{16,128})"\s*,\s*[A-Za-z_$][\w$]*\s*=\s*"https:\/\/new\.vidnest\.fun"/g,
            ));
          } catch (error) {
            if (signal.aborted) throw error;
            continue;
          }
          if (chunkScan.key) return chunkScan.key;
          if (chunkScan.sources.length === 0) continue;

          const sweptKey = await keyFromSources(chunkScan.sources, /"([A-Za-z0-9_+/=-]{24,96})"/g);
          if (sweptKey) return sweptKey;
        }
        return null;
      });
    } catch {
      return null;
    }
  }

  return async function inspect({
    tmdbId,
    mediaType = 'movie',
    season = null,
    episode = null,
    signal,
    onPrimary,
  }: InspectVidnestInput): Promise<VidnestResolution> {
    const startedAt = Date.now();
    if (!tmdbId) throw new Error('tmdbId is required for VidNest');
    const context: ResolverContext = { tmdbId, mediaType, season, episode };
    // Cloudflare associates subrequest I/O with one request context. Only the
    // discovered string is process-wide; in-flight discovery stays per inspect.
    let keyLookup: Promise<string | null> | null = null;

    async function appKeyFor(probe: KeyProbe): Promise<string | null> {
      if (appKey) return appKey;
      if (!keyLookup) {
        keyLookup = discoverKey(probe, context, signal)
          .then((found) => {
            if (found && !signal?.aborted) appKey = found;
            return found;
          })
          .finally(() => { keyLookup = null; });
      }
      return keyLookup;
    }

    async function askServer(path: string): Promise<VidnestStream[]> {
      try {
        const probe = await withDeadline(providerTimeoutMs, signal, async (providerSignal) => {
          const nonce = newNonce();
          const suffix = mediaType === 'tv'
            ? `/tv/${tmdbId}/${season}/${episode}`
            : `/movie/${tmdbId}`;
          const response = await request(`${API_BASE_URL}/${path}${suffix}?_n=${nonce}`, {
            headers: HEADERS,
            cache: 'no-store',
            signal: providerSignal,
          });
          if (!response.ok) {
            void response.body?.cancel().catch(() => undefined);
            return null;
          }

          const reply: unknown = JSON.parse(await boundedText(response, MAX_PROVIDER_BYTES, providerSignal));
          if (!isRecord(reply) || reply.v !== 2 || typeof reply.d !== 'string') return null;
          const openWith = typeof reply.n === 'string' ? reply.n : nonce;
          return { sealed: reply.d, nonce: openWith };
        });
        if (!probe) return [];
        const key = await waitWithoutCancelling(appKeyFor(probe), signal);
        if (!key) return [];

        try {
          return streamsFrom(JSON.parse(await unseal(probe.sealed, probe.nonce, key)) as unknown);
        } catch {
          // A well-formed reply that the cached key cannot open signals app-key rotation.
          if (appKey === key) appKey = null;
          const fresh = await waitWithoutCancelling(appKeyFor(probe), signal);
          if (!fresh) return [];
          return streamsFrom(JSON.parse(await unseal(probe.sealed, probe.nonce, fresh)) as unknown);
        }
      } catch {
        return [];
      }
    }

    // The fan-out remains parallel but is hard-capped to the built-in provider count.
    const answers = await Promise.all(activeServers.map(async (server, index) => {
      const streams = await askServer(server);
      // Only the first provider is a stable prefix of the complete catalog.
      // Publishing later providers early would change manual numeric indices.
      if (index === 0 && !signal?.aborted) onPrimary?.(streams);
      return streams;
    }));
    const streams = answers.flatMap((answer) => answer).slice(0, MAX_STREAMS);
    if (streams.length === 0) {
      console.warn(JSON.stringify({
        event: 'vidnest_resolver_empty',
        elapsedMs: Date.now() - startedAt,
        keyCached: Boolean(appKey),
        providerCount: activeServers.length,
      }));
    }
    return { provider: 'vidnest', streams };
  };
}

const defaultResolver = createVidnestResolver();

export function inspectVidnest(input: InspectVidnestInput): Promise<VidnestResolution> {
  return defaultResolver(input);
}
