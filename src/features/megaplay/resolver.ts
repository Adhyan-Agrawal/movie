if (typeof window !== 'undefined') {
  throw new Error('The MegaPlay resolver is server-only.');
}

const TMDB_ORIGIN = 'https://api.themoviedb.org';
const ANILIST_ENDPOINT = 'https://graphql.anilist.co/';
const MEGAPLAY_ORIGIN = 'https://megaplay.buzz';
const ANIMATION_GENRE_ID = 16;
const DEFAULT_TOTAL_TIMEOUT_MS = 10_000;
const MAX_TOTAL_RESPONSE_BYTES = 1_536 * 1024;
const MAX_TMDB_BYTES = 256 * 1024;
const MAX_ANILIST_BYTES = 256 * 1024;
const MAX_PAGE_BYTES = 128 * 1024;
const MAX_SOURCE_BYTES = 256 * 1024;
const MAX_ANILIST_RESULTS = 10;
const MAX_TRACKS = 32;
const MAX_SUBTITLES = 24;
const MAX_NESTED_SOURCES = 8;
const MAX_URL_LENGTH = 4_096;
const MAX_HEADER_COUNT = 8;
const MAX_HEADER_NAME_LENGTH = 64;
const MAX_HEADER_VALUE_LENGTH = 512;
const MAX_TITLE_LENGTH = 256;
const MAX_TITLE_ALIASES = 32;
const MAX_SEASONS = 100;
const MAX_SEASON = 100;
const MAX_EPISODE = 2_000;
const MAX_MEDIA_ID_LENGTH = 20;
const MAX_CIPHERTEXT_BYTES = 256 * 1024;
const MAX_ENCODED_CIPHERTEXT_LENGTH = Math.ceil(MAX_CIPHERTEXT_BYTES * 4 / 3) + 4;
const AES_BLOCK_BYTES = 16;
const AES_KEY_BYTES = 32;
const AES_KEY_TEXT = 'i?LMTAx0Q6,:}50U';
const AES_IV_TEXT = "W0;27ToaUpl_P%'c";
const VERSIONS = ['sub', 'dub'] as const;

const PROVIDER_REQUEST_HEADERS = {
  Accept: 'application/json, text/html;q=0.9, */*;q=0.8',
  Origin: MEGAPLAY_ORIGIN,
  Referer: `${MEGAPLAY_ORIGIN}/`,
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
} as const;

const STREAM_HEADERS = {
  origin: MEGAPLAY_ORIGIN,
  referer: `${MEGAPLAY_ORIGIN}/`,
} as const;

const ANILIST_QUERY = `query MegaPlayAnime($search:String!,$perPage:Int!){
  Page(page:1,perPage:$perPage){
    pageInfo{hasNextPage}
    media(search:$search,type:ANIME,sort:[SEARCH_MATCH,POPULARITY_DESC]){
      id type format episodes seasonYear startDate{year}
      title{english romaji native} synonyms
    }
  }
}`;

export type MegaPlayMediaType = 'movie' | 'tv';

export type ResolveMegaPlayInput = {
  tmdbId: string;
  mediaType: MegaPlayMediaType;
  season?: number | null;
  episode?: number | null;
  signal?: AbortSignal;
};

export type MegaPlaySubtitle = {
  url: string;
  language: string;
  label: string;
  kind: 'captions';
};

export type MegaPlayStream = {
  url: string;
  type: 'hls';
  headers: Record<string, string>;
  subtitles?: MegaPlaySubtitle[];
  audioLanguage?: string;
};

type FetchImplementation = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type CreateMegaPlayResolverOptions = {
  fetchImpl?: FetchImplementation;
  tmdbApiKey?: string;
  totalTimeoutMs?: number;
};

type EndpointKind = 'tmdb' | 'anilist' | 'megaplay';
type StreamVersion = (typeof VERSIONS)[number];
type ByteBudget = { remaining: number };
type ResolverCoordinates = {
  tmdbId: string;
  mediaType: MegaPlayMediaType;
  season: number;
  episode: number;
};
type TmdbAnime = {
  aliases: string[];
  year: number;
  mediaType: MegaPlayMediaType;
  season: number;
  episodeCount: number;
  seasonName?: string;
};
type AniListAnime = { id: number; episodes: number | null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function abortError(): DOMException {
  return new DOMException('MegaPlay resolution was aborted.', 'AbortError');
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function normalizedTimeout(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 && value <= 30_000
    ? Math.floor(value)
    : DEFAULT_TOTAL_TIMEOUT_MS;
}

async function withDeadline<T>(
  timeoutMs: number,
  parentSignal: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
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

function boundedHeaders(input: HeadersInit): Headers {
  const headers = new Headers(input);
  const entries = [...headers.entries()];
  if (entries.length > MAX_HEADER_COUNT || entries.some(([name, value]) =>
    name.length > MAX_HEADER_NAME_LENGTH || value.length > MAX_HEADER_VALUE_LENGTH
    || /[\u0000-\u001f\u007f]/.test(name) || /[\r\n]/.test(value))) {
    throw new Error('Unsafe request headers.');
  }
  return headers;
}

function endpointAllowed(kind: EndpointKind, url: URL): boolean {
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return false;

  if (kind === 'tmdb') {
    return url.hostname === 'api.themoviedb.org'
      && /^\/3\/(?:movie|tv)\/[1-9]\d{0,9}$/.test(url.pathname)
      && [...url.searchParams.keys()].every((key) => key === 'api_key')
      && url.searchParams.has('api_key');
  }
  if (kind === 'anilist') {
    return url.hostname === 'graphql.anilist.co' && url.pathname === '/' && !url.search;
  }
  if (url.hostname !== 'megaplay.buzz') return false;
  if (/^\/stream\/ani\/[1-9]\d{0,9}\/[1-9]\d{0,3}\/(?:sub|dub)$/.test(url.pathname)) {
    return !url.search;
  }
  return url.pathname === '/stream/getSourcesNew'
    && [...url.searchParams.keys()].every((key) => key === 'id' || key === 'type')
    && /^[1-9]\d{0,19}$/.test(url.searchParams.get('id') ?? '')
    && VERSIONS.includes(url.searchParams.get('type') as StreamVersion);
}

async function requestResponse(
  request: FetchImplementation,
  kind: EndpointKind,
  url: URL,
  init: RequestInit,
  signal: AbortSignal,
): Promise<Response> {
  if (!endpointAllowed(kind, url)) throw new Error('Blocked upstream endpoint.');
  const response = await request(url, {
    ...init,
    cache: 'no-store',
    headers: boundedHeaders(init.headers ?? {}),
    redirect: 'manual',
    signal,
  });
  if (response.status >= 300 && response.status < 400) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error('Upstream redirects are not allowed.');
  }
  if (response.url) {
    let finalUrl: URL;
    try {
      finalUrl = new URL(response.url);
    } catch {
      void response.body?.cancel().catch(() => undefined);
      throw new Error('Invalid upstream response URL.');
    }
    if (!endpointAllowed(kind, finalUrl)) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error('Blocked upstream response URL.');
    }
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error('Upstream request failed.');
  }
  return response;
}

async function boundedText(
  response: Response,
  maxBytes: number,
  budget: ByteBudget,
  signal: AbortSignal,
): Promise<string> {
  if (!response.body) return '';
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength >= 0
    && (contentLength > maxBytes || contentLength > budget.remaining)) {
    void response.body.cancel().catch(() => undefined);
    throw new Error('Upstream response exceeds its size limit.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  let total = 0;
  let text = '';
  try {
    while (true) {
      if (signal.aborted) throw abortError();
      const chunk = await reader.read();
      if (chunk.done) return text + decoder.decode();
      total += chunk.value.byteLength;
      budget.remaining -= chunk.value.byteLength;
      if (total > maxBytes || budget.remaining < 0) {
        throw new Error('Upstream response exceeds its size limit.');
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel();
    reader.releaseLock();
  }
}

async function boundedJson(
  response: Response,
  maxBytes: number,
  budget: ByteBudget,
  signal: AbortSignal,
): Promise<unknown> {
  return JSON.parse(await boundedText(response, maxBytes, budget, signal)) as unknown;
}

function boundedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const result = value.trim().replace(/\s+/g, ' ');
  return result && result.length <= maxLength && !/[\u0000-\u001f\u007f]/.test(result) ? result : null;
}

function yearFromDate(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-\d{2}-\d{2}$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  return Number.isSafeInteger(year) && year >= 1900 && year <= 2100 ? year : null;
}

function normalizeTitle(value: string): string {
  return value.normalize('NFKD')
    .replace(/\p{Mark}+/gu, '')
    .replace(/[ıİ]/g, 'i')
    .replace(/ß/g, 'ss')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .trim();
}

function ordinal(value: number): string {
  const lastTwo = value % 100;
  if (lastTwo >= 11 && lastTwo <= 13) return `${value}th`;
  if (value % 10 === 1) return `${value}st`;
  if (value % 10 === 2) return `${value}nd`;
  if (value % 10 === 3) return `${value}rd`;
  return `${value}th`;
}

function coordinatesOf(input: ResolveMegaPlayInput): ResolverCoordinates | null {
  if (!/^[1-9]\d{0,9}$/.test(input.tmdbId) || (input.mediaType !== 'movie' && input.mediaType !== 'tv')) {
    return null;
  }
  const episode = input.episode ?? 1;
  if (!Number.isSafeInteger(episode) || episode < 1 || episode > MAX_EPISODE) return null;
  if (input.mediaType === 'movie') {
    if (episode !== 1 || (input.season != null && input.season !== 1)) return null;
    return { tmdbId: input.tmdbId, mediaType: 'movie', season: 1, episode };
  }
  const season = input.season;
  if (!Number.isSafeInteger(season) || season == null || season < 1 || season > MAX_SEASON) return null;
  return { tmdbId: input.tmdbId, mediaType: 'tv', season, episode };
}

function configuredApiKey(injected: string | undefined): string | null {
  const key = (injected ?? process.env.TMDB_API_KEY)?.trim();
  return key && key.length <= MAX_HEADER_VALUE_LENGTH && !/[\u0000-\u001f\u007f]/.test(key) ? key : null;
}

function uniqueStrings(values: unknown[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const title = boundedString(value, MAX_TITLE_LENGTH);
    if (!title) continue;
    const key = normalizeTitle(title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(title);
    if (result.length === MAX_TITLE_ALIASES) break;
  }
  return result;
}

function parseTmdbAnime(payload: unknown, coordinates: ResolverCoordinates): TmdbAnime | null {
  if (!isRecord(payload) || !Array.isArray(payload.genres) || payload.genres.length > 64
    || !payload.genres.some((genre) => isRecord(genre) && genre.id === ANIMATION_GENRE_ID)) return null;

  if (coordinates.mediaType === 'movie') {
    const aliases = uniqueStrings([payload.title, payload.original_title]);
    const year = yearFromDate(payload.release_date);
    return aliases.length && year
      ? { aliases, year, mediaType: 'movie', season: 1, episodeCount: 1 }
      : null;
  }

  if (!Array.isArray(payload.seasons) || payload.seasons.length > MAX_SEASONS) return null;
  const seasons = payload.seasons.filter((season) => isRecord(season) && season.season_number === coordinates.season);
  if (seasons.length !== 1) return null;
  const selected = seasons[0]!;
  const episodeCount = selected.episode_count;
  if (!Number.isSafeInteger(episodeCount) || typeof episodeCount !== 'number'
    || episodeCount < 1 || episodeCount > MAX_EPISODE || coordinates.episode > episodeCount) return null;
  const aliases = uniqueStrings([payload.name, payload.original_name]);
  const year = yearFromDate(selected.air_date)
    ?? (coordinates.season === 1 ? yearFromDate(payload.first_air_date) : null);
  const seasonName = boundedString(selected.name, MAX_TITLE_LENGTH) ?? undefined;
  return aliases.length && year
    ? { aliases, year, mediaType: 'tv', season: coordinates.season, episodeCount, seasonName }
    : null;
}

function desiredTitleKeys(metadata: TmdbAnime): Set<string> {
  const keys = new Set<string>();
  for (const alias of metadata.aliases) {
    if (metadata.mediaType === 'movie' || metadata.season === 1) keys.add(normalizeTitle(alias));
    if (metadata.mediaType === 'tv') {
      keys.add(normalizeTitle(`${alias} Season ${metadata.season}`));
      keys.add(normalizeTitle(`${alias} ${ordinal(metadata.season)} Season`));
      if (metadata.seasonName) {
        const normalizedSeason = normalizeTitle(metadata.seasonName);
        if (normalizedSeason && normalizedSeason !== `season ${metadata.season}`) {
          keys.add(normalizeTitle(`${alias} ${metadata.seasonName}`));
          if (normalizedSeason.includes(normalizeTitle(alias))) keys.add(normalizedSeason);
        }
      }
    }
  }
  keys.delete('');
  return keys;
}

function compatibleAniListCandidate(
  raw: unknown,
  metadata: TmdbAnime,
  desiredTitles: ReadonlySet<string>,
): AniListAnime | null {
  if (!isRecord(raw) || raw.type !== 'ANIME' || !Number.isSafeInteger(raw.id)
    || typeof raw.id !== 'number' || raw.id < 1 || raw.id > 1_000_000_000) return null;
  const formats = metadata.mediaType === 'movie' ? ['MOVIE'] : ['TV', 'TV_SHORT', 'ONA'];
  if (typeof raw.format !== 'string' || !formats.includes(raw.format)) return null;
  const startDate = isRecord(raw.startDate) ? raw.startDate.year : null;
  const year = Number.isSafeInteger(raw.seasonYear) ? raw.seasonYear : startDate;
  if (year !== metadata.year) return null;

  const title = isRecord(raw.title) ? raw.title : null;
  if (!title || (raw.synonyms !== undefined && (!Array.isArray(raw.synonyms)
    || raw.synonyms.length > MAX_TITLE_ALIASES))) return null;
  const synonyms = Array.isArray(raw.synonyms) ? raw.synonyms : [];
  const aliases = uniqueStrings([title.english, title.romaji, title.native, ...synonyms]);
  if (!aliases.some((alias) => desiredTitles.has(normalizeTitle(alias)))) return null;

  const episodes = raw.episodes == null ? null : raw.episodes;
  if (episodes !== null && (!Number.isSafeInteger(episodes) || typeof episodes !== 'number'
    || episodes < 1 || episodes > MAX_EPISODE)) return null;
  return { id: raw.id, episodes };
}

async function tmdbAnime(
  request: FetchImplementation,
  apiKey: string,
  coordinates: ResolverCoordinates,
  budget: ByteBudget,
  signal: AbortSignal,
): Promise<TmdbAnime | null> {
  const url = new URL(`/3/${coordinates.mediaType}/${coordinates.tmdbId}`, TMDB_ORIGIN);
  url.searchParams.set('api_key', apiKey);
  const response = await requestResponse(request, 'tmdb', url, {
    headers: { Accept: 'application/json' },
  }, signal);
  return parseTmdbAnime(await boundedJson(response, MAX_TMDB_BYTES, budget, signal), coordinates);
}

async function anilistAnime(
  request: FetchImplementation,
  metadata: TmdbAnime,
  episode: number,
  budget: ByteBudget,
  signal: AbortSignal,
): Promise<AniListAnime | null> {
  const baseTitle = metadata.aliases[0]!;
  const search = metadata.mediaType === 'tv' && metadata.season > 1
    ? `${baseTitle} Season ${metadata.season}`
    : baseTitle;
  if (search.length > MAX_TITLE_LENGTH) return null;
  const response = await requestResponse(request, 'anilist', new URL(ANILIST_ENDPOINT), {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: ANILIST_QUERY,
      variables: { search, perPage: MAX_ANILIST_RESULTS },
    }),
  }, signal);
  const payload = await boundedJson(response, MAX_ANILIST_BYTES, budget, signal);
  if (!isRecord(payload) || (Array.isArray(payload.errors) && payload.errors.length > 0)
    || !isRecord(payload.data) || !isRecord(payload.data.Page)) return null;
  const page = payload.data.Page;
  if (!isRecord(page.pageInfo) || typeof page.pageInfo.hasNextPage !== 'boolean'
    || page.pageInfo.hasNextPage || !Array.isArray(page.media)
    || page.media.length > MAX_ANILIST_RESULTS) return null;

  const desiredTitles = desiredTitleKeys(metadata);
  const matches = new Map<number, AniListAnime>();
  for (const raw of page.media) {
    const candidate = compatibleAniListCandidate(raw, metadata, desiredTitles);
    if (candidate) matches.set(candidate.id, candidate);
  }
  if (matches.size !== 1) return null;
  const match = [...matches.values()][0]!;
  return match.episodes !== null && episode > match.episodes ? null : match;
}

function publicHttpsUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.length > MAX_URL_LENGTH
    || /[\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash
      || url.href.length > MAX_URL_LENGTH || !host.includes('.') || host.endsWith('.')
      || host.includes(':') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)
      || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')
      || host.endsWith('.internal') || host.endsWith('.home') || host.endsWith('.lan')
      || host.endsWith('.test') || host.endsWith('.invalid') || host.endsWith('.example')
      || host.endsWith('.onion') || host.endsWith('.arpa')
      || host.split('.').some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

function paddedBytes(value: string, length: number): Uint8Array {
  const encoded = new TextEncoder().encode(value);
  const result = new Uint8Array(length);
  result.set(encoded.subarray(0, length));
  return result;
}

function base64UrlBytes(value: string): Uint8Array {
  if (!value || value.length > MAX_ENCODED_CIPHERTEXT_LENGTH
    || !/^[A-Za-z0-9_-]+={0,2}$/.test(value) || value.length % 4 === 1) {
    throw new Error('Invalid encrypted payload encoding.');
  }
  const unpadded = value.replace(/=+$/, '');
  const standard = unpadded.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(standard + '='.repeat((4 - standard.length % 4) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  let canonical = '';
  for (const byte of bytes) canonical += String.fromCharCode(byte);
  const encoded = btoa(canonical).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  if (encoded !== unpadded || bytes.length < AES_BLOCK_BYTES
    || bytes.length > MAX_CIPHERTEXT_BYTES || bytes.length % AES_BLOCK_BYTES !== 0) {
    throw new Error('Invalid encrypted payload length.');
  }
  return bytes;
}

async function decryptPayload(value: string): Promise<unknown> {
  const ciphertext = base64UrlBytes(value);
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    paddedBytes(AES_KEY_TEXT, AES_KEY_BYTES),
    { name: 'AES-CBC' },
    false,
    ['decrypt'],
  );
  const plaintext = await globalThis.crypto.subtle.decrypt(
    { name: 'AES-CBC', iv: paddedBytes(AES_IV_TEXT, AES_BLOCK_BYTES) },
    key,
    ciphertext,
  );
  if (plaintext.byteLength > MAX_CIPHERTEXT_BYTES) throw new Error('Decrypted payload is too large.');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)) as unknown;
}

function sourceFile(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const direct = publicHttpsUrl(payload.file);
  if (direct) return direct;
  if (!Array.isArray(payload.sources) || payload.sources.length < 1
    || payload.sources.length > MAX_NESTED_SOURCES || !isRecord(payload.sources[0])) return null;
  return publicHttpsUrl(payload.sources[0].file);
}

const LANGUAGE_ALIASES: ReadonlyArray<readonly [string, string]> = [
  ['portuguese brazil', 'pt-BR'], ['brazilian portuguese', 'pt-BR'],
  ['english', 'en'], ['arabic', 'ar'], ['french', 'fr'], ['german', 'de'],
  ['italian', 'it'], ['portuguese', 'pt'], ['russian', 'ru'], ['spanish', 'es'],
  ['japanese', 'ja'], ['turkish', 'tr'], ['indonesian', 'id'], ['malay', 'ms'],
  ['thai', 'th'], ['vietnamese', 'vi'], ['korean', 'ko'], ['chinese', 'zh'],
  ['hindi', 'hi'], ['dutch', 'nl'], ['polish', 'pl'], ['romanian', 'ro'],
  ['swedish', 'sv'], ['danish', 'da'], ['finnish', 'fi'], ['norwegian', 'no'],
  ['filipino', 'tl'],
];

function normalizedLanguage(value: unknown): string {
  const label = boundedString(value, 80);
  if (!label) return 'und';
  const direct = label.replace(/_/g, '-');
  if (/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(direct)) {
    const [language, ...rest] = direct.split('-');
    return [language!.toLowerCase(), ...rest.map((part) => part.length === 2
      ? part.toUpperCase()
      : part.toLowerCase())].join('-');
  }
  const normalized = normalizeTitle(label);
  return LANGUAGE_ALIASES.find(([name]) => normalized.includes(name))?.[1] ?? 'und';
}

function subtitlesFrom(value: unknown): MegaPlaySubtitle[] {
  if (!Array.isArray(value)) return [];
  const subtitles: MegaPlaySubtitle[] = [];
  const seen = new Set<string>();
  for (const raw of value.slice(0, MAX_TRACKS)) {
    if (!isRecord(raw) || raw.kind !== 'captions') continue;
    const url = publicHttpsUrl(raw.file);
    const label = boundedString(raw.label, 80) ?? 'Subtitles';
    if (!url) continue;
    const language = normalizedLanguage(raw.language ?? raw.label);
    const key = `${language}\n${url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    subtitles.push({ url, language, label, kind: 'captions' });
    if (subtitles.length === MAX_SUBTITLES) break;
  }
  return subtitles;
}

async function mediaIdFor(
  request: FetchImplementation,
  anilistId: number,
  episode: number,
  version: StreamVersion,
  budget: ByteBudget,
  signal: AbortSignal,
): Promise<string> {
  const url = new URL(`/stream/ani/${anilistId}/${episode}/${version}`, MEGAPLAY_ORIGIN);
  const response = await requestResponse(request, 'megaplay', url, {
    headers: PROVIDER_REQUEST_HEADERS,
  }, signal);
  const html = await boundedText(response, MAX_PAGE_BYTES, budget, signal);
  const mediaId = /\bdata-id\s*=\s*["']([1-9]\d{0,19})["']/.exec(html)?.[1];
  if (!mediaId || mediaId.length > MAX_MEDIA_ID_LENGTH) throw new Error('Missing provider media identifier.');
  return mediaId;
}

async function streamForVersion(
  request: FetchImplementation,
  anime: AniListAnime,
  episode: number,
  version: StreamVersion,
  budget: ByteBudget,
  signal: AbortSignal,
): Promise<MegaPlayStream> {
  const mediaId = await mediaIdFor(request, anime.id, episode, version, budget, signal);
  const url = new URL('/stream/getSourcesNew', MEGAPLAY_ORIGIN);
  url.searchParams.set('id', mediaId);
  url.searchParams.set('type', version);
  const response = await requestResponse(request, 'megaplay', url, {
    headers: PROVIDER_REQUEST_HEADERS,
  }, signal);
  const raw = await boundedJson(response, MAX_SOURCE_BYTES, budget, signal);
  if (!isRecord(raw)) throw new Error('Invalid provider response.');

  let payload: unknown = isRecord(raw.sources) ? raw.sources : null;
  if (!payload && typeof raw.enc === 'string') payload = await decryptPayload(raw.enc);
  const file = sourceFile(payload);
  if (!file) throw new Error('Invalid provider stream.');
  const subtitles = subtitlesFrom(raw.tracks);
  return {
    url: file,
    type: 'hls',
    headers: { ...STREAM_HEADERS },
    ...(subtitles.length ? { subtitles } : {}),
    audioLanguage: version === 'dub' ? 'en' : 'ja',
  };
}

export function createMegaPlayResolver({
  fetchImpl,
  tmdbApiKey,
  totalTimeoutMs,
}: CreateMegaPlayResolverOptions = {}) {
  const timeoutMs = normalizedTimeout(totalTimeoutMs);
  const request: FetchImplementation = (input, init) => fetchImpl
    ? fetchImpl(input, init)
    : globalThis.fetch(input, init);

  return async function resolve(input: ResolveMegaPlayInput): Promise<MegaPlayStream[]> {
    if (input.signal?.aborted) throw abortError();
    const coordinates = coordinatesOf(input);
    const apiKey = configuredApiKey(tmdbApiKey);
    if (!coordinates || !apiKey) return [];

    return withDeadline(timeoutMs, input.signal, async (signal) => {
      const budget = { remaining: MAX_TOTAL_RESPONSE_BYTES };
      try {
        const metadata = await tmdbAnime(request, apiKey, coordinates, budget, signal);
        if (!metadata || coordinates.episode > metadata.episodeCount) return [];
        const anime = await anilistAnime(request, metadata, coordinates.episode, budget, signal);
        if (!anime) return [];

        const results = await Promise.allSettled(VERSIONS.map((version) => streamForVersion(
          request,
          anime,
          coordinates.episode,
          version,
          budget,
          signal,
        )));
        if (signal.aborted) throw abortError();
        return results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
      } catch (error) {
        if (signal.aborted || isAbortError(error)) throw abortError();
        return [];
      }
    });
  };
}

const defaultResolver = createMegaPlayResolver();

export function resolveMegaPlayStreams(input: ResolveMegaPlayInput): Promise<MegaPlayStream[]> {
  return defaultResolver(input);
}
