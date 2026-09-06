import { describe, expect, it } from 'vitest';
import {
  formatEpisodeCode,
  formatRuntime,
  synthesizeCredits,
  synthesizeSeasons,
  truncate,
} from '@/features/catalog/components/title-detail-helpers';
import { MOCK_TITLES } from '@/features/catalog/mock-data';
import type { Title } from '@/features/catalog/types';

function firstTvTitle(): Title {
  const tv = MOCK_TITLES.find((t) => t.type === 'tv');
  if (!tv) throw new Error('expected at least one tv title in mock data');
  return tv;
}

describe('formatRuntime', () => {
  it('formats hours and minutes', () => {
    expect(formatRuntime(128)).toBe('2h 8m');
  });

  it('formats a whole hour without trailing minutes', () => {
    expect(formatRuntime(120)).toBe('2h');
  });

  it('formats sub-hour runtimes', () => {
    expect(formatRuntime(52)).toBe('52m');
  });

  it('returns null for missing or zero runtime', () => {
    expect(formatRuntime(undefined)).toBeNull();
    expect(formatRuntime(0)).toBeNull();
  });
});

describe('formatEpisodeCode', () => {
  it('builds SxEy codes', () => {
    expect(formatEpisodeCode(1, 1)).toBe('S1E1');
    expect(formatEpisodeCode(2, 10)).toBe('S2E10');
  });
});

describe('truncate', () => {
  it('leaves short strings unchanged', () => {
    expect(truncate('a short synopsis', 160)).toBe('a short synopsis');
  });

  it('truncates long strings on a boundary with an ellipsis', () => {
    const out = truncate('The quick brown fox jumps over the lazy dog again and again', 20);
    expect(out.length).toBeLessThanOrEqual(20);
    expect(out.endsWith('…')).toBe(true);
  });

  it('handles strings with no spaces without exceeding the limit', () => {
    const out = truncate('x'.repeat(200), 50);
    expect(out.length).toBeLessThanOrEqual(50);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('synthesizeSeasons', () => {
  it('produces 1–2 seasons with sequential, contiguous episode numbers', () => {
    const seasons = synthesizeSeasons(firstTvTitle());
    expect(seasons.length).toBeGreaterThanOrEqual(1);
    expect(seasons.length).toBeLessThanOrEqual(2);

    seasons.forEach((season, index) => {
      expect(season.seasonNumber).toBe(index + 1);
      expect(season.episodes.length).toBeGreaterThan(0);
      season.episodes.forEach((ep, epIndex) => {
        expect(ep.episodeNumber).toBe(epIndex + 1);
        expect(ep.seasonNumber).toBe(season.seasonNumber);
        expect(ep.runtimeMinutes).toBeGreaterThan(0);
        expect(ep.name.trim().length).toBeGreaterThan(0);
        expect(ep.synopsis.trim().length).toBeGreaterThan(0);
      });
    });
  });

  it('is deterministic for the same title', () => {
    const tv = firstTvTitle();
    expect(synthesizeSeasons(tv)).toEqual(synthesizeSeasons(tv));
  });
});

describe('synthesizeCredits', () => {
  it('returns non-empty, deterministic cast and crew', () => {
    const tv = firstTvTitle();
    const credits = synthesizeCredits(tv);

    expect(credits.cast.length).toBeGreaterThan(0);
    expect(credits.crew.length).toBeGreaterThan(0);
    for (const entry of [...credits.cast, ...credits.crew]) {
      expect(entry.name.trim().length).toBeGreaterThan(0);
      expect(entry.role.trim().length).toBeGreaterThan(0);
    }

    expect(synthesizeCredits(tv)).toEqual(synthesizeCredits(tv));
  });
});
