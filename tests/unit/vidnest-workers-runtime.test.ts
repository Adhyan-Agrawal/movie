import { describe, expect, it } from 'vitest';
import { build, type Plugin } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Miniflare, Log, LogLevel } from 'miniflare';
import type { DirectStream } from '@/lib/providers/types';

const project = fileURLToPath(new URL('../../', import.meta.url));
const STARTUP_BENCHMARK = process.env.STARTUP_BENCHMARK === '1';
const SECRET = 'synthetic-worker-proxy-secret-at-least-32-characters';
const APP_KEY = 'synthetic-authenticated-app-key-001';
const MASTER = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English",LANGUAGE="en"\n'
  + '#EXT-X-STREAM-INF:BANDWIDTH=1400000,RESOLUTION=854x480,AUDIO="a"\nvideo.m3u8\n'
  + '#EXT-X-STREAM-INF:BANDWIDTH=16000000,RESOLUTION=3840x2160,AUDIO="a"\nuhd.m3u8\n';

type RuntimeStats = {
  counts: Record<string, number>; finished: Record<string, number>; phases: string[];
  deferred: number; completed: number; canceledMedia: number;
  mediaRanges: { range: string | null; ifRange: string | null }[];
  autoReturn: { deferred: number; completed: number; counts: Record<string, number>; finished: Record<string, number> };
};

// Native HTTP adapters only; the actual route, resolver engines, AES, guards,
// metadata parsers and installed OpenNext context implementation are bundled.
const httpBoundary: Plugin = {
  name: 'vidnest-native-http-fixture',
  setup(esbuild) {
    esbuild.onResolve({ filter: /^next\/server$/ }, () => ({ path: 'next-http', namespace: 'fixture' }));
    esbuild.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `
      export class NextRequest extends Request { get nextUrl() { return new URL(this.url); } }
      export class NextResponse extends Response {
        static json(value, init = {}) {
          const headers = new Headers(init.headers);
          if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
          return new NextResponse(JSON.stringify(value), { ...init, headers });
        }
      }
    ` }));
    esbuild.onResolve({ filter: /^@opennextjs\/cloudflare$/ }, () => ({
      path: resolve(project, 'node_modules/@opennextjs/cloudflare/dist/api/cloudflare-context.js'),
    }));
    esbuild.onResolve({ filter: /^@\// }, (args) => ({ path: resolve(project, 'src', `${args.path.slice(2)}.ts`) }));
  },
};

describe('VidNest real workerd request lifetime and timing', () => {
  it('returns primary Auto early, completes the whole catalog, and streams full first media without sharing pending I/O', async () => {
    const bundled = await build({
      absWorkingDir: project, bundle: true, write: false, format: 'esm', platform: 'node', target: 'es2022',
      plugins: [httpBoundary],
      define: {
        'process.env.NODE_ENV': '"production"',
        'process.env.VIDNEST_API_SECRET': JSON.stringify(SECRET),
        'process.env.VIDNEST_API_URL': '""',
        'process.env.TMDB_API_KEY': '"synthetic-public-metadata-key"',
      },
      stdin: { resolveDir: project, contents: `
        import { AsyncLocalStorage } from 'node:async_hooks';
        import { GET } from './src/app/api/vidnest/route.ts';
        import { NextRequest } from 'next/server';
        const storage = new AsyncLocalStorage();
        Object.defineProperty(globalThis, Symbol.for('__cloudflare-context__'), { get: () => storage.getStore() });
        let deferred = 0, completed = 0;
        let observedAuto = false;
        export default { fetch(request, env, ctx) {
          const instrumented = { waitUntil(promise) {
            deferred++;
            ctx.waitUntil(promise.then(async () => {
              completed++;
              await env.UPSTREAM.fetch('https://fixture.example/__fixture/deferred-completed', { method: 'POST' });
            }));
          } };
          return storage.run({ env, ctx: instrumented }, async () => {
            const url = new URL(request.url);
            if (url.pathname === '/__fixture/stats') {
              const response = await env.UPSTREAM.fetch('https://fixture.example/__fixture/stats');
              return Response.json({ ...await response.json(), deferred, completed });
            }
            const response = await GET(new NextRequest(request));
            if (url.searchParams.get('stream') === 'auto' && !observedAuto) {
              observedAuto = true;
              await env.UPSTREAM.fetch('https://fixture.example/__fixture/auto-returned', {
                method: 'POST', body: JSON.stringify({ deferred, completed }),
              });
            }
            if (url.searchParams.get('metadata') === '1') {
              await env.UPSTREAM.fetch('https://fixture.example/__fixture/metadata-returned', { method: 'POST' });
            }
            return response;
          });
        } };
      ` },
    });
    const upstream = `
      const counts = {}, finished = {}, phases = [], mediaRanges = [];
      let canceledMedia = 0;
      let autoReturn;
      const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const count = (stage) => { counts[stage] = (counts[stage] || 0) + 1; };
      const finish = (stage) => { finished[stage] = (finished[stage] || 0) + 1; };
      const gates = new Map();
      const gate = (name) => {
        if (!gates.has(name)) {
          let resolve;
          const promise = new Promise((done) => { resolve = done; });
          gates.set(name, { promise, resolve, open: false });
        }
        return gates.get(name);
      };
      const release = (name) => {
        const current = gate(name);
        if (current.open) return;
        current.open = true; phases.push('released:' + name); current.resolve();
      };
      // These are CPU-only fixture notifications, not shared fetch/body promises.
      // Each waiter owns a bounded timer so workerd never sees a hung request.
      const wait = async (name) => {
        let timer;
        try {
          await Promise.race([gate(name).promise, new Promise((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('Fixture phase never reached: ' + name)), 20000);
          })]);
        } finally { clearTimeout(timer); }
      };
      export default { async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === '/__fixture/stats') return Response.json({ counts, finished, phases, canceledMedia, mediaRanges, autoReturn });
        if (url.pathname === '/__fixture/auto-returned') {
          autoReturn = { ...await request.json(), counts: { ...counts }, finished: { ...finished } };
          phases.push('primary-auto-returned'); release('resolver-tail');
          return new Response(null, { status: 204 });
        }
        if (url.pathname === '/__fixture/deferred-completed') {
          if (!gate('deferred-completed').open) phases.push('deferred-completed');
          release('deferred-completed'); return new Response(null, { status: 204 });
        }
        if (url.pathname === '/__fixture/metadata-returned') {
          await wait('deferred-completed');
          if (!phases.includes('metadata-returned')) phases.push('metadata-returned');
          return new Response(null, { status: 204 });
        }
        if (url.hostname === 'new.vidnest.fun') {
          count('provider');
          const primary = url.pathname.startsWith('/nextgencloudfabric/');
          if (!primary) {
            await delay(900); await wait('resolver-tail');
            finish('tailProvider');
            if (!url.pathname.startsWith('/hollymoviehd/')) return new Response(null, { status: 503 });
          } else { await delay(80); }
          const nonce = url.searchParams.get('_n');
          const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(nonce + '|' + ${JSON.stringify(APP_KEY)}));
          const key = await crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt']);
          const iv = crypto.getRandomValues(new Uint8Array(12));
          const data = { streams: primary ? [
            { url: 'https://media.example.com/fast/master.m3u8', type: 'hls', headers: {} },
            { url: 'https://media.example.com/stalled/master.m3u8', type: 'hls', headers: {} }
          ] : [{ url: 'https://media.example.com/alternate/master.m3u8', type: 'hls', headers: {} }] };
          const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(data))));
          const bytes = new Uint8Array(iv.length + encrypted.length); bytes.set(iv); bytes.set(encrypted, iv.length);
          const sealed = btoa(String.fromCharCode(...bytes)).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
          if (primary) finish('primaryProvider');
          return Response.json({ v: 2, n: nonce, d: sealed });
        }
        if (url.hostname === 'api.themoviedb.org') {
          count('nonanime'); await delay(1300); await wait('resolver-tail'); finish('nonanime');
          return Response.json({ title: 'Synthetic film', genres: [{ id: 18 }] });
        }
        if (url.hostname === 'vidnest.fun' && url.pathname.startsWith('/movie/')) {
          count('keyPage');
          if (counts.keyPage === 2) release('cold-key-pages');
          await wait('cold-key-pages'); await delay(50); finish('keyPage');
          return new Response(Array.from({ length: 4 }, (_, i) => '<script src="/_next/static/chunks/chunk' + i + '.js"></script>').join(''));
        }
        if (url.hostname === 'vidnest.fun') {
          count('keyChunk'); const match = url.pathname.endsWith('chunk0.js'); await delay(match ? 40 : 320);
          if (match) finish('authenticatedKey');
          return new Response(match ? ${JSON.stringify(`const key="${APP_KEY}",api="https://new.vidnest.fun";`)} : 'const unrelated=true;');
        }
        if (url.hostname !== 'media.example.com') throw new Error('Unexpected fixture origin.');
        if (url.pathname.startsWith('/stalled/')) {
          count('stalled');
          if (counts.stalled === 2) release('independent-stalled-probes');
          await wait('independent-stalled-probes'); await delay(900); finish('stalled');
          return new Response(null, { status: 503 });
        }
        const alternate = url.pathname.startsWith('/alternate/');
        if (url.pathname.endsWith('master.m3u8')) {
          count(alternate ? 'alternateMaster' : 'master');
          if (alternate) {
            if (counts.alternateMaster === 2) release('independent-alternate-probes');
            await wait('independent-alternate-probes');
          }
          await delay(20);
          return new Response(${JSON.stringify(MASTER)} + '#FIXTURE-SOURCE:' + (alternate ? 'alternate' : 'fast') + '\\n');
        }
        if (url.pathname.endsWith('video.m3u8')) {
          count(alternate ? 'alternateChild' : 'child'); await delay(20);
          return new Response('#EXTM3U\\n#EXTINF:6,\\nsegment.ts\\n');
        }
        count('media');
        const range = request.headers.get('range'), ifRange = request.headers.get('if-range');
        mediaRanges.push({ range, ifRange });
        if (range === 'bytes=1050000-') return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */1050000' } });
        if (range === 'bytes=0-375') {
          const bytes = new Uint8Array(376); bytes[0] = bytes[188] = 0x47;
          return new Response(bytes, { status: 206, headers: {
            'Content-Type': 'video/mp2t', 'Content-Length': '376', 'Content-Range': 'bytes 0-375/1050000',
            'Accept-Ranges': 'bytes', 'ETag': '"fixture-media"',
          } });
        }
        if (range && range !== 'bytes=0-1023') throw new Error('Unexpected fixture media range.');
        let sent = 0, canceled = false;
        const body = new ReadableStream({ async pull(controller) {
          await delay(50); if (canceled) return;
          const bytes = new Uint8Array(52500);
          for (let offset = 0; offset < bytes.length; offset += 188) bytes[offset] = 0x47;
          controller.enqueue(bytes);
          if (++sent === 20) { finish('fullMedia'); controller.close(); }
        }, cancel() { canceled = true; canceledMedia++; } });
        return new Response(body, { headers: { 'Content-Type': 'video/mp2t', 'Content-Length': '1050000' } });
      } };
    `;
    const mf = new Miniflare({
      cf: false, enableDevRegistry: false, telemetry: { enabled: false }, logRequests: false,
      log: new Log(LogLevel.ERROR),
      workers: [
        { config: {
          name: 'app', compatibilityDate: '2026-10-30',
          compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public', 'enable_request_signal'],
          manifest: { mainModule: 'app.js', modules: { 'app.js': { type: 'esm', contents: bundled.outputFiles[0]!.text } } },
          env: { UPSTREAM: { type: 'worker', worker: 'upstream' } },
        }, dev: { outboundService: { type: 'worker', worker: 'upstream' } } },
        { config: { name: 'upstream', compatibilityDate: '2026-10-30',
          manifest: { mainModule: 'upstream.js', modules: { 'upstream.js': { type: 'esm', contents: upstream } } } } },
      ],
    });
    try {
      await mf.ready;
      // Initialize Miniflare's HTTP/RPC bridge without resolving any media.
      // The measured requests still start with empty provider/key/catalog caches.
      const bootstrapStart = performance.now();
      const initial = await (await mf.dispatchFetch('https://app.example/__fixture/stats')).json() as { counts: Record<string, number> };
      const bootstrapMs = performance.now() - bootstrapStart;
      expect(initial.counts).toEqual({});
      const base = 'https://app.example/api/vidnest?tmdbId=1283515&type=movie';
      const start = performance.now();
      let autoMs = 0, metadataMs = 0, fullMediaMs = 0, firstMediaSinceStartMs = 0;
      let firstMediaUrl!: URL;
      let catalog!: { streams: DirectStream[]; recommendedStreamId?: string };
      const auto = mf.dispatchFetch(`${base}&stream=auto`).then(async (response) => {
        autoMs = performance.now() - start;
        expect(response.status).toBe(200);
        expect(response.headers.get('x-vidnest-stream-id')).toBe('0');
        const playlist = await response.text();
        expect(playlist.match(/#EXT-X-STREAM-INF:/g)).toHaveLength(2);
        expect(playlist).toContain('#FIXTURE-SOURCE:fast');
        const childPath = playlist.split('\n').find((line) => line.startsWith('/api/vidnest?token='))!;
        const child = await mf.dispatchFetch(new URL(childPath, base));
        expect(child.status).toBe(200);
        const mediaPath = (await child.text()).split('\n').find((line) => line.startsWith('/api/vidnest?token='))!;
        firstMediaUrl = new URL(mediaPath, base);
        const mediaStart = performance.now();
        const media = await mf.dispatchFetch(firstMediaUrl);
        expect(media.status).toBe(200);
        // Native Workers emits chunked bodies for generic replay streams and ignores
        // a manual Content-Length. Any retained length must still be exact.
        expect([null, '1050000']).toContain(media.headers.get('content-length'));
        expect((await media.arrayBuffer()).byteLength).toBe(1_050_000);
        fullMediaMs = performance.now() - mediaStart;
        firstMediaSinceStartMs = performance.now() - start;
      });
      const metadata = mf.dispatchFetch(`${base}&metadata=1`).then(async (response) => {
        metadataMs = performance.now() - start;
        expect(response.status).toBe(200);
        catalog = await response.json() as typeof catalog;
        expect(catalog.streams.map((stream) => stream.id)).toEqual(['0', '1', '2']);
        expect(catalog.recommendedStreamId).toBe('0');
        for (const index of [0, 2]) {
          const stream = catalog.streams[index]!;
          expect(stream.qualities.map((quality) => quality.height)).toEqual([480, 2160]);
          expect(stream.audioTracks.map((track) => track.language)).toEqual(['en']);
          expect(Number.isFinite(stream.startupLatencyMs)).toBe(true);
        }
        expect(catalog.streams[1]!.qualities).toEqual([]);
        expect(catalog.streams[1]!.startupLatencyMs).toBeUndefined();
      });
      await Promise.all([auto, metadata]);
      const stats = await (await mf.dispatchFetch('https://app.example/__fixture/stats')).json() as RuntimeStats;
      expect(stats.deferred).toBe(1);
      expect(stats.completed).toBe(1);
      // The server releases the tail only after the real GET returns. Paired
      // cold key/probe barriers make request ownership exact, even if JS is busy.
      expect(stats.autoReturn).toEqual({
        deferred: 1, completed: 0,
        counts: { provider: 12, nonanime: 2, keyPage: 2, keyChunk: 8, master: 1, stalled: 1, child: 1, media: 1 },
        finished: { primaryProvider: 2, keyPage: 2, authenticatedKey: 2 },
      });
      const startupPasses = 2;
      expect(stats.counts).toEqual({ provider: 12, nonanime: 2, keyPage: 2, keyChunk: 8,
        master: startupPasses, stalled: startupPasses, child: startupPasses + 1, media: 5,
        alternateMaster: startupPasses, alternateChild: startupPasses });
      expect(stats.finished).toEqual({ primaryProvider: 2, tailProvider: 10, nonanime: 2,
        keyPage: 2, authenticatedKey: 2, stalled: 2, fullMedia: 1 });
      expect(stats.canceledMedia).toBe(4);
      expect(stats.mediaRanges.filter(({ range }) => range === 'bytes=0-1023')).toHaveLength(4);
      expect(stats.mediaRanges.filter(({ range }) => range === null)).toHaveLength(1);
      expect(stats.mediaRanges.every(({ ifRange }) => ifRange === null)).toBe(true);
      expect(stats.phases).toEqual([
        'released:cold-key-pages', 'primary-auto-returned', 'released:resolver-tail',
        'released:independent-stalled-probes', 'released:independent-alternate-probes',
        'deferred-completed', 'released:deferred-completed', 'metadata-returned',
      ]);
      const warmStart = performance.now();
      expect((await mf.dispatchFetch(`${base}&stream=auto`)).status).toBe(200);
      const warmMs = performance.now() - warmStart;
      expect((await mf.dispatchFetch(`${base}&metadata=1`)).status).toBe(200);
      const afterWarm = await (await mf.dispatchFetch('https://app.example/__fixture/stats')).json() as typeof stats;
      expect(afterWarm.counts).toEqual(stats.counts);
      expect(afterWarm.finished).toEqual(stats.finished);
      expect(afterWarm.canceledMedia).toBe(stats.canceledMedia);
      expect(afterWarm.mediaRanges).toEqual(stats.mediaRanges);
      // eslint-disable-next-line no-console -- Intentional benchmark evidence, not application logging.
      console.info(JSON.stringify({ fixture: 'vidnest-workerd', bootstrapMs: Math.round(bootstrapMs), autoMs: Math.round(autoMs), metadataMs: Math.round(metadataMs),
        warmMs: Math.round(warmMs), fullMediaMs: Math.round(fullMediaMs), firstMediaSinceStartMs: Math.round(firstMediaSinceStartMs),
        fullMediaBytes: 1_050_000, transportMbps: Number((8_400 / fullMediaMs).toFixed(2)), calls: stats.counts,
        settledCatalogCallsSaved: (2 - startupPasses) * 4,
        benchmarkMode: STARTUP_BENCHMARK ? 'strict' : 'functional', phases: stats.phases,
        note: 'Data-cold, HTTP bridge initialized. Transport fixture; prefix is not complete-media or decoder readiness.' }));
      // Opt in only when this file is run in isolation; all phase/byte/call gates
      // above remain mandatory in normal suites, without host CPU timing noise.
      if (STARTUP_BENCHMARK) {
        expect(autoMs).toBeLessThan(900);
        expect(metadataMs).toBeGreaterThan(1300);
        expect(fullMediaMs).toBeGreaterThan(800);
      }

      for (const [index, source] of [[0, 'fast'], [2, 'alternate']] as const) {
        const selected = await mf.dispatchFetch(`${base}&stream=${index}`);
        expect(selected.status).toBe(200);
        const playlist = await selected.text();
        expect(playlist).toContain(`#FIXTURE-SOURCE:${source}`);
        expect(playlist.match(/#EXT-X-STREAM-INF:/g)).toHaveLength(2);
      }
      expect((await mf.dispatchFetch(`${base}&stream=1`)).status).toBe(502);
      const uhd = await mf.dispatchFetch(new URL(`${catalog.streams[0]!.url}&rendition=1`, base));
      expect(uhd.status).toBe(200);
      const uhdPlaylist = await uhd.text();
      expect(uhdPlaylist.match(/#EXT-X-STREAM-INF:/g)).toHaveLength(1);
      expect(uhdPlaylist).toContain('RESOLUTION=3840x2160');
      expect(uhdPlaylist).not.toContain('RESOLUTION=854x480');

      const ranged = await mf.dispatchFetch(firstMediaUrl, { headers: { Range: 'bytes=0-375', 'If-Range': '"fixture-media"' } });
      expect(ranged.status).toBe(206);
      expect(ranged.headers.get('content-range')).toBe('bytes 0-375/1050000');
      expect([null, '376']).toContain(ranged.headers.get('content-length'));
      expect(ranged.headers.get('accept-ranges')).toBe('bytes');
      expect(ranged.headers.get('etag')).toBe('"fixture-media"');
      const rangeBytes = new Uint8Array(await ranged.arrayBuffer());
      expect(rangeBytes.byteLength).toBe(376);
      expect(rangeBytes[0]).toBe(0x47);
      expect(rangeBytes[188]).toBe(0x47);
      const unsatisfied = await mf.dispatchFetch(firstMediaUrl, { headers: { Range: 'bytes=1050000-' } });
      expect(unsatisfied.status).toBe(416);
      expect(unsatisfied.headers.get('content-range')).toBe('bytes */1050000');
      const afterManual = await (await mf.dispatchFetch('https://app.example/__fixture/stats')).json() as RuntimeStats;
      expect(afterManual.counts).toEqual({ ...stats.counts, master: 4, alternateMaster: 3, stalled: 3, media: 7 });
      expect(afterManual.mediaRanges.slice(stats.mediaRanges.length)).toEqual([
        { range: 'bytes=0-375', ifRange: '"fixture-media"' }, { range: 'bytes=1050000-', ifRange: null },
      ]);
      expect(afterManual.canceledMedia).toBe(stats.canceledMedia);
    } finally {
      await mf.dispose();
    }
  }, 30_000);
});
