import { describe, expect, it } from 'vitest';
import {
  normalizeMovie,
  normalizeTv,
  posterSrc,
  slugify,
  validYear,
  type TmdbMovieDetail,
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
