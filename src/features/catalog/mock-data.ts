import type { ContinueWatchingEntry, MediaRow, Title } from './types';

/**
 * Local mock catalog so the UI is runnable before Supabase/TMDB are wired.
 * The catalog service (data.ts) returns this until a real data source is
 * configured — this is the "graceful degradation" default, not a hardcoded
 * production catalog.
 */

function title(t: Omit<Title, 'posterUrl' | 'backdropUrl'> & { hue: number }): Title {
  // Generative gradient placeholders keep the shell premium without shipping
  // unlicensed artwork. Replaced by real posterUrl/backdropUrl from the DB.
  const { hue, ...rest } = t;
  const poster = `linear-gradient(160deg, hsl(${hue} 55% 22%), hsl(${(hue + 40) % 360} 45% 10%))`;
  const backdrop = `linear-gradient(120deg, hsl(${hue} 50% 18%), hsl(${(hue + 60) % 360} 40% 8%))`;
  return { ...rest, posterUrl: poster, backdropUrl: backdrop };
}

export const MOCK_TITLES: Title[] = [
  title({
    id: 't-aurora',
    type: 'movie',
    slug: 'aurora-drift',
    name: 'Aurora Drift',
    synopsis:
      'A deep-space salvage crew discovers a derelict vessel carrying a signal that predates the stars around it.',
    releaseYear: 2024,
    runtimeMinutes: 128,
    maturity: 'PG-13',
    genres: ['Sci-Fi', 'Thriller'],
    score: 88,
    featured: true,
    hue: 220,
  }),
  title({
    id: 't-lantern',
    type: 'tv',
    slug: 'the-lantern-district',
    name: 'The Lantern District',
    synopsis:
      'In a rain-soaked port city, a retired detective is pulled back in by a case that mirrors her own past.',
    releaseYear: 2023,
    runtimeMinutes: 52,
    maturity: 'TV-MA',
    genres: ['Crime', 'Drama'],
    score: 92,
    featured: true,
    hue: 280,
  }),
  title({
    id: 't-meridian',
    type: 'movie',
    slug: 'meridian',
    name: 'Meridian',
    synopsis: 'Two rival cartographers race to map an uncharted coastline before a coming storm erases it.',
    releaseYear: 2025,
    runtimeMinutes: 111,
    maturity: 'PG',
    genres: ['Adventure'],
    score: 79,
    hue: 30,
  }),
  title({
    id: 't-glasshouse',
    type: 'tv',
    slug: 'glasshouse',
    name: 'Glasshouse',
    synopsis: 'A botanist inherits a greenhouse that seems to remember everyone who has ever worked inside it.',
    releaseYear: 2022,
    runtimeMinutes: 45,
    maturity: 'TV-14',
    genres: ['Mystery', 'Drama'],
    score: 74,
    hue: 150,
  }),
  title({
    id: 't-nightcall',
    type: 'movie',
    slug: 'night-call',
    name: 'Night Call',
    synopsis: 'A late-shift dispatcher becomes the only lifeline for a caller she cannot locate.',
    releaseYear: 2024,
    runtimeMinutes: 96,
    maturity: 'R',
    genres: ['Thriller'],
    score: 83,
    hue: 350,
  }),
  title({
    id: 't-emberfall',
    type: 'tv',
    slug: 'emberfall',
    name: 'Emberfall',
    synopsis: 'Rival guilds vie for control of a city that runs entirely on captured light.',
    releaseYear: 2025,
    runtimeMinutes: 58,
    maturity: 'TV-14',
    genres: ['Fantasy', 'Adventure'],
    score: 81,
    hue: 18,
  }),
  title({
    id: 't-tidewater',
    type: 'movie',
    slug: 'tidewater',
    name: 'Tidewater',
    synopsis: 'A marine biologist returns to her flooded hometown and finds it stranger than she left it.',
    releaseYear: 2023,
    runtimeMinutes: 104,
    maturity: 'PG-13',
    genres: ['Drama', 'Mystery'],
    score: 76,
    hue: 195,
  }),
  title({
    id: 't-signal',
    type: 'tv',
    slug: 'signal-fire',
    name: 'Signal Fire',
    synopsis: 'A remote research station picks up a broadcast that should not exist.',
    releaseYear: 2024,
    runtimeMinutes: 49,
    maturity: 'TV-MA',
    genres: ['Sci-Fi', 'Horror'],
    score: 87,
    hue: 260,
  }),
];

function byId(id: string): Title {
  const found = MOCK_TITLES.find((t) => t.id === id);
  if (!found) throw new Error(`mock title not found: ${id}`);
  return found;
}

export const MOCK_CONTINUE_WATCHING: ContinueWatchingEntry[] = [
  {
    title: byId('t-lantern'),
    progress: { titleId: 't-lantern', progress: 0.42, positionSeconds: 1310, updatedAt: '2026-09-03T20:00:00Z' },
  },
  {
    title: byId('t-aurora'),
    progress: { titleId: 't-aurora', progress: 0.71, positionSeconds: 5460, updatedAt: '2026-09-02T22:15:00Z' },
  },
  {
    title: byId('t-signal'),
    progress: { titleId: 't-signal', progress: 0.18, positionSeconds: 530, updatedAt: '2026-09-01T19:40:00Z' },
  },
];

export const MOCK_ROWS: MediaRow[] = [
  {
    id: 'trending',
    heading: 'Trending now',
    titles: [byId('t-signal'), byId('t-lantern'), byId('t-aurora'), byId('t-emberfall'), byId('t-nightcall')],
  },
  {
    id: 'popular',
    heading: 'Popular on Lumora',
    titles: [byId('t-aurora'), byId('t-meridian'), byId('t-tidewater'), byId('t-glasshouse'), byId('t-emberfall')],
  },
  {
    id: 'recently-added',
    heading: 'Recently added',
    titles: [byId('t-meridian'), byId('t-emberfall'), byId('t-signal'), byId('t-nightcall')],
  },
  {
    id: 'sci-fi',
    heading: 'Because you watch Sci-Fi',
    reason: 'Based on titles in your history tagged Sci-Fi',
    titles: [byId('t-aurora'), byId('t-signal'), byId('t-emberfall')],
  },
];

export const MOCK_HERO: Title = byId('t-lantern');
