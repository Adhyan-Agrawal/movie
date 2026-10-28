import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LookupFunction } from 'node:net';
import { NextRequest } from 'next/server';
import { DEFAULT_VAST_CONFIGURATION } from '@/features/commerce/types';

const mocks = vi.hoisted(() => ({
  context: { entitlements: { resolved: true, adFree: false }, ads: { enabled: true } },
  config: { enabled: true, tagUrl: 'https://ads.example.com/tag', allowedHosts: ['ads.example.com'],
    firstBreakSeconds: 900, intervalSeconds: 900, maxBreaks: 3, allowSkip: true, skipAfterSeconds: 5 },
  lookup: vi.fn(), fetch: vi.fn(), contextRead: vi.fn(), configRead: vi.fn(), destroyed: vi.fn(),
  connections: [] as Array<{ connect: { lookup: LookupFunction } }>,
}));
vi.mock('@/features/commerce/queries', () => ({ getPlaybackCommerceContext: mocks.contextRead, getVastConfiguration: mocks.configRead }));
vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }));
vi.mock('undici', () => ({ fetch: mocks.fetch, Agent: class {
  constructor(options: { connect: { lookup: LookupFunction } }) { mocks.connections.push(options); }
  destroy() { mocks.destroyed(); return Promise.resolve(); }
} }));
import { GET } from '@/app/api/vast/route';

const INLINE = '<VAST version="4.2"><Ad id="fixture"><InLine><Impression>https://ads.example.com/impression</Impression><Creatives><Creative><Linear skipoffset="00:00:05"><Duration>00:00:10</Duration><MediaFiles><MediaFile type="video/mp4">https://ads.example.com/ad.mp4</MediaFile></MediaFiles></Linear></Creative></Creatives></InLine></Ad></VAST>';
const request = (consent = true) => new NextRequest(`https://app.example/api/vast${consent ? '?consent=1' : ''}`);
const wrapper = (target: string) => `<VAST version="4.2"><Ad><Wrapper><VASTAdTagURI>${target}</VASTAdTagURI><Impression>https://ads.example.com/wrapper</Impression></Wrapper></Ad></VAST>`;

beforeEach(() => {
  mocks.context = { entitlements: { resolved: true, adFree: false }, ads: { enabled: true } };
  mocks.config = { ...DEFAULT_VAST_CONFIGURATION, enabled: true, tagUrl: 'https://ads.example.com/tag', allowedHosts: ['ads.example.com'] };
  mocks.contextRead.mockReset().mockImplementation(async () => mocks.context);
  mocks.configRead.mockReset().mockImplementation(async () => mocks.config);
  mocks.lookup.mockReset().mockResolvedValue([{ address: '93.184.215.14', family: 4 }]);
  mocks.fetch.mockReset().mockImplementation(async () => new Response(INLINE));
  mocks.destroyed.mockReset(); mocks.connections.length = 0;
});
afterEach(() => { vi.useRealTimers(); });

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
    mocks.lookup.mockResolvedValue([{ address: '93.184.215.14', family: 4 }]);
    mocks.fetch.mockImplementation(async () => new Response('a'.repeat(256 * 1024 + 1)));
    expect((await GET(request())).status).toBe(204);
  });

  it('limits wrapper cycles and preserves supported wrapper impressions', async () => {
    mocks.fetch.mockImplementation(async (url: string) => new Response(url.endsWith('/tag')
      ? wrapper('https://ads.example.com/next') : INLINE));
    const body = await (await GET(request())).json();
    expect(body.creative.tracking.impression).toEqual(['https://ads.example.com/wrapper', 'https://ads.example.com/impression']);
    mocks.fetch.mockImplementation(async () => new Response(wrapper('https://ads.example.com/tag')));
    expect((await GET(request())).status).toBe(204);
  });

  it('forwards the actual cookie or Android bearer request to account validation', async () => {
    const bearer = new NextRequest('https://app.example/api/vast?consent=1', { headers: { authorization: 'Bearer invalid-account-token' } });
    mocks.contextRead.mockImplementation(async (input: Request) => {
      expect(input).toBe(bearer);
      throw new Error('Invalid bearer');
    });
    expect((await GET(bearer)).status).toBe(204);
    expect(mocks.fetch).not.toHaveBeenCalled();
    const cookie = new NextRequest('https://app.example/api/vast?consent=1', { headers: { cookie: 'account-cookie=fixture' } });
    mocks.contextRead.mockResolvedValue(mocks.context);
    expect((await GET(cookie)).status).toBe(200);
    expect(mocks.contextRead).toHaveBeenLastCalledWith(cookie);
  });

  it('denies disabled policies, missing configuration and malformed consent before network I/O', async () => {
    for (const query of ['', '?consent=true', '?consent=0', '?consent=1&consent=0']) {
      expect((await GET(new NextRequest(`https://app.example/api/vast${query}`))).status).toBe(204);
    }
    expect(mocks.contextRead).not.toHaveBeenCalled();
    mocks.context.ads.enabled = false;
    expect((await GET(request())).status).toBe(204);
    mocks.context.ads.enabled = true;
    mocks.config.enabled = false;
    expect((await GET(request())).status).toBe(204);
    mocks.config.enabled = true; mocks.config.tagUrl = '';
    expect((await GET(request())).status).toBe(204);
    expect(mocks.lookup).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each(['127.0.0.1', '10.1.2.3', '100.64.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1',
    '224.0.0.1', '198.18.0.1', '::1', 'fe80::1', 'ff02::1', '::ffff:7f00:1', '2001:db8::1', '2001:0db8::1'])('denies non-public DNS answer %s', async (address) => {
    mocks.lookup.mockResolvedValue([{ address, family: address.includes(':') ? 6 : 4 }]);
    expect((await GET(request())).status).toBe(204);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('pins all validated DNS answers in the HTTPS connection and never forwards viewer credentials', async () => {
    const addresses = [{ address: '93.184.215.14', family: 4 }, { address: '2001:4860:4860::8888', family: 6 }];
    mocks.lookup.mockResolvedValue(addresses);
    expect((await GET(request())).status).toBe(200);
    const callback = vi.fn();
    mocks.connections[0]!.connect.lookup('ads.example.com', { all: true }, callback);
    expect(callback).toHaveBeenCalledWith(null, addresses);
    expect(mocks.lookup).toHaveBeenCalledTimes(1);
    const init = mocks.fetch.mock.calls[0]![1] as { headers: Record<string, string>; redirect: string };
    expect(init.redirect).toBe('manual');
    expect(init.headers).toEqual({ Accept: 'application/xml,text/xml', 'Accept-Encoding': 'identity' });
    expect(mocks.destroyed).toHaveBeenCalledTimes(1);
  });

  it('rejects mixed public/private DNS answers', async () => {
    mocks.lookup.mockResolvedValue([{ address: '93.184.215.14', family: 4 }, { address: '127.0.0.1', family: 4 }]);
    expect((await GET(request())).status).toBe(204);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('validates every redirect and stops credentialed/private/off-allowlist redirects', async () => {
    for (const location of ['https://localhost/internal', 'http://ads.example.com/next', 'https://evil.example/next',
      'https://user:password@ads.example.com/next', 'https://ads.example.com:444/next']) {
      mocks.fetch.mockClear().mockResolvedValue(new Response(null, { status: 302, headers: { location } }));
      expect((await GET(request())).status).toBe(204);
      expect(mocks.fetch).toHaveBeenCalledTimes(1);
    }
  });

  it('accepts an allowed relative redirect and rechecks DNS on the next hop', async () => {
    mocks.fetch.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: '/next' } }));
    expect((await GET(request())).status).toBe(200);
    expect(mocks.lookup).toHaveBeenCalledTimes(2);
    expect(mocks.fetch.mock.calls[1]![0]).toBe('https://ads.example.com/next');
  });

  it('caps wrappers at three and rejects redirect loops', async () => {
    mocks.fetch.mockImplementation(async (url: string) => new Response(wrapper(`${url}/next`)));
    expect((await GET(request())).status).toBe(204);
    expect(mocks.fetch).toHaveBeenCalledTimes(4);
    mocks.fetch.mockClear().mockResolvedValue(new Response(null, { status: 302, headers: { location: '/tag' } }));
    expect((await GET(request())).status).toBe(204);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it('merges wrapper click tracking and bounds aggregate XML bytes across the wrapper chain', async () => {
    const clicks = '<Creatives><Creative><Linear><VideoClicks><ClickTracking>https://ads.example.com/click</ClickTracking></VideoClicks></Linear></Creative></Creatives>';
    mocks.fetch.mockResolvedValueOnce(new Response(wrapper('https://ads.example.com/next').replace('</Wrapper>', clicks + '</Wrapper>')));
    const body = await (await GET(request())).json();
    expect(body.creative.clickTracking).toEqual(['https://ads.example.com/click']);
    const padding = '<!--' + 'a'.repeat(150 * 1024) + '-->';
    mocks.fetch.mockClear().mockResolvedValueOnce(new Response(padding + wrapper('https://ads.example.com/next')))
      .mockResolvedValueOnce(new Response(padding + INLINE));
    expect((await GET(request())).status).toBe(204);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it('does not accept browser cross-site opt-in or pre-aborted requests', async () => {
    const crossSite = new NextRequest('https://app.example/api/vast?consent=1', { headers: { 'sec-fetch-site': 'cross-site' } });
    expect((await GET(crossSite)).status).toBe(204);
    const controller = new AbortController(); controller.abort();
    expect((await GET(new NextRequest('https://app.example/api/vast?consent=1', { signal: controller.signal }))).status).toBe(204);
    expect(mocks.contextRead).not.toHaveBeenCalled(); expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('rejects partial XML, non-OK upstream errors, DTD, empty and malformed responses', async () => {
    for (const response of [new Response(INLINE, { status: 206 }), new Response(INLINE, { headers: { 'content-range': 'bytes 0-99/1000' } }),
      new Response('error', { status: 503 }), new Response('<!DOCTYPE VAST>' + INLINE), new Response('<VAST>'), new Response('')]) {
      mocks.fetch.mockResolvedValue(response);
      expect((await GET(request())).status).toBe(204);
    }
  });

  it('fails closed on configuration read failures and invalid host configuration', async () => {
    mocks.configRead.mockRejectedValueOnce(new Error('Provider private secret'));
    const response = await GET(request());
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    mocks.config.tagUrl = 'https://127.0.0.1/tag';
    expect((await GET(request())).status).toBe(204);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('applies the server skip policy and prevents configured tag reflection in media', async () => {
    mocks.config.allowSkip = false;
    expect((await (await GET(request())).json()).creative.skipAfterSeconds).toBeNull();
    mocks.config.allowSkip = true; mocks.config.skipAfterSeconds = 7;
    expect((await (await GET(request())).json()).creative.skipAfterSeconds).toBe(7);
    mocks.fetch.mockResolvedValue(new Response(INLINE.replace('/ad.mp4', '/tag')));
    expect((await GET(request())).status).toBe(204);
  });

  it('enforces one shared five-second deadline even while DNS or XML body stalls', async () => {
    vi.useFakeTimers();
    mocks.lookup.mockImplementationOnce(() => new Promise(() => {}));
    const dnsPending = GET(request());
    await vi.advanceTimersByTimeAsync(5001);
    expect((await dnsPending).status).toBe(204);
    expect(mocks.fetch).not.toHaveBeenCalled();
    mocks.fetch.mockResolvedValue(new Response(new ReadableStream({ start() {} })));
    const bodyPending = GET(request());
    await vi.advanceTimersByTimeAsync(5001);
    expect((await bodyPending).status).toBe(204);
    expect(mocks.destroyed).toHaveBeenCalled();
  });

  it('aborts a pending resolution when the client disconnects', async () => {
    const controller = new AbortController();
    mocks.lookup.mockImplementation(() => new Promise(() => {}));
    const result = GET(new NextRequest('https://app.example/api/vast?consent=1', { signal: controller.signal }));
    await Promise.resolve(); await Promise.resolve();
    controller.abort();
    expect((await result).status).toBe(204);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
