import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { isValidElement, type ReactNode } from 'react';
import type { Title } from '@/features/catalog/types';

const mocks = vi.hoisted(() => ({
  features: { tmdbConfigured: true, supabaseConfigured: false },
  title: vi.fn(), seasons: vi.fn(), show: vi.fn(), season: vi.fn(), resolve: vi.fn(), commerce: vi.fn(),
  native: vi.fn(), progress: vi.fn(), auth: vi.fn(), cookies: vi.fn(), fetch: vi.fn(),
  shell: () => null,
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/env', () => ({ features: mocks.features }));
vi.mock('@/features/catalog/queries', () => ({ getTitleBySlug: mocks.title, listSeasonsForTitle: mocks.seasons }));
vi.mock('@/features/catalog/tmdb-catalog', () => ({ getTmdbShowMetadata: mocks.show, getTmdbSeasonMetadata: mocks.season }));
vi.mock('@/lib/providers/config', () => ({ listProviderConfigs: () => [], getProviderConfig: () => undefined }));
vi.mock('@/lib/providers/registry', () => ({ resolvePlayback: mocks.resolve, getActiveProviderConfigs: () => [] }));
vi.mock('@/features/commerce/queries', () => ({ getPlaybackCommerceContext: mocks.commerce }));
vi.mock('@/features/playback/native-sources', () => ({ resolveNativeSources: mocks.native, findEpisodeId: mocks.native }));
vi.mock('@/features/playback/progress-queries', () => ({ getPlaybackContext: mocks.progress }));
vi.mock('@/lib/supabase/server', () => ({ getSupabaseServerClient: mocks.auth }));
vi.mock('next/headers', () => ({ cookies: mocks.cookies }));
vi.mock('@/features/player/PlayerShell', () => ({ PlayerShell: mocks.shell }));
vi.mock('@/features/ads/AdSlot', () => ({ AdSlot: () => null }));
vi.mock('@/features/ads/ConsentGate', () => ({ ConsentGate: () => null }));

import { GET } from '@/app/api/playback/route';
import WatchPage from '@/app/watch/[type]/[slug]/page';

const title: Title = { id: 'tmdb:tv:1399', type: 'tv', slug: 'verified-series-1399', name: 'Verified Series', synopsis: '', releaseYear: 2020, maturity: 'TV-14', genres: [], tmdbId: '1399' };
const source = { id: 'private', label: 'PRIVATE provider', providerId: 'private-provider', kind: 'hls', url: '/api/media/fixture', consentRequired: false };

function shellProps(node: ReactNode): Record<string, unknown> | undefined {
  if (Array.isArray(node)) {
    for (const item of node) { const props = shellProps(item); if (props) return props; }
  } else if (isValidElement<{ children?: ReactNode }>(node)) {
    if (node.type === mocks.shell) return node.props as Record<string, unknown>;
    return shellProps(node.props.children);
  }
  return undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', mocks.fetch);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  mocks.features.supabaseConfigured = false;
  mocks.features.tmdbConfigured = true;
  mocks.title.mockResolvedValue(title);
  mocks.seasons.mockResolvedValue([]);
  mocks.resolve.mockResolvedValue({ source, sources: [source], attempted: ['private-provider'], error: null });
  mocks.commerce.mockResolvedValue({
    ads: { enabled: false, firstBreakSeconds: 900, intervalSeconds: 900, maxBreaks: 3, allowSkip: true, skipAfterSeconds: 5 },
    entitlements: { resolved: false, adFree: false, maxProfiles: 1, status: 'unavailable' },
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('nonblocking optional episode navigation forwarding', () => {
  it('forwards an absolute same-origin lazy URL in the Android playback response with no navigation network work', async () => {
    const response = await GET(new NextRequest('https://app.example/api/playback?type=tv&tmdbId=1399&season=0&episode=1'));
    const body = await response.json();
    expect(body.episodeNavigationUrl).toBe('https://app.example/api/episode-navigation?type=tv&tmdbId=1399&season=0&episode=1');
    expect(body.sources).toEqual([{ id: 'server-1', label: 'Server 1', kind: 'hls', url: 'https://app.example/api/media/fixture', consentRequired: false }]);
    for (const spy of [mocks.show, mocks.season, mocks.seasons, mocks.native, mocks.progress, mocks.auth, mocks.cookies, mocks.fetch]) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it.each([
    'type=movie&tmdbId=1399',
    'type=tv&imdbId=tt0944947&season=1&episode=1',
    'type=tv&tmdbId=bad&season=1&episode=1',
    'type=tv&tmdbId=1399&season=1&episode=0',
    'type=tv&tmdbId=1399&season=1000&episode=1',
    'type=tv&tmdbId=1399&season=01&episode=1',
    'type=tv&tmdbId=1399&season=1&episode=1&episode=2',
  ])('does not fabricate a navigation URL for movies or ambiguous identity %s', async (query) => {
    const body = await (await GET(new NextRequest(`https://app.example/api/playback?${query}`))).json();
    expect(body).not.toHaveProperty('episodeNavigationUrl');
    expect(body.sources).toHaveLength(1);
    expect(mocks.show).not.toHaveBeenCalled();
    expect(mocks.season).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('passes a relative web URL from the title own IDs without querying optional metadata on the source path', async () => {
    const props = shellProps(await WatchPage({ params: Promise.resolve({ type: 'tv', slug: title.slug }), searchParams: Promise.resolve({ season: '1', episode: '1' }) }));
    expect(props?.episodeNavigationUrl).toBe('/api/episode-navigation?type=tv&tmdbId=1399&season=1&episode=1');
    expect(props).not.toHaveProperty('nextEpisode');
    expect(props?.source).toMatchObject({ id: 'server-1', kind: 'hls' });
    for (const spy of [mocks.show, mocks.season, mocks.seasons, mocks.native, mocks.progress, mocks.auth, mocks.cookies, mocks.fetch]) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it('omits web navigation for a movie, missing own TMDB ID, or duplicate episode coordinates', async () => {
    for (const [item, searchParams] of [
      [{ ...title, type: 'movie' as const }, {}],
      [{ ...title, tmdbId: undefined }, { season: '1', episode: '1' }],
      [title, { season: '1', episode: ['1', '2'] }],
    ] as const) {
      mocks.title.mockResolvedValue(item);
      const props = shellProps(await WatchPage({ params: Promise.resolve({ type: item.type, slug: item.slug }), searchParams: Promise.resolve(searchParams as { season?: string; episode?: string | string[] }) }));
      expect(props).not.toHaveProperty('episodeNavigationUrl');
    }
    expect(mocks.show).not.toHaveBeenCalled();
    expect(mocks.season).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});

describe('watch-page nonsecret release flags', () => {
  it.each([true, false])('forwards validated configured=%s independently of source kind and account availability', async (configured) => {
    const secret = 'fixture-only-watch-party-secret-32-characters';
    vi.stubEnv('WATCH_PARTY_SECRET', configured ? secret : '');
    vi.stubEnv('WATCH_PARTY_WORKER_URL', configured ? 'https://party.example' : '');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.example');
    mocks.title.mockResolvedValue({ ...title, type: 'movie' });
    mocks.native.mockResolvedValue([]);
    for (const reportingAvailable of [false, true]) {
      mocks.features.supabaseConfigured = reportingAvailable;
      mocks.progress.mockResolvedValue({ viewerKey: 'account:viewer', resumePosition: null });
      for (const kind of ['hls', 'embed', null]) {
        const current = kind ? { ...source, kind } : null;
        mocks.resolve.mockResolvedValue({ source: current, sources: current ? [current] : [], error: null });
        const props = shellProps(await WatchPage({ params: Promise.resolve({ type: 'movie', slug: title.slug }), searchParams: Promise.resolve({}) }));
        expect(props?.watchPartyConfigured).toBe(configured);
        // Virtual catalog IDs have no persistence row even when account services exist.
        expect(props?.reportingAvailable).toBe(false);
        expect(props?.watchPartyMedia).toBeNull();
        expect(props).not.toHaveProperty('websocketUrl'); expect(props).not.toHaveProperty('secret');
        expect(JSON.stringify(props)).not.toContain(secret); expect(JSON.stringify(props)).not.toContain('party.example');
      }
    }
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each([false, true])('only enables reporting for stored catalog IDs with backend availability=%s', async (available) => {
    mocks.features.supabaseConfigured = available;
    mocks.title.mockResolvedValue({ ...title, id: '123e4567-e89b-42d3-a456-426614174000', type: 'movie' });
    mocks.native.mockResolvedValue([]);
    mocks.progress.mockResolvedValue({ viewerKey: 'account:viewer', resumePosition: null });
    const props = shellProps(await WatchPage({ params: Promise.resolve({ type: 'movie', slug: title.slug }), searchParams: Promise.resolve({}) }));
    expect(props?.reportingAvailable).toBe(available);
  });
});
