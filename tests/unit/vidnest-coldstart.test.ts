import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const lifetime = vi.hoisted(() => {
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil(promise: Promise<unknown>) {
    pending.push(promise);
    void promise.catch(() => undefined);
  } };
  return { pending, ctx, available: true };
});
vi.mock('@opennextjs/cloudflare', () => ({ getCloudflareContext: () => {
  if (!lifetime.available) throw new Error('No Worker request context.');
  return { ctx: lifetime.ctx };
} }));

const SECRET = 'synthetic-cold-start-secret-at-least-32-characters';
const MASTER = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English",LANGUAGE="en"\n'
  + '#EXT-X-STREAM-INF:BANDWIDTH=1400000,RESOLUTION=854x480,AUDIO="a"\nvideo.m3u8\n'
  + '#EXT-X-STREAM-INF:BANDWIDTH=16000000,RESOLUTION=3840x2160,AUDIO="a"\nuhd.m3u8\n';
const MEDIA = '#EXTM3U\n#EXTINF:6,\nsegment.ts\n';
const BYTES = new Uint8Array(1024);
BYTES[0] = BYTES[188] = BYTES[376] = 0x47;

function request(query = 'stream=auto', signal?: AbortSignal) {
  return new NextRequest(`https://app.example/api/vidnest?tmdbId=1283515&type=movie&${query}`, { signal });
}

afterEach(async () => {
  if (vi.isFakeTimers()) await vi.runAllTimersAsync();
  await Promise.allSettled(lifetime.pending);
  lifetime.pending.length = 0;
  lifetime.available = true;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('VidNest cold-start stage timing', () => {
  it.each(['healthy', 'no-lifetime', 'fallback', 'outage'])('measures %s cold/warm stages, full fallback and owned completion', async (profile) => {
    vi.resetModules();
    lifetime.available = profile !== 'no-lifetime';
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('VIDNEST_API_SECRET', SECRET);
    vi.stubEnv('TMDB_API_KEY', 'synthetic-public-metadata-key');
    const decoded = new TextEncoder().encode(JSON.stringify({ streams: profile === 'fallback'
      ? [{ url: 'https://media.example.com/broken/master.m3u8', type: 'hls' }] : [
      { url: 'https://media.example.com/fast/master.m3u8', type: 'hls' },
      { url: 'https://media.example.com/stalled/master.m3u8', type: 'hls' },
    ] }));
    const alternate = new TextEncoder().encode(JSON.stringify({ streams: [
      { url: 'https://media.example.com/alternate/master.m3u8', type: 'hls' },
    ] }));
    const crypto = globalThis.crypto;
    // The timing fixture replaces CPU-only unsealing; real AES-GCM authentication
    // and key rotation are covered independently in vidnest-resolver.test.ts.
    vi.stubGlobal('crypto', {
      getRandomValues: crypto.getRandomValues.bind(crypto),
      subtle: {
        digest: async () => new Uint8Array(32).buffer,
        importKey: async () => ({} as CryptoKey),
        decrypt: async (_algorithm: unknown, _key: unknown, data: BufferSource) => new Uint8Array(data as ArrayBuffer)[0] === 1
          ? alternate.buffer : decoded.buffer,
      },
    });
    const { GET } = await import('@/app/api/vidnest/route');
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const calls: Record<string, number> = {};
    const finished: Record<string, number> = {};
    const aborted: string[] = [];
    let recovered = false;
    const delay = (ms: number, signal: AbortSignal | null | undefined, stage: string) => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); finished[stage] = Date.now(); resolve(); }, ms);
      const abort = () => {
        clearTimeout(timer); aborted.push(stage);
        reject(new DOMException('Synthetic canceled I/O.', 'AbortError'));
      };
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
    });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      let stage: string;
      let ms: number;
      let response: Response;
      if (url.hostname === 'new.vidnest.fun') {
        stage = 'provider';
        if (profile === 'fallback' && url.pathname.startsWith('/hollymoviehd/')) {
          const sealed = Buffer.alloc(28); sealed[12] = 1;
          ms = 200; response = Response.json({ v: 2, d: sealed.toString('base64url'), n: 'synthetic-nonce' });
        } else if (!url.pathname.startsWith('/nextgencloudfabric/')) {
          calls[stage] = (calls[stage] ?? 0) + 1;
          await delay(8000, init?.signal, 'failed-provider');
          return new Response(null, { status: 503 });
        } else {
          ms = 80;
          response = profile === 'outage' && !recovered ? new Response(null, { status: 503 })
            : Response.json({ v: 2, d: Buffer.alloc(28).toString('base64url'), n: 'synthetic-nonce' });
        }
      } else if (url.hostname === 'api.themoviedb.org') {
        stage = 'nonanime'; ms = 2500;
        response = Response.json({ title: 'Synthetic film', genres: [{ id: 18 }] });
      } else if (url.hostname === 'vidnest.fun' && url.pathname.startsWith('/movie/')) {
        stage = 'key-page'; ms = 50;
        response = new Response(Array.from({ length: 4 }, (_, i) => `<script src="/_next/static/chunks/chunk${i}.js"></script>`).join(''));
      } else if (url.hostname === 'vidnest.fun') {
        stage = 'key-chunk'; ms = url.pathname.endsWith('chunk0.js') ? 40 : 320;
        response = new Response(url.pathname.endsWith('chunk0.js')
          ? 'const key="synthetic-authenticated-key-001",api="https://new.vidnest.fun";' : 'const unrelated=true;');
      } else if (url.pathname.startsWith('/broken/')) {
        stage = 'broken-manifest'; ms = 30; response = new Response('<html>Unavailable</html>');
      } else if (url.pathname.startsWith('/stalled/')) {
        stage = 'stalled-manifest'; ms = 8000; response = new Response(MASTER);
      } else if (url.pathname.endsWith('master.m3u8')) {
        stage = 'master'; ms = 30; response = new Response(MASTER);
      } else if (url.pathname.endsWith('video.m3u8')) {
        stage = 'child'; ms = 30; response = new Response(MEDIA);
      } else {
        stage = 'media'; ms = 200; response = new Response(BYTES);
      }
      calls[stage] = (calls[stage] ?? 0) + 1;
      await delay(ms, init?.signal, stage);
      return response;
    }));
    let autoAt = -1;
    let catalogAt = -1;
    const auto = GET(request()).then((response) => { autoAt = Date.now(); return response; });
    expect(lifetime.pending).toHaveLength(lifetime.available ? 1 : 0);
    if (lifetime.pending[0]) void lifetime.pending[0].then(() => { catalogAt = Date.now(); });
    await vi.advanceTimersByTimeAsync(12001);
    const response = await auto;
    expect(response.status).toBe(profile === 'outage' ? 404 : 200);
    if (response.status === 200) {
      expect((await response.text()).match(/#EXT-X-STREAM-INF:/g)).toHaveLength(2);
      expect(response.headers.get('x-vidnest-stream-id')).toBe(profile === 'fallback' ? '1' : '0');
    }
    await Promise.allSettled(lifetime.pending);
    if (!lifetime.available) expect(vi.getTimerCount()).toBe(0);
    recovered = true;
    const metadataPending = GET(request('metadata=1'));
    if (profile === 'outage' || !lifetime.available) await vi.advanceTimersByTimeAsync(8001);
    const metadata = await metadataPending;
    const body = await metadata.json();
    const beforeWarm = { ...calls };
    const warmStart = Date.now();
    const warm = await GET(request());
    const warmMs = Date.now() - warmStart;
    expect(warm.status).toBe(200);
    expect(calls).toEqual(beforeWarm);
    expect(body.streams).toHaveLength(2);
    expect(body.streams.map((stream: { id: string }) => stream.id)).toEqual(['0', '1']);
    expect(body.recommendedStreamId).toBe(profile === 'fallback' ? '1' : '0');
    const expected = profile === 'fallback'
      ? { provider: 6, nonanime: 1, 'key-page': 1, 'key-chunk': 4, 'broken-manifest': 1, master: 1, child: 1, media: 1 }
      : { provider: profile === 'outage' || !lifetime.available ? 12 : 6,
        nonanime: profile === 'outage' || !lifetime.available ? 2 : 1,
        'key-page': 1, 'key-chunk': 4, master: lifetime.available ? 1 : 2,
        'stalled-manifest': lifetime.available ? 1 : 2, child: lifetime.available ? 1 : 2, media: lifetime.available ? 1 : 2 };
    expect(calls).toEqual(expected);
    expect(autoAt).toBe(profile === 'fallback' ? 4260 : profile === 'outage' ? 4000 : 430);
    expect(catalogAt).toBe(profile === 'fallback' ? 4260 : profile === 'outage' ? 4000 : lifetime.available ? 4170 : -1);
    expect(warmMs).toBe(0);
    expect(aborted.filter((stage) => stage === 'failed-provider')).toHaveLength(profile === 'fallback' ? 4
      : profile === 'outage' || !lifetime.available ? 10 : 5);
    expect(aborted.filter((stage) => stage === 'key-chunk')).toHaveLength(3);
    console.info(JSON.stringify({ fixture: 'vidnest-cold-start', profile, baselineAutoMs: 4260, autoMs: autoAt,
      catalogMs: catalogAt, warmMs, calls, finished, canceledCount: aborted.length }));
  });
});
