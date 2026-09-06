import 'server-only';

import { getSupabaseServerClient } from '@/lib/supabase/server';
import type { MaturityRating, Title, TitleType } from './types';
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
