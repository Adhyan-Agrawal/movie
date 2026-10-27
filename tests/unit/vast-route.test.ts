import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  context: { entitlements: { resolved: true, adFree: false }, ads: { enabled: true } },
  config: { enabled: true, tagUrl: 'https://ads.example.com/tag', allowedHosts: ['ads.example.com'] },
  lookup: vi.fn(), fetch: vi.fn(),
}));
vi.mock('@/features/commerce/queries', () => ({ getPlaybackCommerceContext: async () => mocks.context, getVastConfiguration: async () => mocks.config }));
vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }));
import { GET } from '@/app/api/vast/route';

const INLINE = '<VAST><Ad id="fixture"><InLine><Impression>https://ads.example.com/impression</Impression><Creatives><Creative><Linear skipoffset="00:00:05"><Duration>00:00:10</Duration><MediaFiles><MediaFile type="video/mp4">https://ads.example.com/ad.mp4</MediaFile></MediaFiles></Linear></Creative></Creatives></InLine></Ad></VAST>';
const request = (consent = true) => new NextRequest(`https://app.example/api/vast${consent ? '?consent=1' : ''}`);

beforeEach(() => {
  mocks.context = { entitlements: { resolved: true, adFree: false }, ads: { enabled: true } };
  mocks.config = { enabled: true, tagUrl: 'https://ads.example.com/tag', allowedHosts: ['ads.example.com'] };
  mocks.lookup.mockReset().mockResolvedValue([{ address: '203.0.113.10', family: 4 }]);
  mocks.fetch.mockReset().mockImplementation(async () => new Response(INLINE));
  vi.stubGlobal('fetch', mocks.fetch);
});

describe('permission and consent-aware VAST delivery', () => {
  it('never requests third-party ads without consent or for ad-free/unresolved viewers', async () => {
    expect((await GET(request(false))).status).toBe(204);
    mocks.context.entitlements.adFree = true;
    expect((await GET(request())).status).toBe(204);
    mocks.context.entitlements.adFree = false;
    mocks.context.entitlements.resolved = false;
    expect((await GET(request())).status).toBe(204);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('returns normalized playable media without exposing the configured tag', async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.creative).toMatchObject({ mediaUrl: 'https://ads.example.com/ad.mp4', durationSeconds: 10, skipAfterSeconds: 5 });
    expect(JSON.stringify(body)).not.toContain('/tag');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });

  it('rejects private DNS answers and oversized XML without stalling playback', async () => {
    mocks.lookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    expect((await GET(request())).status).toBe(204);
    expect(mocks.fetch).not.toHaveBeenCalled();
    mocks.lookup.mockResolvedValue([{ address: '203.0.113.10', family: 4 }]);
    mocks.fetch.mockImplementation(async () => new Response('a'.repeat(256 * 1024 + 1)));
    expect((await GET(request())).status).toBe(204);
  });

  it('limits wrapper cycles and preserves supported wrapper impressions', async () => {
    mocks.fetch.mockImplementation(async (url: string) => new Response(url.endsWith('/tag')
      ? '<VAST><Ad><Wrapper><VASTAdTagURI>https://ads.example.com/next</VASTAdTagURI><Impression>https://ads.example.com/wrapper</Impression></Wrapper></Ad></VAST>' : INLINE));
    const body = await (await GET(request())).json();
    expect(body.creative.tracking.impression).toEqual(['https://ads.example.com/wrapper', 'https://ads.example.com/impression']);
    mocks.fetch.mockImplementation(async () => new Response('<VAST><Ad><Wrapper><VASTAdTagURI>https://ads.example.com/tag</VASTAdTagURI></Wrapper></Ad></VAST>'));
    expect((await GET(request())).status).toBe(204);
  });
});
