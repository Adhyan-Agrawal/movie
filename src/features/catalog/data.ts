import { features } from '@/lib/env';
import type { ContinueWatchingEntry, DiscoveryCollection, MediaRow, Title } from './types';
import { listTitles } from './queries';
import { DISCOVERY_COLLECTIONS, discoveryHref, loadDiscoveryRows } from './discovery';

/**
 * Catalog read service (Section 6: route handlers -> services -> repositories).
 *
 * The home page is built ONLY from live catalog rows (via `listTitles`, which
 * prefers TMDB, then reads Postgres under RLS). If neither is configured or
 * the catalog is empty, `hero` is null and `rows`/`continueWatching` are empty
 * so the home page renders an honest empty state — never fabricated content.
 * `degraded` is true when the live source could not be read at all.
 */

export interface HomeData {
  /** Null when the catalog is empty or could not be read. */
  hero: Title | null;
  /**
    * The rotating hero carousel pool: up to six trending movies and series
   * that the home hero auto-cycles through, so the banner surfaces different
   * content across visits instead of pinning one title.
   */
  heroTitles: Title[];
  continueWatching: ContinueWatchingEntry[];
  rows: MediaRow[];
  /** Optional, shared with the mobile home bridge. Only nonempty collections. */
  collections?: DiscoveryCollection[];
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

/** Public bridge entry point: never reads authentication, history or recommendations. */
export function getPublicHomeData(): Promise<HomeData> {
  return getHomeData({ personalize: false });
}

export async function getHomeData(options: { personalize?: boolean } = {}): Promise<HomeData> {
  if (!features.supabaseConfigured && !features.tmdbConfigured) {
    return {
      hero: null,
      heroTitles: [],
      continueWatching: [],
      rows: [],
      collections: [],
      forYou: null,
      degraded: true,
      signedIn: false,
    };
  }

  try {
    const [trending, discoveryRows, continueWatching, signedIn, forYou] = await Promise.all([
      // Bounded read (egress): the home page only builds twelve-card shelves and
       // a six-slide hero from this set — pulling the whole catalog here was the
      // single biggest egress consumer.
      listTitles({ sort: 'trending', limit: 20 }),
      loadDiscoveryRows(listTitles),
      options.personalize === false ? Promise.resolve([]) : loadContinueWatching(),
      options.personalize === false ? Promise.resolve(false) : loadSignedIn(),
      options.personalize === false ? Promise.resolve(null) : loadForYou(),
    ]);
    const titles = trending.length ? trending : discoveryRows.flatMap((row) => row.titles);
    if (!titles.length) {
      // DB reachable but empty catalog — honest empty state, not mock data.
      return {
        hero: null,
        heroTitles: [],
        continueWatching,
        rows: [],
        collections: [],
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
    const heroWorthy = [...new Map(titles.filter((t) => t.backdropUrl && !t.genres.some((g) => HERO_EXCLUDED_GENRES.has(g))).map((t) => [t.id, t])).values()];
    const heroMovies = heroWorthy.filter((t) => t.type === 'movie').slice(0, 3);
    const heroSeries = heroWorthy.filter((t) => t.type === 'tv').slice(0, 3);
    const heroTitles: Title[] = [];
    for (let i = 0; i < Math.max(heroMovies.length, heroSeries.length); i++) {
      if (i < heroMovies.length) heroTitles.push(heroMovies[i]!);
      if (i < heroSeries.length) heroTitles.push(heroSeries[i]!);
    }
    // 6-hour bucket advances deterministically so each window is stable for
    // cached renders, then the carousel start position changes.
    const heroBucket = Math.floor(Date.now() / (6 * 60 * 60 * 1000));
    const hero = heroTitles[heroBucket % heroTitles.length] ?? titles[0]!;
    const rows: MediaRow[] = [
      ...(trending.length ? [{ id: 'trending', collectionId: 'trending', heading: 'Trending now', titles: trending.slice(0, 12), href: discoveryHref({ sort: 'trending' }), filters: { sort: 'trending' as const } }] : []),
      ...discoveryRows,
    ];
    const collections = DISCOVERY_COLLECTIONS.filter((collection) => rows.some((row) => row.id === collection.id));

    return {
      hero,
      heroTitles,
      continueWatching,
      rows,
      collections,
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
      collections: [],
      forYou: null,
      degraded: true,
      signedIn: false,
    };
  }
}
