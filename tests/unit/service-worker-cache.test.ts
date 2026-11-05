import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8');
const origin = 'https://app.example';
const cacheName = 'lumora-v2-static';
const asset = '/_next/static/chunks/app-12345678.js';
const js = (body = 'public bundle', headers: Record<string, string> = {}, status = 200) => new Response(body, {
  status, headers: { 'content-type': 'application/javascript', ...headers },
});

function worker() {
  const listeners = new Map<string, (event: unknown) => void>();
  const stored = new Map<string, Response>();
  const address = (request: Request | string) => new URL(typeof request === 'string' ? request : request.url, origin).href;
  const cache = {
    match: vi.fn(async (request: Request | string) => stored.get(address(request))?.clone()),
    put: vi.fn(async (request: Request | string, response: Response) => { stored.set(address(request), response.clone()); }),
    keys: vi.fn(async () => [...stored.keys()].map((url) => new Request(url))),
    delete: vi.fn(async (request: Request | string) => stored.delete(address(request))),
  };
  const caches = {
    open: vi.fn(async () => cache),
    keys: vi.fn(async () => ['lumora-v1-static', cacheName, 'unrelated-cache']),
    delete: vi.fn(async () => true),
  };
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => js());
  const self = { location: { origin }, addEventListener: (type: string, callback: (event: unknown) => void) => listeners.set(type, callback),
    skipWaiting: vi.fn(), clients: { claim: vi.fn() } };
  runInNewContext(source, { self, caches, fetch, URL, Request, Response });

  async function dispatch(type: string, request?: Request) {
    let response: Promise<Response> | undefined;
    const waiting: Promise<unknown>[] = [];
    listeners.get(type)!({ request, respondWith: (value: Promise<Response>) => { response = value; },
      waitUntil: (value: Promise<unknown>) => waiting.push(value) });
    const result = response ? await response : undefined;
    await Promise.all(waiting);
    return result;
  }
  const request = (path: string, init?: RequestInit) => new Request(new URL(path, origin), init);
  return { stored, cache, caches, fetch, self, dispatch, request, seed: (path: string, response = js()) => stored.set(address(path), response) };
}

describe('narrow service-worker static request reduction', () => {
  it('starts zero network promises on a real immutable cache hit', async () => {
    const subject = worker();
    subject.seed(asset);
    subject.fetch.mockImplementation(() => new Promise(() => {}));
    expect(await (await subject.dispatch('fetch', subject.request(asset)))?.text()).toBe('public bundle');
    expect(subject.fetch).not.toHaveBeenCalled();
    expect(subject.cache.put).not.toHaveBeenCalled();
  });

  it('fetches and caches a miss once, reuses hits, and fetches a new build URL independently', async () => {
    const subject = worker();
    await subject.dispatch('fetch', subject.request(asset));
    await subject.dispatch('fetch', subject.request(asset));
    await subject.dispatch('fetch', subject.request(asset));
    expect(subject.fetch).toHaveBeenCalledOnce();
    expect((subject.fetch.mock.calls[0][0] as Request).credentials).toBe('omit');
    await subject.dispatch('fetch', subject.request('/_next/static/chunks/app-87654321.js'));
    expect(subject.fetch).toHaveBeenCalledTimes(2);
    expect(subject.stored.size).toBe(2);
  });

  it('keeps unversioned art revalidation and invalidates only old Lumora static versions', async () => {
    const subject = worker();
    subject.seed('/logo.png', new Response('old art', { headers: { 'content-type': 'image/png' } }));
    subject.fetch.mockImplementation(async () => new Response('new art', { headers: { 'content-type': 'image/png' } }));
    expect(await (await subject.dispatch('fetch', subject.request('/logo.png')))?.text()).toBe('old art');
    expect(await subject.stored.get(`${origin}/logo.png`)?.text()).toBe('new art');
    expect(subject.fetch).toHaveBeenCalledOnce();
    await subject.dispatch('activate');
    expect(subject.caches.delete.mock.calls).toEqual([['lumora-v1-static']]);
    expect(subject.self.clients.claim).toHaveBeenCalledOnce();
  });

  it('revalidates unversioned development chunks but serves build-scoped manifests without a network promise', async () => {
    const subject = worker();
    const development = '/_next/static/chunks/app/page.js';
    subject.seed(development);
    await subject.dispatch('fetch', subject.request(development));
    expect(subject.fetch).toHaveBeenCalledOnce();
    const manifest = '/_next/static/publicBuildId/_buildManifest.js';
    subject.seed(manifest);
    await subject.dispatch('fetch', subject.request(manifest));
    expect(subject.fetch).toHaveBeenCalledOnce();
  });

  it.each([
    '/api/episode-navigation?type=tv&tmdbId=1399&season=1&episode=1', '/api', '/auth/callback', '/account/avatar.png',
    '/admin/logo.png', '/media/segment.ts', '/tickets/issue', '/party/state', '/watch-party/state',
    '/_next/static/media/stream.m3u8', '/_next/static/media/clip.mp4', '/icons/private.png',
    '/logo.png?ticket=private', '/logo.png?token=private', 'https://other.example/_next/static/chunks/app-12345678.js',
  ])('never intercepts or caches private, API, media, ticket or cross-origin request %s', async (path) => {
    const subject = worker();
    expect(await subject.dispatch('fetch', subject.request(path))).toBeUndefined();
    expect(subject.caches.open).not.toHaveBeenCalled();
    expect(subject.fetch).not.toHaveBeenCalled();
  });

  it.each([{ authorization: 'Bearer private' }, { cookie: 'account=private' }, { range: 'bytes=0-20' }])('bypasses credentialed/ranged static requests %j', async (headers) => {
    const subject = worker();
    expect(await subject.dispatch('fetch', subject.request(asset, { headers }))).toBeUndefined();
    expect(subject.caches.open).not.toHaveBeenCalled();
  });

  it.each([
    { 'set-cookie': 'account=private' }, { 'cache-control': 'private, max-age=60' }, { 'cache-control': 'no-store' },
    { vary: 'Cookie' }, { vary: 'Authorization' }, { vary: '*' }, { 'content-type': 'video/mp4' },
    { 'content-type': 'audio/aac' }, { 'content-type': 'text/html' }, { 'content-type': 'application/json' },
  ])('does not retain sensitive or non-static responses %j', async (headers) => {
    const subject = worker();
    subject.fetch.mockImplementation(async () => js('unsafe', headers));
    await subject.dispatch('fetch', subject.request(asset));
    await subject.dispatch('fetch', subject.request(asset));
    expect(subject.fetch).toHaveBeenCalledTimes(2);
    expect(subject.stored.size).toBe(0);
  });

  it.each([404, 503])('does not negative-cache an HTTP %s', async (status) => {
    const subject = worker();
    subject.fetch.mockImplementation(async () => js('unavailable', {}, status));
    await subject.dispatch('fetch', subject.request(asset));
    await subject.dispatch('fetch', subject.request(asset));
    expect(subject.fetch).toHaveBeenCalledTimes(2);
    expect(subject.stored.size).toBe(0);
  });

  it('caps the cache at 128 entries while preserving the offline shell and pinned icons', async () => {
    const subject = worker();
    for (const path of ['/offline', '/icons/icon-192.png', '/icons/icon-512.png']) subject.seed(path);
    for (let number = 0; number < 127; number++) subject.seed(`/_next/static/chunks/${number}-12345678.js`);
    await subject.dispatch('fetch', subject.request(asset));
    expect(subject.stored.size).toBe(128);
    for (const path of ['/offline', '/icons/icon-192.png', '/icons/icon-512.png']) expect(subject.stored.has(`${origin}${path}`)).toBe(true);
  });

  it('precaches anonymously and preserves offline navigation without storing visited pages', async () => {
    const subject = worker();
    subject.fetch.mockImplementation(async (input) => new Response(String(input), { headers: { 'content-type': String(input) === '/offline' ? 'text/html' : 'image/png' } }));
    await subject.dispatch('install');
    expect(subject.stored.size).toBe(3);
    for (const [, init] of subject.fetch.mock.calls) expect(init?.credentials).toBe('omit');
    subject.fetch.mockRejectedValue(new Error('offline'));
    const navigate = { url: `${origin}/browse`, method: 'GET', mode: 'navigate', headers: new Headers() } as Request;
    expect(await (await subject.dispatch('fetch', navigate))?.text()).toBe('/offline');
    expect(subject.stored.has(`${origin}/browse`)).toBe(false);
  });
});
