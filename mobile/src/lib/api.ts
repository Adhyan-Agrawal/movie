import { supabase, supabaseConfigured } from './supabase';
import { createClient } from '@supabase/supabase-js';
import { resolveSupabaseRuntimeConfig, WEB_URL, webRuntimeConfig } from './runtime-config';
import { validNativeAdPolicy } from '../player/policy';
import { parseEpisodeNavigation, type EpisodeNavigation } from '../player/episode-navigation';
import type {
  CastMember,
  HomeData,
  IntroMarker,
  MediaTrack,
  NativeAdPolicy,
  ContinueEntry,
  MediaRow,
  NativeVastCreative,
  Person,
  PlaybackRequest,
  PlaybackSource,
  PlaybackResponse,
  StreamCatalog,
  Subtitle,
  Quality,
  Season,
  Title,
  TitleType,
  TitleFilters,
  ViewerEntitlements,
} from './types';

/**
 * Data access for the native app.
 *
 * Catalog reads go straight to Supabase under RLS with the public anon key
 * (exactly like the web app's repository). Library reads/writes (watchlist,
 * progress, ratings, requests) run as the signed-in viewer, so RLS scopes them
 * to that account. Playback resolution is delegated to the web app's
 * /api/playback bridge, which reuses the server-side provider registry — the
 * native app never sees real provider identities, only "Server N".
 */

export function sameOriginPlaybackUrl(value: unknown): string | null {
  if (!webRuntimeConfig.available || typeof value !== 'string' || !value || value.length > 8192) return null;
  try {
    const url = new URL(value, WEB_URL);
    const base = new URL(WEB_URL);
    return url.origin === base.origin && !url.username && !url.password
      && (url.protocol === 'https:' || url.protocol === 'http:') ? url.href : null;
  } catch { return null; }
}

export const PLAYBACK_REQUEST_TIMEOUT_MS = 15_000;
export const PLAYBACK_CATALOG_TIMEOUT_MS = 8_000;
export const PLAYBACK_AUTH_TIMEOUT_MS = 350;
export const PLAYBACK_CONTEXT_TIMEOUT_MS = 1_500;

const publicCatalogConfig = resolveSupabaseRuntimeConfig(process.env.EXPO_PUBLIC_SUPABASE_URL, process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY);
// Public fallback reads must not enter the account client's refresh/storage lock.
const publicCatalog = createClient(publicCatalogConfig.url, publicCatalogConfig.anonKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: 'lumora:public-catalog' },
  global: { fetch: (input, init) => globalThis.fetch(input, { ...init, credentials: 'omit', redirect: 'error' }) },
});

function publicCatalogRead<T>(query: { abortSignal(signal: AbortSignal): PromiseLike<T> }): Promise<T> {
  return withPlaybackDeadline((signal) => query.abortSignal(signal), PLAYBACK_CATALOG_TIMEOUT_MS);
}

/** The race also bounds native transports/auth/storage that ignore AbortSignal. */
export async function withPlaybackDeadline<T>(operation: (signal: AbortSignal) => PromiseLike<T> | T,
  timeoutMs: number, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  let rejectAbort: (() => void) | undefined;
  const timeout = setTimeout(abort, timeoutMs);
  try {
    return await Promise.race([
      new Promise<T>((_resolve, reject) => {
        rejectAbort = () => reject(new Error('Playback request cancelled or timed out.'));
        controller.signal.addEventListener('abort', rejectAbort, { once: true });
        if (signal?.aborted) controller.abort();
      }),
      Promise.resolve().then(() => {
        if (controller.signal.aborted) throw new Error('Playback request cancelled or timed out.');
        return operation(controller.signal);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
    if (rejectAbort) controller.signal.removeEventListener('abort', rejectAbort);
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function shortText(value: unknown, limit = 256): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= limit;
}

async function playbackJson(url: string, signal: AbortSignal, headers: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const response = await fetch(url, { signal, headers, credentials: 'omit', redirect: 'error' });
  if (signal.aborted || !response.ok || (response.url && !sameOriginPlaybackUrl(response.url))
    || Number(response.headers?.get('content-length')) > 1024 * 1024) throw new Error('Playback service unavailable.');
  const body: unknown = await response.json();
  const result = object(body);
  if (signal.aborted || !result) throw new Error('Invalid playback response.');
  return result;
}

function mediaTrack(value: unknown): MediaTrack | null {
  const track = object(value);
  if (!track || !shortText(track.id) || typeof track.label !== 'string' || track.label.length > 256
    || typeof track.language !== 'string' || track.language.length > 64) return null;
  return { id: track.id, label: track.label, language: track.language,
    ...(typeof track.default === 'boolean' ? { default: track.default } : {}) };
}

function subtitleTrack(value: unknown): Subtitle | null {
  const track = mediaTrack(value);
  const raw = object(value);
  if (!track || !raw) return null;
  const url = sameOriginPlaybackUrl(raw.url);
  return { ...track, ...(raw.kind === 'subtitles' || raw.kind === 'captions' ? { kind: raw.kind } : {}),
    ...(url ? { url } : {}) };
}

function qualityOption(value: unknown): Quality | null {
  const quality = object(value);
  if (!quality || !shortText(quality.id) || typeof quality.label !== 'string' || quality.label.length > 128) return null;
  const result: Quality = { id: quality.id, label: quality.label };
  for (const field of ['height', 'width', 'bitrateKbps'] as const) {
    const number = quality[field];
    if (typeof number === 'number' && Number.isFinite(number) && number > 0 && number <= 1_000_000) result[field] = number;
  }
  if (typeof quality.auto === 'boolean') result.auto = quality.auto;
  return result;
}

function playbackEntitlements(value: unknown): ViewerEntitlements | undefined {
  const entitlements = object(value);
  if (!entitlements || typeof entitlements.resolved !== 'boolean' || typeof entitlements.adFree !== 'boolean'
    || !Number.isInteger(entitlements.maxProfiles) || (entitlements.maxProfiles as number) < 1 || (entitlements.maxProfiles as number) > 20
    || !['free', 'active', 'expired', 'unavailable'].includes(entitlements.status as string)) return undefined;
  return { resolved: entitlements.resolved, adFree: entitlements.adFree, maxProfiles: entitlements.maxProfiles as number,
    status: entitlements.status as ViewerEntitlements['status'],
    ...(shortText(entitlements.planId) ? { planId: entitlements.planId } : {}),
    ...(shortText(entitlements.planName) ? { planName: entitlements.planName } : {}),
    ...(shortText(entitlements.accessUntil) ? { accessUntil: entitlements.accessUntil } : {}) };
}

function playbackAdPolicy(value: unknown): NativeAdPolicy | undefined {
  const policy = object(value);
  if (!policy || typeof policy.enabled !== 'boolean' || !validNativeAdPolicy({ ...policy, enabled: true } as unknown as NativeAdPolicy)) return undefined;
  return { enabled: policy.enabled, firstBreakSeconds: policy.firstBreakSeconds as number, intervalSeconds: policy.intervalSeconds as number,
    maxBreaks: policy.maxBreaks as number, allowSkip: policy.allowSkip as boolean, skipAfterSeconds: policy.skipAfterSeconds as number };
}

function playbackSourceUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.length > 8192) return null;
  try {
    const url = new URL(value, WEB_URL);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

const TITLE_SELECT =
  'id, type, slug, name, original_name, original_language, synopsis, release_year, runtime_minutes, ' +
  'maturity, poster_url, backdrop_url, trailer_url, editorial_score, tmdb_id, imdb_id, ' +
  'title_genres ( genres ( name ) )';

const VALID_MATURITY = ['G', 'PG', 'PG-13', 'R', 'NC-17', 'TV-MA', 'TV-14', 'TV-PG'];

function toTitle(row: any): Title {
  const genres: string[] = (row.title_genres ?? [])
    .map((tg: any) => tg?.genres?.name)
    .filter((n: unknown): n is string => typeof n === 'string')
    .sort((a: string, b: string) => a.localeCompare(b));

  const title: Title = {
    id: row.id,
    type: row.type,
    slug: row.slug,
    name: row.name,
    synopsis: row.synopsis ?? '',
    releaseYear: row.release_year ?? 0,
    maturity: (VALID_MATURITY.includes(row.maturity) ? row.maturity : 'PG-13') as Title['maturity'],
    genres,
  };
  if (row.original_name) title.originalName = row.original_name;
  if (row.original_language) title.originalLanguage = row.original_language;
  if (row.runtime_minutes != null) title.runtimeMinutes = row.runtime_minutes;
  if (row.poster_url) title.posterUrl = row.poster_url;
  if (row.backdrop_url) title.backdropUrl = row.backdrop_url;
  if (row.trailer_url) title.trailerUrl = row.trailer_url;
  if (row.editorial_score != null) title.score = row.editorial_score;
  if (row.tmdb_id != null) title.tmdbId = String(row.tmdb_id);
  if (row.imdb_id) title.imdbId = row.imdb_id;
  return title;
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export interface TitleQuery extends TitleFilters {
  type?: TitleType;
  genre?: string;
  sort?: 'trending' | 'newest' | 'oldest' | 'az' | 'score';
  /** 1-based page (each page is up to 40 titles). */
  page?: number;
  pageSize?: number;
}

/** Browse/list titles, popularity-ranked by default (like the web "trending"). */
export async function listTitles(query: TitleQuery = {}): Promise<Title[]> {
  // Country metadata is not in the local database. Never infer it from language or genre.
  if (query.country) return [];
  if (!supabaseConfigured) return [];
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(50, Math.max(1, query.pageSize ?? 40));

  let q = publicCatalog.from('titles').select(TITLE_SELECT);
  if (query.type) q = q.eq('type', query.type);
  if (query.originalLanguage) {
    const languages = query.originalLanguage.toLowerCase().split('|').filter((language) => /^[a-z]{2,3}$/.test(language));
    if (!languages.length) return [];
    q = q.in('original_language', languages);
  }
  switch (query.sort) {
    case 'newest':
      q = q.order('release_year', { ascending: false, nullsFirst: false });
      break;
    case 'oldest':
      q = q.order('release_year', { ascending: true, nullsFirst: false });
      break;
    case 'az':
      q = q.order('name', { ascending: true });
      break;
    case 'score':
      q = q.order('editorial_score', { ascending: false, nullsFirst: false });
      break;
    default:
      // Popularity first (recognizable titles), score as tiebreaker.
      q = q.order('popularity', { ascending: false, nullsFirst: false }).order('editorial_score', { ascending: false, nullsFirst: false });
  }
  q = q.order('id', { ascending: true }).range((page - 1) * pageSize, page * pageSize - 1);

  const { data, error } = await publicCatalogRead(q);
  if (error) throw error;
  let titles = (data ?? []).map(toTitle);
  // Genre filter is applied after the fetch (joined table), same as the web repo.
  if (query.genre) {
    const g = query.genre.toLowerCase();
    titles = titles.filter((t) => t.genres.some((name) => name.toLowerCase() === g));
  }
  return titles;
}

export async function getTitleBySlug(type: TitleType, slug: string): Promise<Title | null> {
  if (!supabaseConfigured) return null;
  const { data, error } = await withPlaybackDeadline((signal) => publicCatalog
    .from('titles')
    .select(TITLE_SELECT)
    .eq('type', type)
    .eq('slug', slug)
    .abortSignal(signal).maybeSingle(), PLAYBACK_CATALOG_TIMEOUT_MS);
  if (error) throw error;
  return data ? toTitle(data) : null;
}

export async function listAllGenres(): Promise<string[]> {
  if (!supabaseConfigured) return [];
  const { data, error } = await publicCatalogRead(publicCatalog.from('genres').select('name').order('name'));
  if (error) throw error;
  return (data ?? []).map((g: any) => g.name);
}

export async function searchTitles(query: string, limit = 24): Promise<Title[]> {
  const q = query.trim();
  if (!q) return [];
  if (!supabaseConfigured) return [];
  const { data, error } = await publicCatalogRead(publicCatalog
    .from('titles')
    .select(TITLE_SELECT)
    .ilike('name', `%${q}%`)
    .order('popularity', { ascending: false, nullsFirst: false })
    .limit(limit));
  if (error) throw error;
  return (data ?? []).map(toTitle);
}

export async function listSeasons(titleId: string): Promise<Season[]> {
  if (!supabaseConfigured) return [];
  const { data: seasons, error } = await publicCatalogRead(publicCatalog
    .from('seasons')
    .select('id, season_number, name, overview, air_date, episode_count')
    .eq('title_id', titleId)
    .order('season_number', { ascending: true }));
  if (error) throw error;
  if (!seasons?.length) return [];

  const { data: episodes, error: epErr } = await publicCatalogRead(publicCatalog
    .from('episodes')
    .select('id, season_id, season_number, episode_number, name, overview, air_date, runtime_minutes, still_url')
    .eq('title_id', titleId)
    .order('season_number', { ascending: true })
    .order('episode_number', { ascending: true }));
  if (epErr) throw epErr;

  // Group by season_id, falling back to season_number: `episodes.season_id` is
  // nullable, and the old code silently dropped any episode that lacked it.
  const bySeasonId = new Map<string, Season['episodes']>();
  const bySeasonNumber = new Map<number, Season['episodes']>();
  for (const e of episodes ?? []) {
    const episode = {
      id: e.id,
      seasonNumber: e.season_number ?? 0,
      episodeNumber: e.episode_number,
      name: e.name,
      overview: e.overview ?? '',
      airDate: e.air_date,
      runtimeMinutes: e.runtime_minutes,
      stillUrl: e.still_url,
    };
    if (e.season_id) {
      const list = bySeasonId.get(e.season_id) ?? [];
      list.push(episode);
      bySeasonId.set(e.season_id, list);
    } else {
      const list = bySeasonNumber.get(episode.seasonNumber) ?? [];
      list.push(episode);
      bySeasonNumber.set(episode.seasonNumber, list);
    }
  }

  return seasons.map((s: any) => ({
    id: s.id,
    seasonNumber: s.season_number,
    name: s.name,
    overview: s.overview ?? '',
    airDate: s.air_date,
    episodeCount: s.episode_count,
    episodes: bySeasonId.get(s.id) ?? bySeasonNumber.get(s.season_number) ?? [],
  }));
}

export async function listCast(titleId: string): Promise<CastMember[]> {
  if (!supabaseConfigured) return [];
  const { data, error } = await publicCatalogRead(publicCatalog
    .from('title_people')
    .select('credit_order, character, people ( id, name, profile_url )')
    .eq('title_id', titleId)
    .eq('credit_type', 'cast')
    .order('credit_order', { ascending: true }));
  if (error) throw error;
  const out: CastMember[] = [];
  for (const row of data ?? []) {
    const p = (row as any).people;
    if (!p) continue;
    out.push({ personId: p.id, name: p.name, character: row.character ?? null, profileUrl: p.profile_url ?? null });
  }
  return out;
}

/** Home rows: top trending (popularity) split into sensible shelves. */
export async function fetchHome(): Promise<HomeData> {
  if (!supabaseConfigured) return { hero: [], rows: [] };
  const [trending, newest, topMovies, topSeries] = await Promise.all([
    listTitles({ sort: 'trending', pageSize: 50 }), listTitles({ sort: 'newest', pageSize: 12 }),
    listTitles({ type: 'movie', pageSize: 12 }), listTitles({ type: 'tv', pageSize: 12 }),
  ]);
  const HERO_EXCLUDED = new Set(['Reality', 'Talk', 'News', 'Game Show', 'Soap']);
  const worthy = trending.filter((t) => !t.genres.some((g) => HERO_EXCLUDED.has(g)));
  const movies = worthy.filter((t) => t.type === 'movie').slice(0, 7);
  const series = worthy.filter((t) => t.type === 'tv').slice(0, 7);
  const hero: Title[] = [];
  for (let i = 0; i < Math.max(movies.length, series.length) && hero.length < 12; i++) {
    if (i < movies.length) hero.push(movies[i]!);
    if (i < series.length) hero.push(series[i]!);
  }

  const rows: MediaRow[] = [];
  if (trending.length) rows.push({ id: 'trending', heading: 'Trending now', titles: trending.slice(0, 12) });
  if (newest.length) rows.push({ id: 'newest', heading: 'New & recent', titles: newest });
  if (topMovies.length) rows.push({ id: 'movies', heading: 'Movies', titles: topMovies });
  if (topSeries.length) rows.push({ id: 'tv', heading: 'TV series', titles: topSeries });
  return { hero, rows };
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

export async function searchPeople(query: string, limit = 8): Promise<Person[]> {
  const q = query.trim();
  if (!q) return [];
  if (!supabaseConfigured) return [];
  const { data, error } = await publicCatalogRead(publicCatalog
    .from('people')
    .select('id, name, known_for, profile_url')
    .ilike('name', `%${q}%`)
    .order('name')
    .limit(limit));
  if (error) throw error;
  return (data ?? []).map((p: any) => ({
    id: p.id,
    name: p.name,
    knownFor: p.known_for ?? null,
    profileUrl: p.profile_url ?? null,
  }));
}

export async function getPerson(id: string): Promise<Person | null> {
  if (!supabaseConfigured) return null;
  const { data, error } = await withPlaybackDeadline((signal) => publicCatalog
    .from('people')
    .select('id, name, known_for, profile_url')
    .eq('id', id)
    .abortSignal(signal).maybeSingle(), PLAYBACK_CATALOG_TIMEOUT_MS);
  if (error) throw error;
  if (!data) return null;
  return { id: data.id, name: data.name, knownFor: data.known_for ?? null, profileUrl: data.profile_url ?? null };
}

export async function getPersonCredits(
  personId: string,
): Promise<Array<{ title: Title; creditType: string; character: string | null; job: string | null }>> {
  if (!supabaseConfigured) return [];
  // `title_people` holds ONLY the credit (title_id, person_id, credit_type,
  // character, job…) — the title columns live on the joined `titles` row. The
  // credit's own table has no FK to title_genres, so the embed must hang off
  // `titles` (same shape as the web repository's CAST_SELECT).
  const { data, error } = await publicCatalogRead(publicCatalog
    .from('title_people')
    .select(`credit_type, character, job, credit_order, titles ( ${TITLE_SELECT} )`)
    .eq('person_id', personId)
    .order('credit_order', { ascending: true })
    .limit(60));
  if (error) throw error;
  return (data ?? [])
    .filter((row: any) => row.titles)
    .map((row: any) => ({
      title: toTitle(row.titles),
      creditType: row.credit_type,
      character: row.character ?? null,
      job: row.job ?? null,
    }));
}

// ---------------------------------------------------------------------------
// Playback bridge (reuses the web provider registry server-side)
// ---------------------------------------------------------------------------

export async function resolvePlayback(request: PlaybackRequest): Promise<PlaybackSource[]> {
  return (await resolvePlaybackDetails(request)).sources;
}

export async function resolvePlaybackDetails(request: PlaybackRequest, signal?: AbortSignal): Promise<PlaybackResponse> {
  if (!webRuntimeConfig.available || signal?.aborted) return { sources: [] };
  const params = new URLSearchParams({ type: request.type });
  // Catalog ids let the bridge also return Lumora-hosted (native HLS/mp4)
  // sources. Guard on the UUID shape: guest entries carry a slug, and sending
  // that would make the bridge run a doomed uuid lookup for native sources.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (request.titleId && UUID_RE.test(request.titleId)) params.set('titleId', request.titleId);
  if (request.episodeId && UUID_RE.test(request.episodeId)) params.set('episodeId', request.episodeId);
  if (request.tmdbId) params.set('tmdbId', request.tmdbId);
  if (request.imdbId) params.set('imdbId', request.imdbId);
  if (request.season !== undefined) params.set('season', String(request.season));
  if (request.episode !== undefined) params.set('episode', String(request.episode));
  if (request.start !== undefined && request.start > 0) params.set('start', String(Math.round(request.start)));
  // Account refresh is optional, separately bounded, and never turns a public request into an auth failure.
  let accessToken: string | undefined;
  let identityAvailable = !supabaseConfigured;
  if (supabaseConfigured) {
    try {
      const session = await withPlaybackDeadline(() => supabase.auth.getSession(), PLAYBACK_AUTH_TIMEOUT_MS, signal);
      if (!session.error) {
        identityAvailable = true;
        accessToken = session.data.session?.access_token;
      }
    } catch { /* Public playback remains usable when account refresh is unavailable. */ }
  }
  try {
    return await withPlaybackDeadline(async (requestSignal) => {
      const json = await playbackJson(`${WEB_URL}/api/playback?${params.toString()}`, requestSignal,
        accessToken ? { Authorization: `Bearer ${accessToken}` } : {});
      const ids = new Set<string>();
      const sources: PlaybackSource[] = Array.isArray(json.sources) ? json.sources.slice(0, 64).flatMap((value) => {
        const source = object(value);
        const url = playbackSourceUrl(source?.url);
        if (!source || !url || !shortText(source.id) || ids.has(source.id) || !shortText(source.label)
          || !['embed', 'hls', 'mp4', 'dash'].includes(source.kind as string) || typeof source.consentRequired !== 'boolean') return [];
        ids.add(source.id);
        const streamCatalogUrl = sameOriginPlaybackUrl(source.streamCatalogUrl);
        return [{ id: source.id, label: source.label, kind: source.kind as PlaybackSource['kind'], url,
          consentRequired: source.consentRequired, ...(streamCatalogUrl ? { streamCatalogUrl } : {}) }];
      }) : [];
      const subtitleCatalogUrl = sameOriginPlaybackUrl(json.subtitleCatalogUrl);
      const introCatalogUrl = sameOriginPlaybackUrl(json.introCatalogUrl);
      const episodeNavigationUrl = request.type === 'tv' ? sameOriginPlaybackUrl(json.episodeNavigationUrl) : null;
      const entitlements = identityAvailable ? playbackEntitlements(json.entitlements) : undefined;
      const adPolicy = identityAvailable ? playbackAdPolicy(json.adPolicy) : undefined;
      return { sources, ...(subtitleCatalogUrl ? { subtitleCatalogUrl } : {}), ...(introCatalogUrl ? { introCatalogUrl } : {}),
        ...(episodeNavigationUrl ? { episodeNavigationUrl } : {}),
        ...(entitlements ? { entitlements } : {}), ...(adPolicy ? { adPolicy } : {}) };
    }, PLAYBACK_REQUEST_TIMEOUT_MS, signal);
  } catch { return { sources: [] }; }
}

export async function fetchEpisodeNavigation(url: string, signal?: AbortSignal): Promise<EpisodeNavigation> {
  const safe = sameOriginPlaybackUrl(url);
  if (!safe) throw new Error('Episode navigation unavailable.');
  return withPlaybackDeadline(async (requestSignal) => {
    const result = parseEpisodeNavigation(await playbackJson(safe, requestSignal), WEB_URL);
    if (!result) throw new Error('Episode navigation unavailable.');
    return result;
  }, PLAYBACK_CATALOG_TIMEOUT_MS, signal);
}

export async function fetchStreamCatalog(url: string, signal?: AbortSignal): Promise<StreamCatalog> {
  const safe = sameOriginPlaybackUrl(url);
  if (!safe) return { streams: [] };
  return withPlaybackDeadline(async (requestSignal) => {
    const json = await playbackJson(safe, requestSignal);
    const ids = new Set<string>();
    const streams: StreamCatalog['streams'] = Array.isArray(json.streams) ? json.streams.slice(0, 64).flatMap((value) => {
      const stream = object(value);
      const url = sameOriginPlaybackUrl(stream?.url);
      if (!stream || !url || !shortText(stream.id) || ids.has(stream.id)) return [];
      ids.add(stream.id);
      const startupLatencyMs = stream.startupLatencyMs;
      return [{ id: stream.id, url,
        ...(typeof startupLatencyMs === 'number' && Number.isFinite(startupLatencyMs) && startupLatencyMs >= 0
          ? { startupLatencyMs } : {}),
        qualities: Array.isArray(stream.qualities) ? stream.qualities.slice(0, 64).flatMap((value) => qualityOption(value) ?? []) : [],
        audioTracks: Array.isArray(stream.audioTracks) ? stream.audioTracks.slice(0, 64).flatMap((value) => mediaTrack(value) ?? []) : [],
        subtitles: Array.isArray(stream.subtitles) ? stream.subtitles.slice(0, 128).flatMap((value) => subtitleTrack(value) ?? []) : [],
      }];
    }) : [];
    return { streams, ...(shortText(json.recommendedStreamId) && ids.has(json.recommendedStreamId)
      ? { recommendedStreamId: json.recommendedStreamId } : {}) };
  }, PLAYBACK_CATALOG_TIMEOUT_MS, signal);
}

export async function fetchSubtitleCatalog(url: string, signal?: AbortSignal): Promise<Subtitle[]> {
  const safe = sameOriginPlaybackUrl(url);
  if (!safe) return [];
  return withPlaybackDeadline(async (requestSignal) => {
    const json = await playbackJson(safe, requestSignal);
    return Array.isArray(json.tracks) ? json.tracks.slice(0, 128).flatMap((value) => {
      const track = subtitleTrack(value);
      return track?.url ? [track] : [];
    }) : [];
  }, PLAYBACK_CATALOG_TIMEOUT_MS, signal);
}

/** Optional public metadata must never stall or fail content playback. */
export async function fetchIntroCatalog(url: string, signal?: AbortSignal): Promise<IntroMarker | null> {
  const safe = sameOriginPlaybackUrl(url);
  if (!safe || signal?.aborted) return null;
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  let onAbort: (() => void) | undefined;
  const timeout = setTimeout(abort, 5000);
  try {
    return await Promise.race([
      (async () => {
        const response = await fetch(safe, { signal: controller.signal, credentials: 'omit', redirect: 'error' });
        if (!response.ok || controller.signal.aborted || (response.url && !sameOriginPlaybackUrl(response.url))) return null;
        const body = await response.json() as { intro?: IntroMarker } | null;
        const intro = body?.intro;
        if (controller.signal.aborted || !intro || typeof intro !== 'object' || Array.isArray(intro)
          || !Number.isFinite(intro.startSeconds) || !Number.isFinite(intro.endSeconds)
          || intro.startSeconds < 0 || intro.startSeconds >= intro.endSeconds) return null;
        return { startSeconds: intro.startSeconds, endSeconds: intro.endSeconds };
      })(),
      new Promise<null>((resolve) => {
        onAbort = () => resolve(null);
        controller.signal.addEventListener('abort', onAbort, { once: true });
        if (controller.signal.aborted) resolve(null);
      }),
    ]);
  } catch { return null; } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
    if (onAbort) controller.signal.removeEventListener('abort', onAbort);
  }
}

/** Only normalized creatives are public; tags and provider credentials remain server-side. */
export async function fetchVastCreative(consent: boolean, signal?: AbortSignal): Promise<NativeVastCreative | null> {
  if (consent !== true || signal?.aborted || !webRuntimeConfig.available) return null;
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  let onAbort: (() => void) | undefined;
  const timeout = setTimeout(abort, 10_000);
  try {
    // The deadline also covers a stalled session lookup, not just the HTTP request.
    return await Promise.race([
      (async () => {
        const { data, error } = supabaseConfigured
          ? await supabase.auth.getSession()
          : { data: { session: null }, error: null };
        if (error || controller.signal.aborted) return null;
        const response = await fetch(`${WEB_URL}/api/vast?consent=1`, { signal: controller.signal,
          headers: data.session?.access_token ? { Authorization: `Bearer ${data.session.access_token}` } : {},
          credentials: 'omit', redirect: 'error' });
        if (!response.ok || response.status === 204 || controller.signal.aborted) return null;
        const body = await response.json() as { creative?: NativeVastCreative };
        const creative = body?.creative;
        const https = (value: unknown) => {
          if (typeof value !== 'string' || value.length > 4096) return false;
          try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password
            && !url.hash && (!url.port || url.port === '443'); } catch { return false; }
        };
        if (controller.signal.aborted || !creative || typeof creative.id !== 'string' || !creative.id || creative.id.length > 256
          || !https(creative.mediaUrl) || !Number.isFinite(creative.durationSeconds) || creative.durationSeconds <= 0 || creative.durationSeconds > 600
          || (creative.skipAfterSeconds !== null && (!Number.isFinite(creative.skipAfterSeconds)
            || creative.skipAfterSeconds < 0 || creative.skipAfterSeconds > creative.durationSeconds))
          || !creative.tracking || typeof creative.tracking !== 'object' || Array.isArray(creative.tracking)) return null;
        const tracking: NativeVastCreative['tracking'] = {};
        const events = ['impression', 'start', 'firstQuartile', 'midpoint', 'thirdQuartile', 'complete', 'skip', 'error'] as const;
        for (const event of events) {
          const values = creative.tracking[event];
          if (Array.isArray(values)) tracking[event] = [...new Set(values.filter(https))].slice(0, 20);
        }
        return { id: creative.id, mediaUrl: creative.mediaUrl, durationSeconds: creative.durationSeconds,
          skipAfterSeconds: creative.skipAfterSeconds, tracking,
          ...(https(creative.clickThrough) ? { clickThrough: creative.clickThrough } : {}),
          ...(Array.isArray(creative.clickTracking) ? { clickTracking: [...new Set(creative.clickTracking.filter(https))].slice(0, 20) } : {}) };
      })(),
      new Promise<null>((resolve) => {
        onAbort = () => resolve(null);
        controller.signal.addEventListener('abort', onAbort, { once: true });
        if (controller.signal.aborted) resolve(null);
      }),
    ]);
  } catch { return null; } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
    if (onAbort) controller.signal.removeEventListener('abort', onAbort);
  }
}

export async function getPlaybackContext(titleId: string, type: TitleType, episodeId?: string, season?: number, episode?: number, signal?: AbortSignal) {
  const unavailable = { viewerKey: 'unavailable', episodeId, resume: null as { positionSeconds: number; updatedAt: number } | null };
  if (!supabaseConfigured) return { ...unavailable, viewerKey: 'guest' };
  try {
    return await withPlaybackDeadline(async (requestSignal) => {
      const session = await supabase.auth.getSession();
      if (requestSignal.aborted || session.error) return unavailable;
      if (!session.data.session) return { ...unavailable, viewerKey: 'guest' };
      const { data, error } = await supabase.auth.getUser();
      if (requestSignal.aborted || error || !data.user) return unavailable;
      const { data: profile, error: profileError } = await supabase.from('profiles').select('id')
        .eq('account_id', data.user.id).order('created_at', { ascending: true }).limit(1).abortSignal(requestSignal).maybeSingle();
      if (requestSignal.aborted || profileError) return unavailable;
      let exactEpisode = episodeId;
      if (type === 'tv' && !exactEpisode && season !== undefined && episode !== undefined && /^[0-9a-f-]{36}$/i.test(titleId)) {
        const { data: found } = await supabase.from('episodes').select('id').eq('title_id', titleId)
          .eq('season_number', season).eq('episode_number', episode).abortSignal(requestSignal).maybeSingle();
        if (requestSignal.aborted) return unavailable;
        exactEpisode = found?.id;
      }
      const viewerKey = `account:${data.user.id}${profile ? `:profile:${profile.id}` : ''}`;
      if (!profile || (type === 'tv' && !exactEpisode)) return { viewerKey, episodeId: exactEpisode, resume: null };
      let query = supabase.from('watch_progress').select('position_seconds, updated_at')
        .eq('profile_id', profile.id).eq('account_id', data.user.id).eq('title_id', titleId);
      query = exactEpisode ? query.eq('episode_id', exactEpisode) : query.is('episode_id', null);
      const { data: row } = await query.order('updated_at', { ascending: false }).limit(1).abortSignal(requestSignal).maybeSingle();
      if (requestSignal.aborted) return unavailable;
      return { viewerKey, episodeId: exactEpisode, resume: row && Number.isFinite(row.position_seconds) && row.position_seconds >= 0
        ? { positionSeconds: row.position_seconds, updatedAt: Date.parse(row.updated_at) || 0 } : null };
    }, PLAYBACK_CONTEXT_TIMEOUT_MS, signal);
  } catch { return unavailable; }
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/**
 * Record a server-side playback session (mirrors the web's
 * reportPlaybackStartAction). Embeds expose no position telemetry, so this row
 * is what lets a signed-in embed watch appear in Continue Watching on the web
 * (which falls back to recent playback_sessions) and here.
 */
export async function recordPlaybackSession(
  titleId: string,
  episodeId?: string,
  viewerKey?: string,
): Promise<{ ok: boolean }> {
  const user = await currentUser();
  if (!user) return { ok: false };
  const profileId = await defaultProfileId();
  if (viewerKey && viewerKey !== `account:${user.id}${profileId ? `:profile:${profileId}` : ''}`) return { ok: false };
  const { error } = await supabase.from('playback_sessions').insert({
    account_id: user.id,
    ...(profileId ? { profile_id: profileId } : {}),
    title_id: titleId,
    ...(episodeId ? { episode_id: episodeId } : {}),
    state: 'playing',
  });
  return { ok: !error };
}

export const AUTH_UNAVAILABLE_MESSAGE = 'Account services are unavailable in this build. You can still browse and watch as a guest.';

export function isAuthConfigured(): boolean {
  return supabaseConfigured;
}

export type SignUpOutcome =
  | { status: 'signedIn' }
  | { status: 'verificationRequired'; message: string }
  | { status: 'unavailable' | 'error'; message: string };

export async function signIn(email: string, password: string): Promise<{ ok: boolean; message?: string }> {
  if (!isAuthConfigured()) return { ok: false, message: AUTH_UNAVAILABLE_MESSAGE };
  try {
    const { data, error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    if (error) return { ok: false, message: error.message };
    return data.session ? { ok: true } : { ok: false, message: 'Sign-in did not establish a session. Please try again.' };
  } catch {
    return { ok: false, message: 'Account services could not be reached.' };
  }
}

export async function signUp(email: string, password: string): Promise<SignUpOutcome> {
  if (!isAuthConfigured()) return { status: 'unavailable', message: AUTH_UNAVAILABLE_MESSAGE };
  try {
    const { data, error } = await supabase.auth.signUp({ email: email.trim(), password });
    if (error) return { status: 'error', message: error.message };
    return data.session ? { status: 'signedIn' } : { status: 'verificationRequired',
      message: 'You are not signed in yet. Check your email for any required verification, then return here to sign in.' };
  } catch {
    return { status: 'unavailable', message: 'Account services could not be reached.' };
  }
}

export async function signOut(): Promise<void> {
  if (!supabaseConfigured) return;
  try { await supabase.auth.signOut(); } catch { /* A local sign-out action must not reject into React Native. */ }
}

export async function currentUser() {
  if (!supabaseConfigured) return null;
  try {
    const { data, error } = await supabase.auth.getUser();
    return error ? null : data.user ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Library (watchlist / progress / ratings / requests) — RLS-scoped to the user
// ---------------------------------------------------------------------------

/** The signed-in account's default profile id (web writes hang off profiles). */
async function defaultProfileId(): Promise<string | null> {
  const user = await currentUser();
  if (!user) return null;
  const { data } = await supabase
    .from('profiles')
    .select('id')
    .eq('account_id', user.id)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  return data?.id ?? null;
}

/** The viewer's default watchlist id, creating it on first use. */
async function defaultWatchlistId(accountId: string, profileId: string): Promise<string | null> {
  // Take the profile's first list rather than filtering on `is_default`: the
  // DB also has lists created by the web, and `unique(profile_id, name)` means
  // creating a second list with a different-cased name would collide later.
  const { data: existing, error } = await supabase
    .from('watchlists')
    .select('id')
    .eq('profile_id', profileId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) console.warn('api.defaultWatchlistId: read failed', { message: error.message });
  if (existing?.id) return existing.id;

  // 'My list' matches the DB default + the web's casing (case-sensitive unique).
  const { data: created, error: createErr } = await supabase
    .from('watchlists')
    .insert({ profile_id: profileId, account_id: accountId, name: 'My list', is_default: true })
    .select('id')
    .single();
  if (createErr) console.warn('api.defaultWatchlistId: create failed', { message: createErr.message });
  return created?.id ?? null;
}

export async function isInWatchlist(titleId: string): Promise<boolean> {
  const user = await currentUser();
  if (!user) return false;
  const profileId = await defaultProfileId();
  if (!profileId) return false;
  // `watchlist_items` is keyed by (watchlist_id, title_id) — it has no `id` or
  // `account_id` column, so scope through the joined watchlist's profile.
  const { data, error } = await supabase
    .from('watchlist_items')
    .select('title_id, watchlists!inner(profile_id)')
    .eq('title_id', titleId)
    .eq('watchlists.profile_id', profileId)
    .limit(1);
  if (error) {
    // Surfaced deliberately: a silent error here made the bookmark state wrong
    // for every title (the query selected a column that doesn't exist).
    console.warn('api.isInWatchlist failed', { message: error.message });
    return false;
  }
  return (data ?? []).length > 0;
}

export async function toggleWatchlist(titleId: string): Promise<{ ok: boolean; added?: boolean }> {
  const user = await currentUser();
  if (!user) return { ok: false };
  const profileId = await defaultProfileId();
  if (!profileId) return { ok: false };

  const listId = await defaultWatchlistId(user.id, profileId);
  if (!listId) return { ok: false };

  if (await isInWatchlist(titleId)) {
    const { error } = await supabase
      .from('watchlist_items')
      .delete()
      .eq('watchlist_id', listId)
      .eq('title_id', titleId);
    return { ok: !error, added: false };
  }
  const { error } = await supabase.from('watchlist_items').insert({ watchlist_id: listId, title_id: titleId });
  return { ok: !error, added: !error };
}

export async function listWatchlist(): Promise<Title[]> {
  const user = await currentUser();
  if (!user) return [];
  const profileId = await defaultProfileId();
  if (!profileId) return [];
  const listId = await defaultWatchlistId(user.id, profileId);
  if (!listId) return [];
  const { data, error } = await supabase
    .from('watchlist_items')
    .select(`title_id, added_at, titles ( ${TITLE_SELECT} )`)
    .eq('watchlist_id', listId)
    .order('added_at', { ascending: false })
    .limit(60);
  if (error) return [];
  return (data ?? [])
    .map((row: any) => (row.titles ? toTitle(row.titles) : null))
    .filter((t: Title | null): t is Title => t !== null);
}

/** Continue watching for the signed-in viewer (title + where they left off). */
export async function fetchContinueWatching(limit = 12): Promise<ContinueEntry[]> {
  const user = await currentUser();
  if (!user) return [];
  const profileId = await defaultProfileId();
  if (!profileId) return [];

  const out: ContinueEntry[] = [];
  const seen = new Set<string>();

  const { data, error } = await supabase
    .from('watch_progress')
    .select('title_id, progress, position_seconds, episode_id, updated_at')
    .eq('profile_id', profileId)
    .eq('completed', false)
    .gte('progress', 0.02)
    .order('updated_at', { ascending: false })
    .limit(limit);
  if (error) return [];

  const episodeIds = [...new Set((data ?? []).map((r: any) => r.episode_id).filter(Boolean))];
  const episodes = new Map<string, { seasonNumber: number; episodeNumber: number }>();
  if (episodeIds.length) {
    const { data: eps } = await supabase
      .from('episodes')
      .select('id, season_number, episode_number')
      .in('id', episodeIds as string[]);
    for (const e of eps ?? []) {
      if (e.season_number != null && e.episode_number != null) {
        episodes.set(e.id, { seasonNumber: e.season_number, episodeNumber: e.episode_number });
      }
    }
  }

  for (const row of data ?? []) {
    const titleId = (row as any).title_id as string;
    if (seen.has(titleId)) continue;
    const { data: t } = await supabase.from('titles').select(TITLE_SELECT).eq('id', titleId).maybeSingle();
    if (!t) continue;
    seen.add(titleId);
    const ep = (row as any).episode_id ? episodes.get((row as any).episode_id) : undefined;
    out.push({
      title: toTitle(t),
      progress: (row as any).progress,
      positionSeconds: (row as any).position_seconds,
      ...(ep ? { seasonNumber: ep.seasonNumber, episodeNumber: ep.episodeNumber } : {}),
      ...((row as any).episode_id ? { episodeId: (row as any).episode_id } : {}),
    });
  }

  // Fallback (mirrors the web): embed playback shares no position, so the only
  // trace is a recent playback_sessions row. Surface those as "Continue" entries
  // so a title watched in the app shows up here — and so web/app agree.
  if (out.length < limit) {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data: sessions } = await supabase
      .from('playback_sessions')
      .select('title_id, started_at')
      .eq('account_id', user.id)
      .gte('started_at', since)
      .order('started_at', { ascending: false })
      .limit(100);

    for (const s of sessions ?? []) {
      if (out.length >= limit) break;
      const titleId = (s as any).title_id as string;
      if (!titleId || seen.has(titleId)) continue;
      const { data: t } = await supabase.from('titles').select(TITLE_SELECT).eq('id', titleId).maybeSingle();
      if (!t) continue;
      seen.add(titleId);
      out.push({ title: toTitle(t) });
    }
  }

  return out;
}

/** Report a real playback position (native player only). */
export async function reportProgress(input: {
  titleId: string;
  episodeId?: string;
  positionSeconds: number;
  durationSeconds?: number;
  viewerKey?: string;
}): Promise<{ ok: boolean }> {
  if (!Number.isFinite(input.positionSeconds) || input.positionSeconds < 0 || input.positionSeconds > 2147483647
    || (input.durationSeconds !== undefined && (!Number.isFinite(input.durationSeconds) || input.durationSeconds <= 0))) return { ok: false };
  const user = await currentUser();
  if (!user) return { ok: false };
  const profileId = await defaultProfileId();
  if (!profileId) return { ok: false };
  if (input.viewerKey && input.viewerKey !== `account:${user.id}:profile:${profileId}`) return { ok: false };

  const duration = input.durationSeconds;
  const progress = duration && duration > 0 ? Math.min(1, Math.max(0, input.positionSeconds / duration)) : 0;
  const completed = progress >= 0.95;

  let existing = supabase
    .from('watch_progress')
    .select('id')
    .eq('account_id', user.id)
    .eq('profile_id', profileId)
    .eq('title_id', input.titleId);
  existing = input.episodeId ? existing.eq('episode_id', input.episodeId) : existing.is('episode_id', null);
  const { data: row } = await existing.maybeSingle();

  const payload: Record<string, unknown> = {
    position_seconds: Math.max(0, Math.round(input.positionSeconds)),
    ...(duration !== undefined ? { duration_seconds: Math.round(duration) } : {}),
    progress,
    completed,
    updated_at: new Date().toISOString(),
  };
  if (row) {
    const { error } = await supabase.from('watch_progress').update(payload).eq('id', row.id).eq('account_id', user.id).eq('profile_id', profileId);
    return { ok: !error };
  }
  const { error } = await supabase.from('watch_progress').insert({
    account_id: user.id,
    profile_id: profileId,
    title_id: input.titleId,
    ...(input.episodeId ? { episode_id: input.episodeId } : {}),
    ...payload,
  });
  return { ok: !error };
}

export async function setRating(titleId: string, value: number): Promise<{ ok: boolean }> {
  const user = await currentUser();
  if (!user) return { ok: false };
  const profileId = await defaultProfileId();
  if (!profileId) return { ok: false };
  const { error } = await supabase
    .from('ratings')
    .upsert({ profile_id: profileId, account_id: user.id, title_id: titleId, value }, { onConflict: 'profile_id,title_id' });
  return { ok: !error };
}

/** A title by its catalog id (uuid) — used by the player and My List. */
export async function fetchTitleById(id: string): Promise<Title | null> {
  if (!supabaseConfigured) return null;
  const { data, error } = await supabase.from('titles').select(TITLE_SELECT).eq('id', id).maybeSingle();
  if (error) throw error;
  return data ? toTitle(data) : null;
}

/**
 * The signed-in viewer's saved resume position for a title/episode, or null.
 * Used by the native player to seek where they left off (and to pass `start`
 * to providers that support a resume parameter).
 */
export async function getResumePosition(
  titleId: string,
  episodeId?: string,
): Promise<{ positionSeconds: number; progress: number } | null> {
  const profileId = await defaultProfileId();
  if (!profileId) return null;
  let q = supabase
    .from('watch_progress')
    .select('position_seconds, progress')
    .eq('profile_id', profileId)
    .eq('title_id', titleId);
  q = episodeId ? q.eq('episode_id', episodeId) : q.is('episode_id', null);
  const { data } = await q.order('updated_at', { ascending: false }).limit(1).maybeSingle();
  if (!data) return null;
  if (!Number.isFinite(data.position_seconds) || data.position_seconds < 0) return null;
  return { positionSeconds: data.position_seconds, progress: data.progress };
}

export async function getMyRating(titleId: string): Promise<number | null> {
  const profileId = await defaultProfileId();
  if (!profileId) return null;
  const { data } = await supabase
    .from('ratings')
    .select('value')
    .eq('profile_id', profileId)
    .eq('title_id', titleId)
    .maybeSingle();
  return data?.value ?? null;
}

export async function submitTitleRequest(input: {
  titleName: string;
  mediaType: 'movie' | 'tv';
  year?: number;
  note?: string;
}): Promise<{ ok: boolean; message?: string }> {
  const user = await currentUser();
  if (!user) return { ok: false, message: 'Sign in to request a title.' };
  const { error } = await supabase.from('title_requests').insert({
    account_id: user.id,
    title_name: input.titleName.trim(),
    media_type: input.mediaType,
    ...(input.year ? { year: input.year } : {}),
    ...(input.note?.trim() ? { note: input.note.trim() } : {}),
  });
  return error ? { ok: false, message: error.message } : { ok: true };
}
