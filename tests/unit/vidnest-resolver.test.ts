import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createVidnestResolver } from '@/features/vidnest/resolver';

const SECRET = 'vidnest-resolver-test-secret-at-least-32-characters';
const FIRST_KEY = 'vidnest-app-key-first-001';
const SECOND_KEY = 'vidnest-app-key-second-002';

function json(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
}

function keyPage(): Response {
  return new Response('<script src="/_next/static/chunks/player123.js"></script>');
}

function keyBundle(key: string): Response {
  return new Response(`const appKey="${key}",api="https://new.vidnest.fun";`);
}

function oversizedResponse(byteLength: number, headers?: HeadersInit) {
  const cancel = vi.fn();
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(byteLength).fill(120)); },
    cancel,
  }), { headers });
  return { cancel, response };
}

async function sealedReply(payload: unknown, nonce: string, appKey: string) {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${nonce}|${appKey}`),
  );
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    digest,
    { name: 'AES-GCM' },
    false,
    ['encrypt'],
  );
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(JSON.stringify(payload)),
  ));
  const sealed = new Uint8Array(iv.byteLength + encrypted.byteLength);
  sealed.set(iv);
  sealed.set(encrypted, iv.byteLength);
  return { d: Buffer.from(sealed).toString('base64url'), n: nonce, v: 2 };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('embedded VidNest resolver', () => {
  it('publishes only the authenticated first-provider prefix and retains the complete provider order', async () => {
    let releaseTail!: () => void;
    const tail = new Promise<void>((resolve) => { releaseTail = resolve; });
    let publish!: (streams: unknown) => void;
    const primary = new Promise<unknown>((resolve) => { publish = resolve; });
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname === 'new.vidnest.fun') {
        const first = url.pathname.startsWith('/primary/');
        if (!first) await tail;
        return json(await sealedReply({ streams: first ? [
          { url: 'https://media.example.com/first.m3u8' },
          { url: 'https://media.example.com/second.m3u8' },
        ] : [{ url: 'https://media.example.com/third.m3u8' }] }, url.searchParams.get('_n')!, FIRST_KEY));
      }
      return url.pathname.endsWith('.js') ? keyBundle(FIRST_KEY) : keyPage();
    });
    const resolver = createVidnestResolver({ fetchImpl, servers: ['primary', 'secondary'] });
    let complete = false;
    const resolution = resolver({ tmdbId: '550', onPrimary: publish }).then((result) => { complete = true; return result; });
    const prefix = await primary;
    expect(complete).toBe(false);
    releaseTail();
    const result = await resolution;
    expect(result.streams.slice(0, 2)).toEqual(prefix);
    expect(result.streams.map((stream) => stream.url)).toEqual([
      'https://media.example.com/first.m3u8', 'https://media.example.com/second.m3u8', 'https://media.example.com/third.m3u8',
    ]);
  });

  it('excludes known broken providers from the default bounded fan-out', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(null, { status: 502 }));
    const resolver = createVidnestResolver({ fetchImpl });

    await expect(resolver({ tmdbId: '550' })).resolves.toEqual({ provider: 'vidnest', streams: [] });

    const providers = fetchImpl.mock.calls.map(([input]) => new URL(String(input)).pathname.split('/')[1]);
    expect(providers).toEqual([
      'nextgencloudfabric',
      'hollymoviehd',
      'klikxxi',
      'rpmvid',
      'allmovies',
      'flixhq',
    ]);
    expect(providers).not.toEqual(expect.arrayContaining(['onehd', 'yflix', 'rogflix']));
  });

  it('fans out in parallel, isolates an upstream failure, and returns normalized streams', async () => {
    let pageRequests = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.redirect === 'error') throw new TypeError('Unsupported redirect mode: error');
      expect(init?.redirect).toBe('manual');
      const url = new URL(String(input));
      if (url.hostname === 'new.vidnest.fun') {
        expect(new Headers(init?.headers).get('origin')).toBe('https://vidnest.fun');
        const server = url.pathname.split('/')[1];
        if (server === 'broken') throw new Error('one provider is unavailable');
        if (server === 'empty') return new Response(null, { status: 502 });
        const nonce = url.searchParams.get('_n')!;
        return json(await sealedReply({ sources: [
          {
            file: 'https://media.example.com/a.m3u8',
            type: 'hls',
            headers: { Referer: 'https://player.example.com/watch', Origin: 'http://unsafe.example.com' },
          },
          {
            url: 'https://media.example.com/b.mp4',
            type: 'mp4',
            headers: { origin: 'https://player.example.com' },
          },
          { url: '/relative/unplayable.m3u8' },
        ] }, nonce, FIRST_KEY));
      }
      if (url.pathname.startsWith('/movie/')) {
        pageRequests += 1;
        return keyPage();
      }
      if (url.pathname.endsWith('/player123.js')) return keyBundle(FIRST_KEY);
      throw new Error(`Unexpected request: ${url.href}`);
    });
    const resolver = createVidnestResolver({ fetchImpl, servers: ['broken', 'working', 'empty'] });

    const result = await resolver({ tmdbId: '550', mediaType: 'movie' });

    expect(result).toEqual({
      provider: 'vidnest',
      streams: [
        {
          url: 'https://media.example.com/a.m3u8',
          type: 'hls',
          headers: { referer: 'https://player.example.com/watch' },
        },
        {
          url: 'https://media.example.com/b.mp4',
          type: 'mp4',
          headers: { origin: 'https://player.example.com/' },
        },
      ],
    });
    expect(fetchImpl.mock.calls.filter(([input]) => new URL(String(input)).hostname === 'new.vidnest.fun')).toHaveLength(3);
    expect(pageRequests).toBe(1);
  });

  it('rejects private, credentialed, non-public, and overlong stream URLs and headers', async () => {
    const overlongUrl = `https://media.example.com/${'x'.repeat(4_096)}`;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname === 'new.vidnest.fun') {
        const nonce = url.searchParams.get('_n')!;
        return json(await sealedReply({ streams: [
          {
            url: 'https://media.example.com/valid.m3u8',
            type: ' hls ',
            headers: {
              Referer: 'https://viewer.example.com/watch',
              Origin: 'https://127.0.0.1/private',
            },
          },
          { url: 'https://user:password@media.example.com/credentialed.m3u8' },
          { url: 'https://127.0.0.1/private.m3u8' },
          { url: 'https://[::1]/private.m3u8' },
          { url: 'https://8.8.8.8/literal-ip.m3u8' },
          { url: 'https://resolver.internal/private.m3u8' },
          { url: 'https://intranet/private.m3u8' },
          { url: 'http://media.example.com/insecure.m3u8' },
          { url: overlongUrl },
        ] }, nonce, FIRST_KEY));
      }
      if (url.pathname.startsWith('/movie/')) return keyPage();
      if (url.pathname.endsWith('/player123.js')) return keyBundle(FIRST_KEY);
      throw new Error(`Unexpected request: ${url.href}`);
    });
    const resolver = createVidnestResolver({ fetchImpl, servers: ['working'] });

    await expect(resolver({ tmdbId: '550' })).resolves.toEqual({
      provider: 'vidnest',
      streams: [{
        url: 'https://media.example.com/valid.m3u8',
        type: 'hls',
        headers: { referer: 'https://viewer.example.com/watch' },
      }],
    });
  });

  it('caps the combined provider result and nulls unsafe stream type metadata', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname === 'new.vidnest.fun') {
        const provider = url.pathname.split('/')[1];
        const nonce = url.searchParams.get('_n')!;
        const streams = Array.from({ length: 40 }, (_value, index) => ({
          url: `https://media.example.com/${provider}/${index}.m3u8`,
          type: index === 0 ? ' hls '
            : index === 1 ? 'x'.repeat(129)
              : index === 2 ? 'video/mp4\r\nInjected: value'
                : index === 3 ? 42 : undefined,
        }));
        return json(await sealedReply({ streams }, nonce, FIRST_KEY));
      }
      if (url.pathname.startsWith('/movie/')) return keyPage();
      if (url.pathname.endsWith('/player123.js')) return keyBundle(FIRST_KEY);
      throw new Error(`Unexpected request: ${url.href}`);
    });
    const resolver = createVidnestResolver({ fetchImpl, servers: ['first', 'second'] });

    const result = await resolver({ tmdbId: '550' });

    expect(result.streams).toHaveLength(32);
    expect(result.streams.every((stream) => stream.url.includes('/first/'))).toBe(true);
    expect(result.streams.slice(0, 4).map((stream) => stream.type)).toEqual(['hls', null, null, null]);
  });

  it('bounds providers that ignore abort and also honors caller aborts', async () => {
    vi.useFakeTimers();
    let timeoutSignal: AbortSignal | undefined;
    const timedResolver = createVidnestResolver({
      servers: ['stalled'],
      serverTimeoutMs: 50,
      keyLookupTimeoutMs: 50,
      fetchImpl: async (_input, init) => {
        timeoutSignal = init?.signal as AbortSignal;
        return new Promise<Response>(() => undefined);
      },
    });
    const timed = timedResolver({ tmdbId: '550' });
    await vi.advanceTimersByTimeAsync(51);
    await expect(timed).resolves.toEqual({ provider: 'vidnest', streams: [] });
    expect(timeoutSignal?.aborted).toBe(true);

    let callerSignal: AbortSignal | undefined;
    const callerResolver = createVidnestResolver({
      servers: ['stalled'],
      serverTimeoutMs: 5_000,
      fetchImpl: async (_input, init) => {
        callerSignal = init?.signal as AbortSignal;
        return new Promise<Response>(() => undefined);
      },
    });
    const controller = new AbortController();
    const aborted = callerResolver({ tmdbId: '550', signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    await expect(aborted).resolves.toEqual({ provider: 'vidnest', streams: [] });
    expect(callerSignal?.aborted).toBe(true);
  });

  it('isolates in-flight key discovery by request context when one caller aborts', async () => {
    let releasePage!: () => void;
    let markPageStarted!: () => void;
    const pageGate = new Promise<void>((resolve) => { releasePage = resolve; });
    const pageStarted = new Promise<void>((resolve) => { markPageStarted = resolve; });
    let pageRequests = 0;
    const pageSignals: AbortSignal[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname === 'new.vidnest.fun') {
        const nonce = url.searchParams.get('_n')!;
        return json(await sealedReply({
          url: 'https://media.example.com/shared.m3u8',
          headers: {},
        }, nonce, FIRST_KEY));
      }
      if (url.pathname === '/movie/550') {
        pageRequests += 1;
        pageSignals.push(init?.signal as AbortSignal);
        markPageStarted();
        await pageGate;
        return keyPage();
      }
      if (url.pathname.endsWith('/player123.js')) return keyBundle(FIRST_KEY);
      if (url.pathname === '/movie/324857') return new Response(null, { status: 404 });
      throw new Error(`Unexpected request: ${url.href}`);
    });
    const resolver = createVidnestResolver({
      fetchImpl,
      servers: ['working'],
      serverTimeoutMs: 5_000,
      keyLookupTimeoutMs: 5_000,
    });
    const firstController = new AbortController();
    const first = resolver({ tmdbId: '550', signal: firstController.signal });
    await pageStarted;
    const second = resolver({ tmdbId: '550' });
    await vi.waitFor(() => {
      expect(fetchImpl.mock.calls.filter(([input]) =>
        new URL(String(input)).hostname === 'new.vidnest.fun')).toHaveLength(2);
    });

    firstController.abort();
    releasePage();

    await expect(first).resolves.toEqual({ provider: 'vidnest', streams: [] });
    await expect(second).resolves.toMatchObject({
      provider: 'vidnest',
      streams: [{ url: 'https://media.example.com/shared.m3u8' }],
    });
    expect(pageRequests).toBe(2);
    expect(pageSignals).toHaveLength(2);
    expect(pageSignals[0]!.aborted).toBe(true);
    expect(pageSignals[1]!.aborted).toBe(false);
  });

  it('invokes the global fetch implementation with its required receiver', async () => {
    const receivers: unknown[] = [];
    const fetchMock = vi.fn(function globalFetch(this: unknown, _input: RequestInfo | URL, init?: RequestInit) {
      receivers.push(this);
      expect(init?.redirect).toBe('manual');
      return Promise.resolve(new Response(null, { status: 502 }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const resolver = createVidnestResolver({ servers: ['working'] });

    await expect(resolver({ tmdbId: '550' })).resolves.toEqual({ provider: 'vidnest', streams: [] });
    expect(receivers).toEqual([globalThis]);
  });

  it.each(['provider', 'page', 'chunk'] as const)(
    'rejects and cancels manual redirects during %s lookup without following Location',
    async (stage) => {
      for (const status of [301, 302, 303, 307, 308]) {
        const cancel = vi.fn();
        const redirected = () => new Response(new ReadableStream<Uint8Array>({ cancel }), {
          status, headers: { Location: 'https://127.0.0.1/private' },
        });
        const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          if (init?.redirect === 'error') throw new TypeError('Unsupported redirect mode: error');
          expect(init?.redirect).toBe('manual');
          const url = new URL(String(input));
          if (url.hostname === 'new.vidnest.fun') {
            if (stage === 'provider') return redirected();
            return json(await sealedReply({
              url: 'https://media.example.com/manual.m3u8', type: 'hls',
            }, url.searchParams.get('_n')!, FIRST_KEY));
          }
          if (url.hostname !== 'vidnest.fun') throw new Error('Unexpected redirect destination');
          if (url.pathname.startsWith('/movie/')) return stage === 'page' ? redirected() : keyPage();
          if (url.pathname.endsWith('/player123.js')) return stage === 'chunk' ? redirected() : keyBundle(FIRST_KEY);
          throw new Error('Unexpected lookup');
        });
        await expect(createVidnestResolver({ fetchImpl, servers: ['working'] })({ tmdbId: '550' }))
          .resolves.toEqual({ provider: 'vidnest', streams: [] });
        expect(fetchImpl).toHaveBeenCalledTimes({ provider: 1, page: 3, chunk: 5 }[stage]);
        expect(cancel).toHaveBeenCalledTimes(stage === 'provider' ? 1 : 2);
      }
    },
  );

  it('bounds and cancels oversized provider, page, and chunk bodies', async () => {
    {
      const oversized = oversizedResponse(300 * 1024);
      const resolver = createVidnestResolver({
        servers: ['working'],
        fetchImpl: async () => oversized.response,
      });
      await expect(resolver({ tmdbId: '550' })).resolves.toEqual({ provider: 'vidnest', streams: [] });
      expect(oversized.cancel).toHaveBeenCalledTimes(1);
    }

    {
      const oversized = oversizedResponse(600 * 1024);
      const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.hostname === 'new.vidnest.fun') {
          const nonce = url.searchParams.get('_n')!;
          return json(await sealedReply({ url: 'https://media.example.com/page.m3u8' }, nonce, FIRST_KEY));
        }
        if (url.pathname === '/movie/550') return oversized.response;
        if (url.pathname === '/movie/324857') return new Response(null, { status: 404 });
        throw new Error(`Unexpected request: ${url.href}`);
      });
      const resolver = createVidnestResolver({ fetchImpl, servers: ['working'] });
      await expect(resolver({ tmdbId: '550' })).resolves.toEqual({ provider: 'vidnest', streams: [] });
      expect(oversized.cancel).toHaveBeenCalledTimes(1);
    }

    {
      const oversized = oversizedResponse(600 * 1024);
      const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.hostname === 'new.vidnest.fun') {
          const nonce = url.searchParams.get('_n')!;
          return json(await sealedReply({ url: 'https://media.example.com/chunk.m3u8' }, nonce, FIRST_KEY));
        }
        if (url.pathname === '/movie/550') return keyPage();
        if (url.pathname.endsWith('/player123.js')) return oversized.response;
        if (url.pathname === '/movie/324857') return new Response(null, { status: 404 });
        throw new Error(`Unexpected request: ${url.href}`);
      });
      const resolver = createVidnestResolver({ fetchImpl, servers: ['working'] });
      await expect(resolver({ tmdbId: '550' })).resolves.toEqual({ provider: 'vidnest', streams: [] });
      expect(oversized.cancel).toHaveBeenCalledTimes(1);
    }
  });

  it('finishes bounded batched key discovery after the provider envelope deadline', async () => {
    const html = Array.from({ length: 20 }, (_value, index) =>
      `<script src="/_next/static/chunks/chunk${index}.js"></script>`).join('');
    let chunkRequests = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname === 'new.vidnest.fun') {
        const nonce = url.searchParams.get('_n')!;
        return json(await sealedReply({
          url: 'https://media.example.com/cold-start.m3u8',
          headers: {},
        }, nonce, FIRST_KEY));
      }
      if (url.pathname === '/movie/550') return new Response(html);
      if (url.pathname.startsWith('/_next/static/chunks/chunk')) {
        const index = Number(url.pathname.match(/chunk(\d+)\.js$/)?.[1]);
        chunkRequests += 1;
        await new Promise((resolve) => setTimeout(resolve, 40));
        return index === 15 ? keyBundle(FIRST_KEY) : new Response(`const chunk${index}=true;`);
      }
      if (url.pathname === '/movie/324857') return new Response(null, { status: 404 });
      throw new Error(`Unexpected request: ${url.href}`);
    });
    const resolver = createVidnestResolver({
      fetchImpl,
      servers: ['working'],
      serverTimeoutMs: 100,
      keyLookupTimeoutMs: 500,
    });

    await expect(resolver({ tmdbId: '550' })).resolves.toMatchObject({
      provider: 'vidnest',
      streams: [{ url: 'https://media.example.com/cold-start.m3u8' }],
    });
    expect(chunkRequests).toBe(16);
  });

  it('limits discovered chunks before fetching them', async () => {
    const html = Array.from({ length: 20 }, (_value, index) =>
      `<script src="/_next/static/chunks/chunk${index}.js"></script>`).join('');
    let chunkRequests = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname === 'new.vidnest.fun') {
        const nonce = url.searchParams.get('_n')!;
        return json(await sealedReply({ url: 'https://media.example.com/chunks.m3u8' }, nonce, FIRST_KEY));
      }
      if (url.pathname === '/movie/550') return new Response(html);
      if (url.pathname.startsWith('/_next/static/chunks/chunk')) {
        chunkRequests += 1;
        return new Response(null, { status: 404 });
      }
      if (url.pathname === '/movie/324857') return new Response(null, { status: 404 });
      throw new Error(`Unexpected request: ${url.href}`);
    });
    const resolver = createVidnestResolver({ fetchImpl, servers: ['working'] });

    await expect(resolver({ tmdbId: '550' })).resolves.toEqual({ provider: 'vidnest', streams: [] });
    expect(chunkRequests).toBe(16);
  });

  it('stops chunk reads at the aggregate byte budget', async () => {
    const html = Array.from({ length: 12 }, (_value, index) =>
      `<script src="/_next/static/chunks/chunk${index}.js"></script>`).join('');
    const overBudgetChunks = [oversizedResponse(300 * 1024), oversizedResponse(300 * 1024)];
    let chunkRequests = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname === 'new.vidnest.fun') {
        const nonce = url.searchParams.get('_n')!;
        return json(await sealedReply({ url: 'https://media.example.com/aggregate.m3u8' }, nonce, FIRST_KEY));
      }
      if (url.pathname === '/movie/550') return new Response(html);
      if (url.pathname.startsWith('/_next/static/chunks/chunk')) {
        const index = Number(url.pathname.match(/chunk(\d+)\.js$/)?.[1]);
        chunkRequests += 1;
        return index < 6 ? new Response('x'.repeat(300 * 1024)) : overBudgetChunks[index - 6]!.response;
      }
      if (url.pathname === '/movie/324857') return new Response(null, { status: 404 });
      throw new Error(`Unexpected request: ${url.href}`);
    });
    const resolver = createVidnestResolver({ fetchImpl, servers: ['working'] });

    await expect(resolver({ tmdbId: '550' })).resolves.toEqual({ provider: 'vidnest', streams: [] });
    expect(chunkRequests).toBe(8);
    expect(overBudgetChunks.some(({ cancel }) => cancel.mock.calls.length > 0)).toBe(true);
  });

  it('caps key probes across likely and fallback candidate scans', async () => {
    const likely = Array.from({ length: 400 }, (_value, index) =>
      `"likelykey${String(index).padStart(20, '0')}",x="https://new.vidnest.fun";`).join('');
    const broad = Array.from({ length: 400 }, (_value, index) =>
      `"broadkey${String(index).padStart(20, '0')}";`).join('');
    const decrypt = vi.fn(async () => { throw new Error('wrong key'); });
    const realCrypto = globalThis.crypto;
    vi.stubGlobal('crypto', {
      getRandomValues: realCrypto.getRandomValues.bind(realCrypto),
      subtle: {
        digest: vi.fn(async () => new Uint8Array(32).buffer),
        importKey: vi.fn(async () => ({} as CryptoKey)),
        decrypt,
      },
    });
    const sealed = Buffer.alloc(28).toString('base64url');
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname === 'new.vidnest.fun') {
        return json({ d: sealed, n: url.searchParams.get('_n'), v: 2 });
      }
      if (url.pathname === '/movie/550') return keyPage();
      if (url.pathname.endsWith('/player123.js')) return new Response(likely + broad);
      if (url.pathname === '/movie/324857') return new Response(null, { status: 404 });
      throw new Error(`Unexpected request: ${url.href}`);
    });
    const resolver = createVidnestResolver({
      fetchImpl,
      servers: ['working'],
      serverTimeoutMs: 10_000,
      keyLookupTimeoutMs: 10_000,
    });

    await expect(resolver({ tmdbId: '550' })).resolves.toEqual({ provider: 'vidnest', streams: [] });
    expect(decrypt).toHaveBeenCalledTimes(512);
  });

  it('invalidates a cached app key and rediscovers it for the same encrypted reply', async () => {
    let resolveCount = 0;
    let activeKey = FIRST_KEY;
    let keyDiscoveries = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname === 'new.vidnest.fun') {
        resolveCount += 1;
        activeKey = resolveCount === 1 ? FIRST_KEY : SECOND_KEY;
        const nonce = url.searchParams.get('_n')!;
        return json(await sealedReply({
          url: `https://media.example.com/${resolveCount}.m3u8`,
          headers: {},
        }, nonce, activeKey));
      }
      if (url.pathname.startsWith('/movie/')) return keyPage();
      if (url.pathname.endsWith('/player123.js')) {
        keyDiscoveries += 1;
        return keyBundle(activeKey);
      }
      throw new Error(`Unexpected request: ${url.href}`);
    });
    const resolver = createVidnestResolver({ fetchImpl, servers: ['working'] });

    await expect(resolver({ tmdbId: '550' })).resolves.toMatchObject({
      provider: 'vidnest', streams: [{ url: 'https://media.example.com/1.m3u8' }],
    });
    await expect(resolver({ tmdbId: '550' })).resolves.toMatchObject({
      provider: 'vidnest', streams: [{ url: 'https://media.example.com/2.m3u8' }],
    });
    expect(keyDiscoveries).toBe(2);
  });
});

describe('VidNest route resolver selection', () => {
  it.each(['', 'https://deleted-api.example.com', 'https://localhost'])(
    'uses the embedded production resolver even if a retired URL was baked into the build: %s',
    async (retiredUrl) => {
    vi.resetModules();
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('VIDNEST_API_SECRET', SECRET);
    vi.stubEnv('VIDNEST_API_URL', retiredUrl);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname === 'new.vidnest.fun') {
        if (!url.pathname.startsWith('/nextgencloudfabric/')) return new Response(null, { status: 502 });
        expect(new Headers(init?.headers).get('authorization')).toBeNull();
        const nonce = url.searchParams.get('_n')!;
        return json(await sealedReply({
          streams: [{ url: 'https://media.example.com/master.m3u8', type: 'hls', headers: {} }],
        }, nonce, FIRST_KEY));
      }
      if (url.pathname.startsWith('/movie/')) return keyPage();
      if (url.pathname.endsWith('/player123.js')) return keyBundle(FIRST_KEY);
      if (url.hostname === 'media.example.com') return new Response('#EXTM3U\n#EXTINF:6,\nsegment.ts\n');
      throw new Error(`Unexpected request: ${url.href}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { GET } = await import('@/app/api/vidnest/route');

    const invalid = await GET(new NextRequest('https://app.example/api/vidnest?tmdbId=550&type=tv'));
    expect(invalid.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();

    const response = await GET(new NextRequest('https://app.example/api/vidnest?tmdbId=550&type=movie&stream=0'));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('/api/vidnest?token=');
    expect(fetchMock.mock.calls.some(([input]) => new URL(String(input)).pathname === '/api/resolve')).toBe(false);
    },
  );

  it('permits an external resolver only for authenticated test fixtures', async () => {
    vi.resetModules();
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('VIDNEST_API_SECRET', SECRET);
    vi.stubEnv('VIDNEST_API_URL', 'https://resolver.example');
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/resolve') {
        return json({ streams: [{ url: 'https://media.example.com/master.m3u8', headers: {} }] });
      }
      return new Response('#EXTM3U\n#EXTINF:6,\nsegment.ts\n');
    });
    vi.stubGlobal('fetch', fetchMock);
    const { GET } = await import('@/app/api/vidnest/route');

    const response = await GET(new NextRequest('https://app.example/api/vidnest?tmdbId=550&type=movie&stream=0'));

    expect(response.status).toBe(200);
    const [resolverUrl, resolverInit] = fetchMock.mock.calls[0]!;
    expect(new URL(String(resolverUrl)).href).toBe('https://resolver.example/api/resolve?tmdbId=550&type=movie');
    expect(new Headers((resolverInit as RequestInit).headers).get('authorization')).toBe(`Bearer ${SECRET}`);
    expect(fetchMock.mock.calls.some(([input]) => new URL(String(input)).hostname === 'new.vidnest.fun')).toBe(false);
  });

  it('rejects an explicitly unsafe external override before any network request', async () => {
    vi.resetModules();
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('VIDNEST_API_SECRET', SECRET);
    vi.stubEnv('VIDNEST_API_URL', 'https://localhost');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { GET } = await import('@/app/api/vidnest/route');

    const response = await GET(new NextRequest('https://app.example/api/vidnest?tmdbId=550&type=movie'));

    expect(response.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
