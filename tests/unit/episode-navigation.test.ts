import { describe, expect, it } from 'vitest';
import {
  episodeNavigationPath,
  parseEpisodeNavigation,
  parseEpisodeNavigationRequest,
} from '@/features/player/episode-navigation';

const origin = 'https://app.example';
const target = (seasonNumber = 1, episodeNumber = 2) => ({
  seasonNumber,
  episodeNumber,
  name: 'A verified episode',
  href: `/watch/tv/verified-series-1399?season=${seasonNumber}&episode=${episodeNumber}`,
});

describe('episode navigation request and path contract', () => {
  it('builds a lazy URL from an existing series identifier and exact coordinates only', () => {
    expect(episodeNavigationPath({ type: 'tv', tmdbId: '1399', season: 0, episode: 1 }))
      .toBe('/api/episode-navigation?type=tv&tmdbId=1399&season=0&episode=1');
    expect(parseEpisodeNavigationRequest(new URLSearchParams('type=tv&tmdbId=1399&season=0&episode=1')))
      .toEqual({ type: 'tv', tmdbId: '1399', season: 0, episode: 1 });
  });

  it.each([
    { type: 'movie', tmdbId: '1399', season: 1, episode: 1 },
    { type: 'tv', season: 1, episode: 1 },
    { type: 'tv', tmdbId: '0', season: 1, episode: 1 },
    { type: 'tv', tmdbId: 1399 as unknown as string, season: 1, episode: 1 },
    { type: 'tv', tmdbId: '01399', season: 1, episode: 1 },
    { type: 'tv', tmdbId: '10000000000', season: 1, episode: 1 },
    { type: 'tv', tmdbId: '1399', episode: 1 },
    { type: 'tv', tmdbId: '1399', season: -1, episode: 1 },
    { type: 'tv', tmdbId: '1399', season: 1000, episode: 1 },
    { type: 'tv', tmdbId: '1399', season: 1.5, episode: 1 },
    { type: 'tv', tmdbId: '1399', season: 1, episode: 0 },
    { type: 'tv', tmdbId: '1399', season: 1, episode: 1000 },
    { type: 'tv', tmdbId: '1399', season: 1, episode: Number.NaN },
  ])('omits the optional path for unsupported identity %j', (input) => {
    expect(episodeNavigationPath(input)).toBeUndefined();
  });

  it.each([
    'type=movie&tmdbId=1399&season=1&episode=1',
    'type=tv&season=1&episode=1',
    'type=tv&tmdbId=1399&season=01&episode=1',
    'type=tv&tmdbId=1399&season=1e0&episode=1',
    'type=tv&tmdbId=1399&season=1.0&episode=1',
    'type=tv&tmdbId=1399&season=+1&episode=1',
    'type=tv&tmdbId=1399&season=1&episode=0',
    'type=tv&tmdbId=1399&season=1&episode=1000',
    'type=tv&tmdbId=1399&season=1&episode=1&episode=2',
    'type=tv&tmdbId=1399&season=1&episode=1&url=https://private.example',
  ])('rejects non-canonical, duplicate, or arbitrary lookup input %s', (query) => {
    expect(parseEpisodeNavigationRequest(new URLSearchParams(query))).toBeNull();
  });
});

describe('platform-neutral episode navigation validator', () => {
  it('accepts truthful null boundaries and copies only the frozen DTO', () => {
    expect(parseEpisodeNavigation({ previous: null, next: null }, origin))
      .toEqual({ previous: null, next: null });
    const input = { previous: null, next: target() };
    const parsed = parseEpisodeNavigation(input, origin);
    expect(parsed).toEqual(input);
    expect(parsed).not.toBe(input);
    expect(parsed?.next).not.toBe(input.next);
  });

  it('accepts relative and absolute same-origin watch paths and canonicalizes coordinates', () => {
    const previous = target(0, 1);
    const next = { ...target(0, 3), name: '  A real special  ', href: `${origin}/watch/tv/verified-series-1399?episode=3&season=0` };
    expect(parseEpisodeNavigation({ previous, next }, `${origin}/`))
      .toEqual({ previous, next: { ...target(0, 3), name: 'A real special' } });
    expect(parseEpisodeNavigation({ previous: null, next: target() }, 'http://localhost:3100'))
      .toEqual({ previous: null, next: target() });
  });

  it.each([
    null, [], {}, { previous: null },
    { previous: null, next: undefined },
    { previous: null, next: target(), providerId: 'private' },
    { previous: null, next: { ...target(), url: 'https://provider.example' } },
    { previous: null, next: { ...target(), seasonNumber: '1' } },
    { previous: null, next: { ...target(), episodeNumber: 0 } },
    { previous: null, next: { ...target(), episodeNumber: Number.POSITIVE_INFINITY } },
    { previous: null, next: { ...target(), name: '' } },
    { previous: null, next: { ...target(), name: ' '.repeat(10) } },
    { previous: null, next: { ...target(), name: 'x'.repeat(201) } },
    { previous: null, next: { ...target(), name: 'Unsafe\nlabel' } },
  ])('fails closed for a malformed or private-field payload %j', (payload) => {
    expect(parseEpisodeNavigation(payload, origin)).toBeNull();
  });

  it.each([
    'https://foreign.example/watch/tv/verified-series-1399?season=1&episode=2',
    'http://app.example/watch/tv/verified-series-1399?season=1&episode=2',
    'https://user:password@app.example/watch/tv/verified-series-1399?season=1&episode=2',
    '//app.example/watch/tv/verified-series-1399?season=1&episode=2',
    '/api/playback?season=1&episode=2',
    '/title/tv/verified-series-1399?season=1&episode=2',
    '/watch/movie/verified-series-1399?season=1&episode=2',
    '/watch/tv/../tv/verified-series-1399?season=1&episode=2',
    '/watch/tv/verified%2fseries-1399?season=1&episode=2',
    '/watch/tv/Verified-series-1399?season=1&episode=2',
    `/watch/tv/${'x'.repeat(121)}?season=1&episode=2`,
    '/watch/tv/verified-series-1399?season=2&episode=2',
    '/watch/tv/verified-series-1399?season=1&episode=3',
    '/watch/tv/verified-series-1399?season=1&episode=2&episode=2',
    '/watch/tv/verified-series-1399?season=1&episode=2&provider=private',
    '/watch/tv/verified-series-1399?season=1&episode=2#private',
    'javascript:alert(1)',
  ])('rejects a foreign, ambiguous, disallowed, or inconsistent target %s', (href) => {
    expect(parseEpisodeNavigation({ previous: null, next: { ...target(), href } }, origin)).toBeNull();
  });

  it('rejects mixed series paths instead of returning a partly valid response', () => {
    expect(parseEpisodeNavigation({ previous: target(1, 1), next: { ...target(1, 3), href: '/watch/tv/another-series-9?season=1&episode=3' } }, origin))
      .toBeNull();
  });
});
