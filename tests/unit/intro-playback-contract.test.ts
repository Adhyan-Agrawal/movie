import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  commerce: vi.fn(),
  fetch: vi.fn(),
  features: { supabaseConfigured: false },
}));

vi.mock('@/lib/env', () => ({ features: mocks.features }));
vi.mock('@/lib/providers/config', () => ({ listProviderConfigs: () => [] }));
vi.mock('@/lib/providers/registry', () => ({ resolvePlayback: mocks.resolve }));
vi.mock('@/features/commerce/queries', () => ({ getPlaybackCommerceContext: mocks.commerce }));

import { GET } from '@/app/api/playback/route';

const rawSource = {
  id: 'provider-private-id',
  label: 'Private provider',
  providerId: 'provider-secret',
  url: '/api/media/fixture',
  kind: 'hls' as const,
  consentRequired: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', mocks.fetch);
  mocks.resolve.mockResolvedValue({ source: rawSource, sources: [rawSource], attempted: ['provider-secret'], error: null });
  mocks.commerce.mockResolvedValue({
    ads: { enabled: false, firstBreakSeconds: 900, intervalSeconds: 900, maxBreaks: 3, allowSkip: true, skipAfterSeconds: 5 },
    entitlements: { resolved: false, adFree: false, maxProfiles: 1, status: 'unavailable' },
  });
});

afterEach(() => vi.unstubAllGlobals());

describe('/api/playback intro contract', () => {
  it('emits an absolute same-origin episode URL without contacting IntroDB on the source path', async () => {
    const response = await GET(new NextRequest(
      'https://app.example/api/playback?type=tv&imdbId=tt0944947&season=0&episode=1',
    ));
    const body = await response.json();
    expect(body.introCatalogUrl).toBe('https://app.example/api/intro?type=tv&imdbId=tt0944947&season=0&episode=1');
    expect(body.sources).toEqual([{
      id: 'server-1',
      label: 'Server 1',
      url: 'https://app.example/api/media/fixture',
      kind: 'hls',
      consentRequired: false,
    }]);
    expect(mocks.resolve).toHaveBeenCalledWith(expect.objectContaining({
      type: 'tv', imdbId: 'tt0944947', season: 0, episode: 1,
    }));
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('keeps playback resolution working and omits the optional URL when series IMDb is missing', async () => {
    const response = await GET(new NextRequest(
      'https://app.example/api/playback?type=tv&tmdbId=1399&season=1&episode=1',
    ));
    const body = await response.json();
    expect(body).not.toHaveProperty('introCatalogUrl');
    expect(body.sources).toHaveLength(1);
    expect(mocks.resolve).toHaveBeenCalledWith(expect.objectContaining({
      type: 'tv', tmdbId: '1399', season: 1, episode: 1,
    }));
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('accepts a valid catalog title id as the sole playback identity for hosted native sources', async () => {
    const titleId = '123e4567-e89b-42d3-a456-426614174000';
    const response = await GET(new NextRequest(
      `https://app.example/api/playback?type=movie&titleId=${titleId}`,
    ));
    expect(response.status).toBe(200);
    expect((await response.json()).sources).toHaveLength(1);
    expect(mocks.resolve).toHaveBeenCalledWith({ titleId, type: 'movie' });
  });

  it('rejects malformed catalog ids before playback or database resolution', async () => {
    for (const query of [
      'type=movie&titleId=not-a-uuid',
      'type=movie&tmdbId=1399&episodeId=not-a-uuid',
    ]) {
      const response = await GET(new NextRequest(`https://app.example/api/playback?${query}`));
      expect(response.status).toBe(400);
    }
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it('omits intro URLs for movies, invalid IMDb ids, and invalid TV episode coordinates', async () => {
    for (const query of [
      'type=movie&imdbId=tt0944947',
      'type=tv&tmdbId=1399&imdbId=bad&season=1&episode=1',
      'type=tv&imdbId=tt0944947&season=1&episode=0',
      'type=tv&imdbId=tt0944947&season=1000&episode=1',
    ]) {
      const body = await (await GET(new NextRequest(`https://app.example/api/playback?${query}`))).json();
      expect(body).not.toHaveProperty('introCatalogUrl');
      expect(body.sources).toHaveLength(1);
    }
  });
});
