import { supabase } from './supabase';
import type {
  CastMember,
  ContinueEntry,
  MediaRow,
  Person,
  PlaybackRequest,
  PlaybackSource,
  Season,
  Title,
  TitleType,
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

const WEB_URL = process.env.EXPO_PUBLIC_WEB_URL ?? 'https://hulkofyt.eu.org';

const TITLE_SELECT =
  'id, type, slug, name, original_name, synopsis, release_year, runtime_minutes, ' +
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

export interface TitleQuery {
  type?: TitleType;
  genre?: string;
  sort?: 'trending' | 'newest' | 'oldest' | 'az' | 'score';
  /** 1-based page (each page is up to 40 titles). */
  page?: number;
  pageSize?: number;
}

/** Browse/list titles, popularity-ranked by default (like the web "trending"). */
export async function listTitles(query: TitleQuery = {}): Promise<Title[]> {
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(50, Math.max(1, query.pageSize ?? 40));

  let q = supabase.from('titles').select(TITLE_SELECT);
  if (query.type) q = q.eq('type', query.type);
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

  const { data, error } = await q;
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
  const { data, error } = await supabase
    .from('titles')
    .select(TITLE_SELECT)
    .eq('type', type)
    .eq('slug', slug)
    .maybeSingle();
  if (error) throw error;
  return data ? toTitle(data) : null;
}

export async function listAllGenres(): Promise<string[]> {
  const { data, error } = await supabase.from('genres').select('name').order('name');
  if (error) throw error;
  return (data ?? []).map((g: any) => g.name);
}

export async function searchTitles(query: string, limit = 24): Promise<Title[]> {
  const q = query.trim();
  if (!q) return [];
  const { data, error } = await supabase
    .from('titles')
    .select(TITLE_SELECT)
    .ilike('name', `%${q}%`)
    .order('popularity', { ascending: false, nullsFirst: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map(toTitle);
}

export async function listSeasons(titleId: string): Promise<Season[]> {
  const { data: seasons, error } = await supabase
    .from('seasons')
    .select('id, season_number, name, overview, air_date, episode_count')
    .eq('title_id', titleId)
    .order('season_number', { ascending: true });
  if (error) throw error;
  if (!seasons?.length) return [];

  const { data: episodes, error: epErr } = await supabase
    .from('episodes')
    .select('id, season_id, season_number, episode_number, name, overview, air_date, runtime_minutes, still_url')
    .eq('title_id', titleId)
    .order('season_number', { ascending: true })
    .order('episode_number', { ascending: true });
  if (epErr) throw epErr;

  const bySeason = new Map<string, Season['episodes']>();
  for (const e of episodes ?? []) {
    const list = bySeason.get(e.season_id) ?? [];
    list.push({
      id: e.id,
      seasonNumber: e.season_number ?? 0,
      episodeNumber: e.episode_number,
      name: e.name,
      overview: e.overview ?? '',
      airDate: e.air_date,
      runtimeMinutes: e.runtime_minutes,
      stillUrl: e.still_url,
    });
    if (e.season_id) bySeason.set(e.season_id, list);
  }

  return seasons.map((s: any) => ({
    id: s.id,
    seasonNumber: s.season_number,
    name: s.name,
    overview: s.overview ?? '',
    airDate: s.air_date,
    episodeCount: s.episode_count,
    episodes: bySeason.get(s.id) ?? [],
  }));
}

export async function listCast(titleId: string): Promise<CastMember[]> {
  const { data, error } = await supabase
    .from('title_people')
    .select('credit_order, character, people ( id, name, profile_url )')
    .eq('title_id', titleId)
    .eq('credit_type', 'cast')
    .order('credit_order', { ascending: true });
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
export async function fetchHome(): Promise<{ hero: Title[]; rows: MediaRow[] }> {
  const trending = await listTitles({ sort: 'trending', pageSize: 50 });
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
  const newest = await listTitles({ sort: 'newest', pageSize: 12 });
  if (newest.length) rows.push({ id: 'newest', heading: 'New & recent', titles: newest });
  const topMovies = await listTitles({ type: 'movie', pageSize: 12 });
  if (topMovies.length) rows.push({ id: 'movies', heading: 'Movies', titles: topMovies });
  const topSeries = await listTitles({ type: 'tv', pageSize: 12 });
  if (topSeries.length) rows.push({ id: 'tv', heading: 'TV series', titles: topSeries });
  return { hero, rows };
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

export async function searchPeople(query: string, limit = 8): Promise<Person[]> {
  const q = query.trim();
  if (!q) return [];
  const { data, error } = await supabase
    .from('people')
    .select('id, name, known_for, profile_url')
    .ilike('name', `%${q}%`)
    .order('name')
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map((p: any) => ({
    id: p.id,
    name: p.name,
    knownFor: p.known_for ?? null,
    profileUrl: p.profile_url ?? null,
  }));
}

export async function getPerson(id: string): Promise<Person | null> {
  const { data, error } = await supabase
    .from('people')
    .select('id, name, known_for, profile_url')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return { id: data.id, name: data.name, knownFor: data.known_for ?? null, profileUrl: data.profile_url ?? null };
}

export async function getPersonCredits(personId: string): Promise<Array<{ title: Title; creditType: string; character: string | null }>> {
  const { data, error } = await supabase
    .from('title_people')
    .select(`credit_type, character, ${TITLE_SELECT.replace(/\s+/g, ' ')}`)
    .eq('person_id', personId)
    .limit(60);
  if (error) throw error;
  return (data ?? []).map((row: any) => ({
    title: toTitle(row.title_genres !== undefined ? row : { ...row.titles }),
    creditType: row.credit_type,
    character: row.character ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Playback bridge (reuses the web provider registry server-side)
// ---------------------------------------------------------------------------

export async function resolvePlayback(request: PlaybackRequest): Promise<PlaybackSource[]> {
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
  try {
    const res = await fetch(`${WEB_URL}/api/playback?${params.toString()}`);
    if (!res.ok) return [];
    const json = (await res.json()) as { sources?: PlaybackSource[] };
    return json.sources ?? [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export async function signIn(email: string, password: string): Promise<{ ok: boolean; message?: string }> {
  const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
  if (error) return { ok: false, message: error.message };
  return { ok: true };
}

export async function signUp(email: string, password: string): Promise<{ ok: boolean; message?: string }> {
  const { error } = await supabase.auth.signUp({ email: email.trim(), password });
  if (error) return { ok: false, message: error.message };
  return { ok: true };
}

export async function signOut(): Promise<void> {
  await supabase.auth.signOut();
}

export async function currentUser() {
  const { data } = await supabase.auth.getUser();
  return data.user ?? null;
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

export async function isInWatchlist(titleId: string): Promise<boolean> {
  const user = await currentUser();
  if (!user) return false;
  const profileId = await defaultProfileId();
  if (!profileId) return false;
  // Filter through the viewer's OWN list (the joined-table filter keeps this
  // correct even if more profiles/lists are added later).
  const { data } = await supabase
    .from('watchlist_items')
    .select('id, watchlists!inner(profile_id)')
    .eq('title_id', titleId)
    .eq('watchlists.profile_id', profileId)
    .limit(1);
  return (data ?? []).length > 0;
}

export async function toggleWatchlist(titleId: string): Promise<{ ok: boolean; added?: boolean }> {
  const user = await currentUser();
  if (!user) return { ok: false };
  const profileId = await defaultProfileId();
  if (!profileId) return { ok: false };

  const inList = await isInWatchlist(titleId);
  if (inList) {
    await supabase.from('watchlist_items').delete().eq('title_id', titleId);
    return { ok: true, added: false };
  }
  // Find (or create) the viewer's default watchlist.
  let { data: list } = await supabase
    .from('watchlists')
    .select('id')
    .eq('profile_id', profileId)
    .eq('is_default', true)
    .maybeSingle();
  if (!list) {
    const { data: created } = await supabase
      .from('watchlists')
      .insert({ profile_id: profileId, account_id: user.id, name: 'My List', is_default: true })
      .select('id')
      .single();
    list = created;
  }
  if (!list) return { ok: false };
  const { error } = await supabase
    .from('watchlist_items')
    .insert({ watchlist_id: list.id, title_id: titleId, account_id: user.id });
  return { ok: !error, added: !error };
}

export async function listWatchlist(): Promise<Title[]> {
  const user = await currentUser();
  if (!user) return [];
  const { data, error } = await supabase
    .from('watchlist_items')
    .select(`title_id, titles ( ${TITLE_SELECT} )`)
    .order('created_at', { ascending: false })
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

  const out: ContinueEntry[] = [];
  for (const row of data ?? []) {
    const { data: t } = await supabase.from('titles').select(TITLE_SELECT).eq('id', (row as any).title_id).maybeSingle();
    if (!t) continue;
    const ep = (row as any).episode_id ? episodes.get((row as any).episode_id) : undefined;
    out.push({
      title: toTitle(t),
      progress: (row as any).progress,
      positionSeconds: (row as any).position_seconds,
      ...(ep ? { seasonNumber: ep.seasonNumber, episodeNumber: ep.episodeNumber } : {}),
      ...((row as any).episode_id ? { episodeId: (row as any).episode_id } : {}),
    });
  }
  return out;
}

/** Report a real playback position (native player only). */
export async function reportProgress(input: {
  titleId: string;
  episodeId?: string;
  positionSeconds: number;
  durationSeconds?: number;
}): Promise<{ ok: boolean }> {
  const user = await currentUser();
  if (!user) return { ok: false };
  const profileId = await defaultProfileId();
  if (!profileId) return { ok: false };

  const duration = input.durationSeconds;
  const progress = duration && duration > 0 ? Math.min(1, Math.max(0, input.positionSeconds / duration)) : 0;
  const completed = progress >= 0.95;

  let existing = supabase
    .from('watch_progress')
    .select('id')
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
    const { error } = await supabase.from('watch_progress').update(payload).eq('id', row.id);
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
  // Only resume mid-watch (not barely started, not finished).
  if (data.progress < 0.02 || data.progress >= 0.95) return null;
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
