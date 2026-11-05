import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EpisodeNavigation, EpisodeNavigationRequest } from '@/features/player/episode-navigation';

vi.mock('server-only', () => ({}));
import { cacheEpisodeNavigation, clearEpisodeNavigationCache, readEpisodeNavigationCache } from '@/features/player/episode-navigation-cache';

const origin = 'https://app.example';
const input = (tmdbId = '1399'): EpisodeNavigationRequest => ({ type: 'tv', tmdbId, season: 1, episode: 1 });
const value = (tmdbId = '1399'): EpisodeNavigation => ({ previous: null, next: {
  name: 'Verified neighbor', seasonNumber: 1, episodeNumber: 2,
  href: `/watch/tv/verified-series-${tmdbId}?season=1&episode=2`,
} });

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-03T12:00:00Z')); clearEpisodeNavigationCache(); });
afterEach(() => { clearEpisodeNavigationCache(); vi.useRealTimers(); });

describe('settled public episode-navigation cache policy', () => {
  it('stores validated DTOs rather than promises, and does not extend TTL on a hit', async () => {
    cacheEpisodeNavigation(input(), value(), origin);
    const cached = readEpisodeNavigationCache(input())!;
    expect(cached.navigation).toEqual(value());
    expect(cached.navigation).not.toBeInstanceOf(Promise);
    cached.navigation.next!.name = 'Caller mutation';
    expect(readEpisodeNavigationCache(input())?.navigation.next?.name).toBe('Verified neighbor');
    await vi.advanceTimersByTimeAsync(299_000);
    expect(readEpisodeNavigationCache(input())?.cacheControl).toBe('public, max-age=1, s-maxage=1, must-revalidate');
    await vi.advanceTimersByTimeAsync(1000);
    expect(readEpisodeNavigationCache(input())).toBeNull();
  });

  it('bounds entries to 128 and isolates title and episode keys', () => {
    for (let number = 1; number <= 129; number++) cacheEpisodeNavigation(input(String(number)), value(String(number)), origin);
    expect(readEpisodeNavigationCache(input('1'))).toBeNull();
    expect(readEpisodeNavigationCache(input('2'))?.navigation).toEqual(value('2'));
    expect(readEpisodeNavigationCache({ ...input('2'), episode: 2 })).toBeNull();
  });

  it('expires at midnight so newly aired episodes are not hidden by a cached boundary', async () => {
    vi.setSystemTime(new Date('2026-11-03T23:59:58Z'));
    expect(cacheEpisodeNavigation(input(), value(), origin)?.cacheControl).toBe('public, max-age=2, s-maxage=2, must-revalidate');
    await vi.advanceTimersByTimeAsync(2000);
    expect(readEpisodeNavigationCache(input())).toBeNull();
  });

  it('rejects negative, noncanonical, foreign, or viewer-augmented DTOs before storage', () => {
    for (const navigation of [
      { previous: null, next: null },
      { ...value(), accountId: 'private' },
      { ...value(), next: { ...value().next!, href: '/watch/tv/other-12?season=1&episode=2' } },
      { ...value(), next: { ...value().next!, href: 'https://other.example/watch/tv/verified-series-1399?season=1&episode=2' } },
      { ...value(), next: { ...value().next!, ticket: 'private' } },
      { ...value(), next: { ...value().next!, episodeNumber: 1, href: '/watch/tv/verified-series-1399?season=1&episode=1' } },
      { previous: value().next, next: null },
    ]) {
      expect(cacheEpisodeNavigation(input(), navigation, origin)).toBeNull();
      expect(readEpisodeNavigationCache(input())).toBeNull();
    }
  });
});
