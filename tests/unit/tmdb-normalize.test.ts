import { describe, expect, it } from 'vitest';
import {
  MAX_CAST_MEMBERS,
  normalizeCast,
  normalizeEpisodes,
  normalizeMovie,
  normalizeTv,
  posterSrc,
  slugify,
  validYear,
  type TmdbCredits,
  type TmdbMovieDetail,
  type TmdbSeasonDetail,
  type TmdbTvDetail,
} from '@/features/catalog/tmdb-normalize';

/** Inception — real TMDB detail payload shape (trimmed to used fields). */
const MOVIE_FIXTURE = {
  id: 27205,
  imdb_id: 'tt1375666',
  title: 'Inception',
  original_title: 'Inception',
  overview: 'A thief who steals corporate secrets through dream-sharing technology.',
  release_date: '2010-07-15',
  runtime: 148,
  original_language: 'en',
  poster_path: '/oYuLEt3zVCKq57qu2F8dT7NIa6f.jpg',
  backdrop_path: '/8ZTVqvKDQ8emSGUEMjsBcSGZGHm.jpg',
  vote_average: 8.4,
  genres: [
    { id: 28, name: 'Action' },
    { id: 878, name: 'Science Fiction' },
  ],
  release_dates: {
    results: [
      { iso_3166_1: 'US', release_dates: [{ certification: 'PG-13' }, { certification: '' }] },
      { iso_3166_1: 'GB', release_dates: [{ certification: '12A' }] },
    ],
  },
} satisfies TmdbMovieDetail;

/** Breaking Bad — real TMDB TV detail payload shape (trimmed). */
const TV_FIXTURE = {
  id: 1396,
  external_ids: { imdb_id: 'tt0903747' },
  name: 'Breaking Bad',
  original_name: 'Breaking Bad',
  overview: 'A terminally-ill chemistry teacher partners with a former student.',
  first_air_date: '2008-01-20',
  episode_run_time: [49],
  original_language: 'en',
  poster_path: '/ggFHVNu6YYI5L9pCfOacpiz8H1e.jpg',
  backdrop_path: '/tsRy63Mu5cu8etL1X7ZLyf7UP1M.jpg',
  vote_average: 8.9,
  genres: [{ id: 18, name: 'Drama' }],
  content_ratings: { results: [{ iso_3166_1: 'US', rating: 'TV-MA' }] },
  seasons: [
    {
      season_number: 0, // specials — must be excluded
      name: 'Specials',
      overview: 'Extras',
      air_date: null,
      poster_path: null,
      episode_count: 6,
    },
    {
      season_number: 1,
      name: 'Season 1',
      overview: 'Walter White begins cooking meth.',
      air_date: '2008-01-20',
      poster_path: '/sp.jpg',
      episode_count: 7,
    },
    {
      season_number: 2,
      name: 'Season 2',
      overview: 'The stakes rise.',
      air_date: '2009-03-08',
      poster_path: null,
      episode_count: 13,
    },
  ],
} satisfies TmdbTvDetail;

describe('tmdb slugify', () => {
  it('lowercases, strips diacritics, and joins with hyphens', () => {
    expect(slugify('The Dark Knight')).toBe('the-dark-knight');
    expect(slugify('Amélie Poulain!')).toBe('amelie-poulain');
    expect(slugify('  Multiple   spaces  ')).toBe('multiple-spaces');
  });
});

describe('validYear', () => {
  it('accepts plausible years', () => {
    expect(validYear('2010-07-15')).toBe(2010);
    expect(validYear('1895-01-01')).toBe(1895);
  });
  it('rejects out-of-range and missing dates', () => {
    expect(validYear('1500-01-01')).toBeNull();
    expect(validYear('2200-01-01')).toBeNull();
    expect(validYear(null)).toBeNull();
  });
});

describe('posterSrc', () => {
  it('passes through http(s) urls only', () => {
    expect(posterSrc('https://image.tmdb.org/t/p/w500/x.jpg')).toBe('https://image.tmdb.org/t/p/w500/x.jpg');
    expect(posterSrc('linear-gradient(...)')).toBeNull();
    expect(posterSrc(null)).toBeNull();
  });
});

describe('normalizeMovie', () => {
  const t = normalizeMovie(MOVIE_FIXTURE);

  it('maps identity, ids, and slug convention', () => {
    expect(t).not.toBeNull();
    expect(t!.type).toBe('movie');
    expect(t!.tmdbId).toBe(27205);
    expect(t!.imdbId).toBe('tt1375666');
    expect(t!.slug).toBe('inception-27205');
  });

  it('maps metadata and US certification', () => {
    expect(t!.releaseYear).toBe(2010);
    expect(t!.runtimeMinutes).toBe(148);
    expect(t!.maturity).toBe('PG-13');
    expect(t!.score).toBe(84); // 8.4 * 10
    expect(t!.genres).toEqual(['Action', 'Science Fiction']);
  });

  it('builds artwork urls from tmdb image host', () => {
    expect(t!.posterUrl).toBe('https://image.tmdb.org/t/p/w500/oYuLEt3zVCKq57qu2F8dT7NIa6f.jpg');
    expect(t!.backdropUrl).toBe('https://image.tmdb.org/t/p/w1280/8ZTVqvKDQ8emSGUEMjsBcSGZGHm.jpg');
  });

  it('falls back to NR when no US certification', () => {
    const noCert = normalizeMovie({ ...MOVIE_FIXTURE, release_dates: undefined });
    expect(noCert!.maturity).toBe('NR');
  });

  it('rejects titles without a name or overview', () => {
    expect(normalizeMovie({ ...MOVIE_FIXTURE, overview: '' })).toBeNull();
    expect(normalizeMovie({ ...MOVIE_FIXTURE, title: '' })).toBeNull();
  });

  it('keeps the original title only when it differs', () => {
    expect(t!.originalName).toBeNull();
    const translated = normalizeMovie({ ...MOVIE_FIXTURE, original_title: 'Origen' });
    expect(translated!.originalName).toBe('Origen');
  });
});

describe('normalizeTv', () => {
  const t = normalizeTv(TV_FIXTURE);

  it('maps identity and external ids', () => {
    expect(t).not.toBeNull();
    expect(t!.type).toBe('tv');
    expect(t!.imdbId).toBe('tt0903747');
    expect(t!.slug).toBe('breaking-bad-1396');
    expect(t!.runtimeMinutes).toBe(49);
    expect(t!.maturity).toBe('TV-MA');
  });

  it('maps seasons and excludes specials (season 0)', () => {
    expect(t!.seasons).toHaveLength(2);
    const s1 = t!.seasons[0]!;
    expect(s1.seasonNumber).toBe(1);
    expect(s1.name).toBe('Season 1');
    expect(s1.airDate).toBe('2008-01-20');
    expect(s1.posterUrl).toBe('https://image.tmdb.org/t/p/w500/sp.jpg');
    expect(s1.episodeCount).toBe(7);
    expect(t!.seasons.every((s) => s.seasonNumber > 0)).toBe(true);
  });

  it('rejects series without a name or overview', () => {
    expect(normalizeTv({ ...TV_FIXTURE, overview: '' })).toBeNull();
  });
});

/** TMDB `credits` append payload (trimmed) — Breaking Bad's top billing. */
const CREDITS_FIXTURE = {
  cast: [
    { id: 17419, name: 'Bryan Cranston', character: 'Walter White', known_for_department: 'Acting', profile_path: '/1fjpTCGbQPCy0nuW2vW9Hq4cZ0.jpg', order: 0 },
    { id: 34395, name: 'Anna Gunn', character: 'Skyler White', known_for_department: 'Acting', profile_path: '/qzHLMjKVnd7TvrIXOvC5mnnaqbP.jpg', order: 1 },
    // No profile art but an actor — must be KEPT.
    { id: 1234, name: 'Unphotographed Actor', character: 'Guest', known_for_department: 'Acting', profile_path: null, order: 2 },
    // Profile art exists but not an actor — still kept (profile-path rule).
    { id: 5678, name: 'Cameo Director', character: 'Himself', known_for_department: 'Directing', profile_path: '/dir.jpg', order: 3 },
    // No profile art AND not acting — must be DROPPED.
    { id: 9012, name: 'Voice Only', character: 'Narrator (voice)', known_for_department: 'Sound', profile_path: null, order: 4 },
    // No name — must be DROPPED.
    { id: 3456, name: null, character: 'Ghost', known_for_department: 'Acting', profile_path: null, order: 5 },
  ],
} satisfies TmdbCredits;

describe('normalizeCast', () => {
  const cast = normalizeCast(CREDITS_FIXTURE);

  it('maps identity, character, billing order, and profile url', () => {
    expect(cast).toHaveLength(4);
    expect(cast[0]).toEqual({
      tmdbId: 17419,
      name: 'Bryan Cranston',
      character: 'Walter White',
      profileUrl: 'https://image.tmdb.org/t/p/w185/1fjpTCGbQPCy0nuW2vW9Hq4cZ0.jpg',
      knownFor: 'Acting',
      creditOrder: 0,
    });
    expect(cast[1]!.character).toBe('Skyler White');
  });

  it('keeps actors without a profile photo, drops non-actors without one', () => {
    expect(cast.map((c) => c.name)).toContain('Unphotographed Actor');
    expect(cast.map((c) => c.name)).not.toContain('Voice Only');
    expect(cast.map((c) => c.name)).not.toContain('Ghost');
  });

  it('caps stored cast at the top-billed limit', () => {
    const many = Array.from({ length: MAX_CAST_MEMBERS + 10 }, (_, i) => ({
      id: 1000 + i,
      name: `Actor ${i}`,
      character: `Role ${i}`,
      known_for_department: 'Acting',
      profile_path: `/p${i}.jpg`,
      order: i,
    }));
    expect(normalizeCast({ cast: many })).toHaveLength(MAX_CAST_MEMBERS);
  });

  it('handles missing credits payloads', () => {
    expect(normalizeCast(undefined)).toEqual([]);
    expect(normalizeCast({})).toEqual([]);
  });

  it('is wired into normalizeMovie and normalizeTv', () => {
    expect(normalizeMovie({ ...MOVIE_FIXTURE, credits: CREDITS_FIXTURE })!.cast).toHaveLength(4);
    expect(normalizeTv({ ...TV_FIXTURE, credits: CREDITS_FIXTURE })!.cast).toHaveLength(4);
    expect(normalizeTv(TV_FIXTURE)!.cast).toEqual([]);
  });
});

/** `/tv/1396/season/1` payload (trimmed) — real episode shapes. */
const SEASON_FIXTURE = {
  id: 3572,
  season_number: 1,
  episodes: [
    { id: 62085, episode_number: 1, name: 'Pilot', overview: 'Diagnosed with terminal cancer, a chemistry teacher turns to cooking meth.', air_date: '2008-01-20', runtime: 58, still_path: '/ck00.jpg' },
    { id: 62086, episode_number: 2, name: "Cat's in the Bag...", overview: 'Walt and Jesse deal with the aftermath.', air_date: '2008-01-27', runtime: 48, still_path: null },
    // Unaired placeholder — no name, must be DROPPED.
    { id: 99999, episode_number: 3, name: null, overview: null, air_date: null, runtime: null, still_path: null },
    // Bad episode number, must be DROPPED.
    { id: 99998, episode_number: 0, name: 'Special', overview: 'x', air_date: null, runtime: 30, still_path: null },
  ],
} satisfies TmdbSeasonDetail;

describe('normalizeEpisodes', () => {
  const eps = normalizeEpisodes(SEASON_FIXTURE);

  it('maps number, name, overview, air date, runtime, still, and tmdb id', () => {
    expect(eps).toHaveLength(2);
    expect(eps[0]).toEqual({
      seasonNumber: 1,
      episodeNumber: 1,
      name: 'Pilot',
      overview: 'Diagnosed with terminal cancer, a chemistry teacher turns to cooking meth.',
      airDate: '2008-01-20',
      runtimeMinutes: 58,
      stillUrl: 'https://image.tmdb.org/t/p/w300/ck00.jpg',
      tmdbId: 62085,
    });
    expect(eps[1]!.stillUrl).toBeNull();
    expect(eps[1]!.runtimeMinutes).toBe(48);
  });

  it('drops placeholder rows without a name or positive episode number', () => {
    expect(eps.map((e) => e.episodeNumber)).toEqual([1, 2]);
  });

  it('defaults the season number when the payload omits it', () => {
    const noSeasonNumber = normalizeEpisodes({ episodes: SEASON_FIXTURE.episodes });
    expect(noSeasonNumber[0]!.seasonNumber).toBe(0);
  });

  it('handles empty season payloads', () => {
    expect(normalizeEpisodes({})).toEqual([]);
    expect(normalizeEpisodes({ episodes: [] })).toEqual([]);
  });
});
