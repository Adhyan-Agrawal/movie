export interface IntroMarker {
  startSeconds: number;
  endSeconds: number;
}

export interface IntroCatalogResponse {
  intro: IntroMarker | null;
}

export interface IntroCatalogRequest {
  type: 'tv';
  imdbId: string;
  season: number;
  episode: number;
}

export type IntroResolution =
  | { status: 'positive'; intro: IntroMarker }
  | { status: 'no_intro'; intro: null }
  | { status: 'unknown'; intro: null }
  | { status: 'unavailable'; intro: null; retryAfterMs?: number };

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
type CacheEntry = { promise: Promise<IntroResolution>; expiresAt?: number };

const INTRODB_ENDPOINT = 'https://api.introdb.app/segments';
const INTRODB_TIMEOUT_MS = 4_000;
const INTRODB_MAX_BYTES = 64 * 1024;
const POSITIVE_TTL_MS = 10 * 60 * 1000;
const NO_INTRO_TTL_MS = 2 * 60 * 1000;
const FAILURE_BACKOFF_MS = 5 * 1000;
const MAX_FAILURE_BACKOFF_MS = 60 * 1000;
const MAX_CACHE_ENTRIES = 128;
const IMDB_ID_RE = /^tt\d{7,12}$/;
const SEASON_RE = /^(?:0|[1-9]\d{0,2})$/;
const EPISODE_RE = /^[1-9]\d{0,2}$/;
const REQUEST_KEYS = new Set(['type', 'imdbId', 'season', 'episode']);
const RESPONSE_KEYS = [
  'imdb_id', 'media_type', 'is_movie', 'season', 'episode', 'intro', 'recap', 'outro',
  'post_credits', 'no_intro', 'no_recap', 'no_outro',
] as const;
const SEGMENT_KEYS = [
  'start_sec', 'end_sec', 'start_ms', 'end_ms', 'confidence', 'submission_count', 'updated_at',
] as const;
const REQUIRED_SEGMENT_KEYS = [
  'start_sec', 'end_sec', 'start_ms', 'end_ms', 'confidence', 'submission_count',
] as const;
const INVALID_SEGMENT = Symbol('invalid-introdb-segment');

function unavailable(retryAfterMs?: number): IntroResolution {
  return retryAfterMs === undefined
    ? { status: 'unavailable', intro: null }
    : { status: 'unavailable', intro: null, retryAfterMs };
}

function unknown(): IntroResolution {
  return { status: 'unknown', intro: null };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function canonicalRequest(input: {
  type?: string;
  imdbId?: string;
  season?: number;
  episode?: number;
}): IntroCatalogRequest | null {
  if (
    input.type !== 'tv'
    || !input.imdbId
    || !IMDB_ID_RE.test(input.imdbId)
    || !Number.isSafeInteger(input.season)
    || input.season! < 0
    || input.season! > 999
    || !Number.isSafeInteger(input.episode)
    || input.episode! < 1
    || input.episode! > 999
  ) {
    return null;
  }
  return { type: 'tv', imdbId: input.imdbId, season: input.season!, episode: input.episode! };
}

export function parseIntroCatalogRequest(params: URLSearchParams): IntroCatalogRequest | null {
  for (const key of params.keys()) {
    if (!REQUEST_KEYS.has(key) || params.getAll(key).length !== 1) return null;
  }
  const type = params.get('type');
  const imdbId = params.get('imdbId');
  const season = params.get('season');
  const episode = params.get('episode');
  if (!type || !imdbId || season === null || episode === null || !SEASON_RE.test(season) || !EPISODE_RE.test(episode)) {
    return null;
  }
  return canonicalRequest({ type, imdbId, season: Number(season), episode: Number(episode) });
}

export function introCatalogPath(input: {
  type?: string;
  imdbId?: string;
  season?: number;
  episode?: number;
}): string | undefined {
  const request = canonicalRequest(input);
  if (!request) return undefined;
  const params = new URLSearchParams({
    type: request.type,
    imdbId: request.imdbId,
    season: String(request.season),
    episode: String(request.episode),
  });
  return `/api/intro?${params.toString()}`;
}

function parseProviderSegment(value: unknown): IntroMarker | null | typeof INVALID_SEGMENT {
  if (value === null) return null;
  if (!isRecord(value)) return INVALID_SEGMENT;
  const keys = Object.keys(value);
  if (keys.some((key) => !SEGMENT_KEYS.includes(key as (typeof SEGMENT_KEYS)[number]))
    || REQUIRED_SEGMENT_KEYS.some((key) => !Object.hasOwn(value, key))) return INVALID_SEGMENT;
  const start = value.start_sec;
  const end = value.end_sec;
  const startMs = value.start_ms;
  const endMs = value.end_ms;
  const confidence = value.confidence;
  const submissions = value.submission_count;
  const updatedAt = value.updated_at;
  if (
    typeof start !== 'number'
    || typeof end !== 'number'
    || !Number.isFinite(start)
    || !Number.isFinite(end)
    || start < 0
    || start >= end
    || typeof startMs !== 'number'
    || typeof endMs !== 'number'
    || !Number.isFinite(startMs)
    || !Number.isFinite(endMs)
    || startMs < 0
    || startMs >= endMs
    || typeof confidence !== 'number'
    || !Number.isFinite(confidence)
    || confidence < 0
    || confidence > 1
    || typeof submissions !== 'number'
    || !Number.isSafeInteger(submissions)
    || submissions < 1
    || Math.abs(start * 1000 - startMs) > 1
    || Math.abs(end * 1000 - endMs) > 1
    || (updatedAt !== undefined && (typeof updatedAt !== 'string' || !updatedAt || !Number.isFinite(Date.parse(updatedAt))))
  ) {
    return INVALID_SEGMENT;
  }
  return { startSeconds: start, endSeconds: end };
}

export function normalizeIntroDbResponse(value: unknown, request: IntroCatalogRequest): IntroResolution {
  if (!isRecord(value) || !hasExactKeys(value, RESPONSE_KEYS)) return unavailable();
  if (
    value.imdb_id !== request.imdbId
    || value.media_type !== 'tv'
    || value.is_movie !== false
    || value.season !== request.season
    || value.episode !== request.episode
    || typeof value.no_intro !== 'boolean'
    || typeof value.no_recap !== 'boolean'
    || typeof value.no_outro !== 'boolean'
  ) {
    return unavailable();
  }

  const intro = parseProviderSegment(value.intro);
  const recap = parseProviderSegment(value.recap);
  const outro = parseProviderSegment(value.outro);
  const postCredits = parseProviderSegment(value.post_credits);
  if (
    intro === INVALID_SEGMENT
    || recap === INVALID_SEGMENT
    || outro === INVALID_SEGMENT
    || postCredits === INVALID_SEGMENT
  ) return unavailable();
  if ((intro && value.no_intro) || (recap && value.no_recap) || (outro && value.no_outro)) return unavailable();
  if (intro) return { status: 'positive', intro };
  return value.no_intro ? { status: 'no_intro', intro: null } : unknown();
}

async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json' && !contentType?.endsWith('+json')) {
    await response.body?.cancel();
    throw new Error('Intro provider returned a non-JSON response.');
  }
  if (!response.body) throw new Error('Intro provider returned an empty response.');

  const lengthHeader = response.headers.get('content-length');
  const contentLength = lengthHeader === null ? null : Number(lengthHeader);
  if (contentLength !== null && Number.isFinite(contentLength) && contentLength > INTRODB_MAX_BYTES) {
    await response.body.cancel();
    throw new Error('Intro provider response is too large.');
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > INTRODB_MAX_BYTES) {
        await reader.cancel();
        throw new Error('Intro provider response is too large.');
      }
      chunks.push(result.value);
    }
  } finally {
    signal.removeEventListener('abort', cancel);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
}

export function createIntroResolver(options: { fetchImpl?: FetchLike; now?: () => number } = {}) {
  const fetchImpl = options.fetchImpl ?? ((input: string | URL, init?: RequestInit) => fetch(input, init));
  const now = options.now ?? (() => Date.now());
  const cache = new Map<string, CacheEntry>();

  const resolve = (input: IntroCatalogRequest): Promise<IntroResolution> => {
    const request = canonicalRequest(input);
    if (!request) return Promise.resolve(unavailable());
    const key = `${request.imdbId}:${request.season}:${request.episode}`;
    const currentTime = now();
    for (const [entryKey, entry] of cache) {
      if (entry.expiresAt !== undefined && entry.expiresAt <= currentTime) cache.delete(entryKey);
    }
    const existing = cache.get(key);
    if (existing) return existing.promise;
    if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);

    const entry: CacheEntry = { promise: Promise.resolve(unavailable()) };
    entry.promise = (async () => {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new DOMException('Intro provider request timed out.', 'AbortError'));
        }, INTRODB_TIMEOUT_MS);
      });

      const load = async (): Promise<IntroResolution> => {
        const url = new URL(INTRODB_ENDPOINT);
        url.searchParams.set('imdb_id', request.imdbId);
        url.searchParams.set('season', String(request.season));
        url.searchParams.set('episode', String(request.episode));
        const response = await fetchImpl(url, {
          method: 'GET',
          headers: { Accept: 'application/json', 'Accept-Encoding': 'identity' },
          redirect: 'error',
          cache: 'no-store',
          credentials: 'omit',
          signal: controller.signal,
        });
        if (response.status === 404) {
          await response.body?.cancel();
          return unknown();
        }
        if (response.status !== 200) {
          const retryAfter = response.headers.get('retry-after');
          await response.body?.cancel();
          const retrySeconds = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : undefined;
          return unavailable(retrySeconds === undefined
            ? FAILURE_BACKOFF_MS
            : Math.min(MAX_FAILURE_BACKOFF_MS, Math.max(1_000, retrySeconds * 1000)));
        }
        return normalizeIntroDbResponse(await boundedJson(response, controller.signal), request);
      };

      try {
        return await Promise.race([load(), deadline]);
      } catch {
        return unavailable(FAILURE_BACKOFF_MS);
      } finally {
        if (timer) clearTimeout(timer);
      }
    })();
    cache.set(key, entry);
    void entry.promise.then((result) => {
      if (cache.get(key) !== entry) return;
      const ttl = result.status === 'positive'
        ? POSITIVE_TTL_MS
        : result.status === 'no_intro' ? NO_INTRO_TTL_MS
          : result.status === 'unavailable'
            ? Math.min(MAX_FAILURE_BACKOFF_MS, Math.max(1_000, result.retryAfterMs ?? FAILURE_BACKOFF_MS))
            : 0;
      if (ttl > 0) entry.expiresAt = now() + ttl;
      else cache.delete(key);
    });
    return entry.promise;
  };

  return { resolve, clear: () => cache.clear() };
}

const introResolver = createIntroResolver();

export function resolveIntroMarker(request: IntroCatalogRequest): Promise<IntroResolution> {
  return introResolver.resolve(request);
}
