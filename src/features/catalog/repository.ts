import 'server-only';

import { getSupabaseServerClient } from '@/lib/supabase/server';
import type { CastMember, MaturityRating, Season, Title, TitleType } from './types';
import type { TitleFilters } from './queries';

/**
 * Supabase-backed catalog repository (Spec Section 6: services -> repositories).
 *
 * This is the ONLY place that reads catalog rows from Postgres and maps them to
 * the client-safe `Title` DTO. RLS applies (anon key), so anonymous callers see
 * only published/public/released titles via `title_is_public()`; editors with
 * `catalog.read` additionally see drafts. Callers in `queries.ts`/`data.ts`
 * fall back to the mock catalog if any of these throw, so a transient DB error
 * degrades gracefully rather than 500-ing the page.
 *
 * `server-only` guards against this repository (and the server Supabase client)
 * being pulled into a client bundle.
 */

const VALID_MATURITY: readonly MaturityRating[] = [
  'G', 'PG', 'PG-13', 'R', 'NC-17', 'TV-MA', 'TV-14', 'TV-PG',
];

/** Shape of a `titles` row joined with its genres. */
interface TitleRow {
  id: string;
  type: TitleType;
  slug: string;
  name: string;
  original_name: string | null;
  synopsis: string;
  release_year: number | null;
  runtime_minutes: number | null;
  maturity: string;
  poster_url: string | null;
  backdrop_url: string | null;
  trailer_url: string | null;
  editorial_score: number | null;
  featured: boolean;
  tmdb_id: number | null;
  imdb_id: string | null;
  title_genres: { genres: { name: string } | null }[] | null;
}

const TITLE_SELECT =
  'id, type, slug, name, original_name, synopsis, release_year, runtime_minutes, ' +
  'maturity, poster_url, backdrop_url, trailer_url, editorial_score, featured, ' +
  'tmdb_id, imdb_id, title_genres ( genres ( name ) )';

/** Coerce a free-text DB maturity string to the DTO union, defaulting to NR-ish. */
function toMaturity(value: string): MaturityRating {
  return (VALID_MATURITY as readonly string[]).includes(value)
    ? (value as MaturityRating)
    : 'PG-13';
}

/** Map a DB row (+ joined genres) to the client-safe DTO. Normalizes nullables. */
function toTitle(row: TitleRow): Title {
  const genres = (row.title_genres ?? [])
    .map((tg) => tg.genres?.name)
    .filter((n): n is string => Boolean(n))
    .sort((a, b) => a.localeCompare(b));

  const title: Title = {
    id: row.id,
    type: row.type,
    slug: row.slug,
    name: row.name,
    synopsis: row.synopsis,
    releaseYear: row.release_year ?? 0,
    maturity: toMaturity(row.maturity),
    genres,
    featured: row.featured,
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

export async function repoGetTitleBySlug(type: TitleType, slug: string): Promise<Title | null> {
  const db = await getSupabaseServerClient();
  const { data, error } = await db
    .from('titles')
    .select(TITLE_SELECT)
    .eq('type', type)
    .eq('slug', slug)
    .maybeSingle();
  if (error) throw new Error(`repoGetTitleBySlug: ${error.message}`);
  return data ? toTitle(data as unknown as TitleRow) : null;
}

/** Cheap UUID shape check — avoids a Postgres `invalid input syntax` round-trip. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function repoGetTitleById(id: string): Promise<Title | null> {
  // Mock catalog ids (e.g. 't-aurora') are not UUIDs; treat them as not-in-DB so
  // callers fall back to the mock catalog instead of throwing a syntax error.
  if (!UUID_RE.test(id)) return null;
  const db = await getSupabaseServerClient();
  const { data, error } = await db.from('titles').select(TITLE_SELECT).eq('id', id).maybeSingle();
  if (error) throw new Error(`repoGetTitleById: ${error.message}`);
  return data ? toTitle(data as unknown as TitleRow) : null;
}

export async function repoListGenres(): Promise<string[]> {
  const db = await getSupabaseServerClient();
  const { data, error } = await db.from('genres').select('name').order('name');
  if (error) throw new Error(`repoListGenres: ${error.message}`);
  return (data ?? []).map((g) => g.name);
}

export async function repoListTitles(filters: TitleFilters = {}): Promise<Title[]> {
  const db = await getSupabaseServerClient();
  let query = db.from('titles').select(TITLE_SELECT);

  if (filters.type) query = query.eq('type', filters.type);
  if (filters.year) query = query.eq('release_year', filters.year);
  if (filters.minYear) query = query.gte('release_year', filters.minYear);
  if (filters.maxYear) query = query.lte('release_year', filters.maxYear);
  if (filters.maturity) query = query.eq('maturity', filters.maturity);
  // Indexed trigram-backed ILIKE on name (Section 4); `titles_name_trgm_idx`
  // (a gin trigram index) keeps this fast.
  if (filters.query) query = query.ilike('name', `%${filters.query}%`);

  // Sort in-DB by the appropriate column.
  switch (filters.sort) {
    case 'newest':
      query = query.order('release_year', { ascending: false, nullsFirst: false });
      break;
    case 'oldest':
      query = query.order('release_year', { ascending: true, nullsFirst: false });
      break;
    case 'az':
      query = query.order('name', { ascending: true });
      break;
    case 'score':
    case 'trending':
    default:
      query = query.order('editorial_score', { ascending: false, nullsFirst: false });
      break;
  }

  const { data, error } = await query;
  if (error) throw new Error(`repoListTitles: ${error.message}`);
  let out = (data ?? []).map((r) => toTitle(r as unknown as TitleRow));

  // Genre filter is applied in-memory because it filters on the joined table;
  // doing it here keeps the DTO mapping in one place and the row count is small.
  if (filters.genre) {
    const g = filters.genre.toLowerCase();
    out = out.filter((t) => t.genres.some((name) => name.toLowerCase() === g));
  }
  return out;
}

/** Paged listing result: one `range`d page plus the exact matching total. */
export interface PagedTitles {
  rows: Title[];
  /** Total rows matching the filters (from the count, never the page length). */
  total: number;
}

/**
 * Paged variant of {@link repoListTitles} for the admin console. An un-paged
 * read silently truncates at Supabase's default 1,000-row cap, so this pages
 * in-DB with `.range()` and asks Postgres for the exact matching count in the
 * same request (`count: 'exact'` is computed over the FULL filtered set, not
 * just the page). RLS still applies, so the caller pages through exactly the
 * rows they are allowed to see — drafts included for `catalog.read` holders.
 */
export async function repoListTitlesPaged(
  filters: TitleFilters & { page: number; pageSize: number },
): Promise<PagedTitles> {
  const db = await getSupabaseServerClient();

  let query = db.from('titles').select(TITLE_SELECT, { count: 'exact' });
  if (filters.type) query = query.eq('type', filters.type);
  if (filters.query) query = query.ilike('name', `%${filters.query}%`);
  query = query.order('name', { ascending: true });

  const page = Math.max(1, filters.page);
  const pageSize = Math.max(1, filters.pageSize);
  const { data, error, count } = await query.range((page - 1) * pageSize, page * pageSize - 1);
  if (error) throw new Error(`repoListTitlesPaged: ${error.message}`);
  return { rows: (data ?? []).map((r) => toTitle(r as unknown as TitleRow)), total: count ?? 0 };
}

/** Similar titles by shared-genre overlap (transparent v1 rule, Section 13). */
export async function repoGetSimilarTitles(title: Title, limit = 6): Promise<Title[]> {
  // Pull a candidate pool of the same type and rank by genre overlap in-memory.
  const pool = await repoListTitles({ type: title.type, sort: 'score' });
  return pool
    .filter((t) => t.id !== title.id)
    .map((t) => ({ t, overlap: t.genres.filter((gname) => title.genres.includes(gname)).length }))
    .filter((x) => x.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap || (b.t.score ?? 0) - (a.t.score ?? 0))
    .slice(0, limit)
    .map((x) => x.t);
}

/** Shape of a `seasons` row. */
interface SeasonRow {
  id: string;
  title_id: string;
  season_number: number;
  name: string | null;
  overview: string;
  air_date: string | null;
  episode_count: number | null;
}

/** Shape of an `episodes` row. */
interface EpisodeRow {
  id: string;
  title_id: string;
  season_id: string | null;
  season_number: number | null;
  episode_number: number;
  name: string;
  overview: string;
  air_date: string | null;
  runtime_minutes: number | null;
  still_url: string | null;
}

/** Shape of a `title_people` row joined with its person. */
interface CastCreditRow {
  credit_order: number;
  character: string | null;
  people: { id: string; name: string; profile_url: string | null } | null;
}

// Like TITLE_SELECT: opaque select strings + explicit row casts, because the
// generated Database types carry no FK relationships for these tables.
const SEASON_SELECT =
  'id, title_id, season_number, name, overview, air_date, episode_count';
const EPISODE_SELECT =
  'id, title_id, season_id, season_number, episode_number, name, overview, ' +
  'air_date, runtime_minutes, still_url';
const CAST_SELECT = 'credit_order, character, people ( id, name, profile_url )';

/**
 * Seasons (with any imported episode rows) for one title, ordered by season
 * number. Seasons whose episodes haven't been imported yet still return —
 * their `episodeCount` carries the honest "N episodes" count and `episodes`
 * stays empty, so the UI never fabricates per-episode detail.
 */
export async function repoListSeasonsForTitle(titleId: string): Promise<Season[]> {
  const db = await getSupabaseServerClient();
  const { data: seasons, error: seasonErr } = await db
    .from('seasons')
    .select(SEASON_SELECT)
    .eq('title_id', titleId)
    .order('season_number', { ascending: true });
  if (seasonErr) throw new Error(`repoListSeasonsForTitle: ${seasonErr.message}`);
  if (!seasons || seasons.length === 0) return [];

  const { data: episodes, error: episodeErr } = await db
    .from('episodes')
    .select(EPISODE_SELECT)
    .eq('title_id', titleId)
    .order('season_number', { ascending: true })
    .order('episode_number', { ascending: true });
  if (episodeErr) throw new Error(`repoListSeasonsForTitle: ${episodeErr.message}`);

  // Group episode rows under their season (fall back to season_number when the
  // row somehow lost its season_id link).
  const bySeasonId = new Map<string, Season['episodes']>();
  const byNumber = new Map<number, Season['episodes']>();
  for (const row of (episodes ?? []) as unknown as EpisodeRow[]) {
    const episode = {
      id: row.id,
      seasonNumber: row.season_number ?? 0,
      episodeNumber: row.episode_number,
      name: row.name,
      overview: row.overview,
      airDate: row.air_date,
      runtimeMinutes: row.runtime_minutes,
      stillUrl: row.still_url,
    };
    if (row.season_id) {
      const list = bySeasonId.get(row.season_id) ?? [];
      list.push(episode);
      bySeasonId.set(row.season_id, list);
    } else {
      const list = byNumber.get(episode.seasonNumber) ?? [];
      list.push(episode);
      byNumber.set(episode.seasonNumber, list);
    }
  }

  return (seasons as unknown as SeasonRow[]).map((s) => ({
    id: s.id,
    seasonNumber: s.season_number,
    name: s.name,
    overview: s.overview,
    airDate: s.air_date,
    episodeCount: s.episode_count,
    episodes: bySeasonId.get(s.id) ?? byNumber.get(s.season_number) ?? [],
  }));
}

/** Cast credits (person joined) for one title, ordered by billing. */
export async function repoListCastForTitle(titleId: string): Promise<CastMember[]> {
  const db = await getSupabaseServerClient();
  const { data, error } = await db
    .from('title_people')
    .select(CAST_SELECT)
    .eq('title_id', titleId)
    .eq('credit_type', 'cast')
    .order('credit_order', { ascending: true });
  if (error) throw new Error(`repoListCastForTitle: ${error.message}`);
  const out: CastMember[] = [];
  for (const row of (data ?? []) as unknown as CastCreditRow[]) {
    if (!row.people) continue;
    out.push({
      personId: row.people.id,
      name: row.people.name,
      character: row.character ?? null,
      profileUrl: row.people.profile_url ?? null,
    });
  }
  return out;
}
