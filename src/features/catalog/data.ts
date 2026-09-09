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
  /**
   * The rotating hero carousel pool: top ~14 trending titles (movies + series)
   * that the home hero auto-cycles through, so the banner surfaces different
   * content across visits instead of pinning one title.
   */
  heroTitles: Title[];
  continueWatching: ContinueWatchingEntry[];
  rows: MediaRow[];
  /** Personalized "Because you watched" row for signed-in viewers, else null. */
  forYou: MediaRow | null;
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

  // Incoming list is popularity-ranked (trending) — keep that order so the
  // "Trending now" row shows recognizable hits, not obscure high-score titles.
  const trending = titles.slice(0, 12);
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

/** Personalized "Because you watched" row for signed-in viewers. */
async function loadForYou(): Promise<MediaRow | null> {
  if (!features.supabaseConfigured) return null;
  try {
    const { getForYouRow } = await import('./personalization');
    return await getForYouRow();
  } catch (err) {
    console.warn('catalog.getHomeData: personalization failed', {
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export async function getHomeData(): Promise<HomeData> {
  if (!features.supabaseConfigured) {
    return {
      hero: null,
      heroTitles: [],
      continueWatching: [],
      rows: [],
      forYou: null,
      degraded: true,
      signedIn: false,
    };
  }

  try {
    const [titles, continueWatching, signedIn, forYou] = await Promise.all([
      listTitles({ sort: 'trending' }),
      loadContinueWatching(),
      loadSignedIn(),
      loadForYou(),
    ]);
    if (!titles.length) {
      // DB reachable but empty catalog — honest empty state, not mock data.
      return {
        hero: null,
        heroTitles: [],
        continueWatching,
        rows: [],
        forYou: null,
        degraded: false,
        signedIn,
      };
    }

    // Rotating hero pool (Spec Section 4): the top trending titles drive the
    // auto-advancing hero carousel. "Trending" is popularity-ranked, but TV
    // popularity lists are dominated by reality/talk/news — not hero material.
    // Drop those genres and interleave the top movies + top scripted series so
    // the banner always features recognisable, premium titles of both kinds.
    const HERO_EXCLUDED_GENRES = new Set(['Reality', 'Talk', 'News', 'Game Show', 'Soap']);
    const heroWorthy = titles.filter((t) => !t.genres.some((g) => HERO_EXCLUDED_GENRES.has(g)));
    const heroMovies = heroWorthy.filter((t) => t.type === 'movie').slice(0, 7);
    const heroSeries = heroWorthy.filter((t) => t.type === 'tv').slice(0, 7);
    const heroTitles: Title[] = [];
    for (let i = 0; i < Math.max(heroMovies.length, heroSeries.length) && heroTitles.length < 14; i++) {
      if (i < heroMovies.length) heroTitles.push(heroMovies[i]!);
      if (i < heroSeries.length) heroTitles.push(heroSeries[i]!);
    }
    // 6-hour bucket advances deterministically so each window is stable for
    // cached renders, then the carousel start position changes.
    const heroBucket = Math.floor(Date.now() / (6 * 60 * 60 * 1000));
    const hero = heroTitles[heroBucket % heroTitles.length] ?? titles[0]!;
    const rows = buildRows(titles);

    return {
      hero,
      heroTitles,
      continueWatching,
      rows,
      forYou,
      degraded: false,
      signedIn,
    };
  } catch (err) {
    console.warn('catalog.getHomeData: repository failed, returning empty catalog', {
      message: err instanceof Error ? err.message : String(err),
    });
    return {
      hero: null,
      heroTitles: [],
      continueWatching: [],
      rows: [],
      forYou: null,
      degraded: true,
      signedIn: false,
    };
  }
}
