import { features } from '@/lib/env';
import type { ContinueWatchingEntry, MediaRow, Title } from './types';
import { listTitles } from './queries';

/**
 * Catalog read service (Section 6: route handlers -> services -> repositories).
 *
 * The home page is built ONLY from live catalog rows (via `listTitles`, which
 * reads Postgres under RLS). If Supabase is not configured, the read fails, or
 * the catalog is empty, `hero` is null and `rows`/`continueWatching` are empty
 * so the home page renders an honest empty state — never fabricated content.
 * `degraded` is true when the live source could not be read at all.
 */

export interface HomeData {
  /** Null when the catalog is empty or could not be read. */
  hero: Title | null;
  continueWatching: ContinueWatchingEntry[];
  rows: MediaRow[];
  /** True when the live catalog could not be read (unconfigured or DB error). */
  degraded: boolean;
  /**
   * True when the request carries a session. Signed-in viewers get the
   * server-side continue-watching row; guests get the browser-local guest row
   * instead — one or the other, never both (Spec Sections 4, 8).
   */
  signedIn: boolean;
}

/** Build home rows (featured hero + genre/newest rows) from a live title set. */
function buildRows(titles: Title[]): MediaRow[] {
  const rows: MediaRow[] = [];

  const trending = [...titles].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, 12);
  if (trending.length) rows.push({ id: 'trending', heading: 'Trending now', titles: trending });

  const newest = [...titles].sort((a, b) => b.releaseYear - a.releaseYear).slice(0, 12);
  if (newest.length) rows.push({ id: 'newest', heading: 'New & recent', titles: newest });

  const movies = titles.filter((t) => t.type === 'movie').slice(0, 12);
  if (movies.length) rows.push({ id: 'movies', heading: 'Movies', titles: movies });

  const series = titles.filter((t) => t.type === 'tv').slice(0, 12);
  if (series.length) rows.push({ id: 'tv', heading: 'TV series', titles: series });

  // Genre rows for the most common genres in the live set.
  const byGenre = new Map<string, Title[]>();
  for (const t of titles) {
    for (const g of t.genres) {
      const list = byGenre.get(g) ?? [];
      list.push(t);
      byGenre.set(g, list);
    }
  }
  const topGenres = [...byGenre.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 4);
  for (const [genre, list] of topGenres) {
    if (list.length >= 3) {
      rows.push({ id: `genre-${genre.toLowerCase()}`, heading: genre, titles: list.slice(0, 12) });
    }
  }

  return rows;
}

/**
 * Continue-watching row for the signed-in viewer. Dynamically imported (like
 * the repository in ./queries) so the server-only progress module never lands
 * in a client bundle. Anonymous viewers and read failures get [] — the row
 * simply does not render.
 */
async function loadContinueWatching(): Promise<ContinueWatchingEntry[]> {
  if (!features.supabaseConfigured) return [];
  try {
    const { getContinueWatching } = await import('@/features/playback/progress-queries');
    return await getContinueWatching();
  } catch (err) {
    console.warn('catalog.getHomeData: continue-watching read failed', {
      message: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/** True when the request carries a session (drives guest vs. server rows). */
async function loadSignedIn(): Promise<boolean> {
  if (!features.supabaseConfigured) return false;
  try {
    const { isSignedIn } = await import('@/features/playback/progress-queries');
    return await isSignedIn();
  } catch {
    return false;
  }
}

export async function getHomeData(): Promise<HomeData> {
  if (!features.supabaseConfigured) {
    return { hero: null, continueWatching: [], rows: [], degraded: true, signedIn: false };
  }

  try {
    const [titles, continueWatching, signedIn] = await Promise.all([
      listTitles({ sort: 'trending' }),
      loadContinueWatching(),
      loadSignedIn(),
    ]);
    if (!titles.length) {
      // DB reachable but empty catalog — honest empty state, not mock data.
      return { hero: null, continueWatching, rows: [], degraded: false, signedIn };
    }

    const hero = titles.find((t) => t.featured) ?? titles[0]!;
    const rows = buildRows(titles);

    return {
      hero,
      continueWatching,
      rows,
      degraded: false,
      signedIn,
    };
  } catch (err) {
    console.warn('catalog.getHomeData: repository failed, returning empty catalog', {
      message: err instanceof Error ? err.message : String(err),
    });
    return { hero: null, continueWatching: [], rows: [], degraded: true, signedIn: false };
  }
}
