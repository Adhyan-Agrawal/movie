// QA only: run AFTER main freezes the existing OpenNext artifact. Never builds.
// All metadata is invented; MP4 bytes are local FFmpeg test patterns, not trailers.
// Strict application CSP remains enabled; direct IMDb media requests are fulfilled
// in Playwright, never by the Worker. No real credentials or signed URLs are logged.
import { chromium } from 'playwright';
import { MockAgent, fetch as undiciFetch } from 'undici';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
function argument(name, fallback = '') {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
}
const PORT = Number(argument('--port', '8797'));
const EXPECTED = argument('--expect-artifact');
const DIALOG_ONLY = args.includes('--dialog-only');
const ORIGIN = `http://127.0.0.1:${PORT}`;
const TEMP = process.platform === 'win32' ? 'C:\\Users\\ADHYAN~1\\AppData\\Local\\Temp\\kilo' : process.env.TMPDIR ?? '/tmp';
const MEDIA_ORIGIN = 'https://imdb-video.media-imdb.com';
const PRIMARY = '/title/movie/qa-synthetic-film-1-900001';
const FALLBACK = '/title/movie/qa-synthetic-film-4-900004';
const results = [];
const workerRequests = [];
const deniedWorkerHosts = new Set();
const fixtureBytes = new Map();
let directory;
let worker;
let mockAgent;
let fixtureServer;
let browser;
let activePage;
let activeTraffic;
let artifact;
let runtimeErrors = 0;
let phase = 'setup';

function assert(condition, message) { if (!condition) throw new Error(message); }
function print(message) { process.stdout.write(`${message}\n`); }
function safeError(error) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/https?:\/\/[^\s"'<>)]*/gi, '<url-redacted>')
    .replace(/(?:Bearer\s+|(?:token|api_key|secret|signature|authorization)["'\s:=]+)[^\s,;"'}]+/gi, '<credential-redacted>')
    .split('\n')[0].slice(0, 600);
}
async function until(fn, message, timeout = 12_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(message);
}
async function check(name, fn) {
  phase = name;
  try {
    const evidence = await fn();
    results.push({ name, status: 'PASS', ...(evidence ? { evidence } : {}) });
    print(`PASS ${name}${evidence ? ` ${JSON.stringify(evidence)}` : ''}`);
  } catch (error) {
    const message = safeError(error);
    results.push({ name, status: 'FAIL', message });
    print(`FAIL ${name}: ${message}`);
    if (activePage) {
      const state = await activePage.evaluate(() => ({
        videos: [...document.querySelectorAll('video')].map((video) => ({ connected: video.isConnected, paused: video.paused, muted: video.muted, ready: video.readyState, time: Number(video.currentTime.toFixed(3)), width: video.videoWidth, height: video.videoHeight })),
        policy: { hover: matchMedia('(hover: hover) and (pointer: fine)').matches,
          reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
          visibility: document.visibilityState, saveData: navigator.connection?.saveData,
          effectiveType: navigator.connection?.effectiveType },
        dialogs: document.querySelectorAll('dialog[open]').length,
        violations: window.__trailerQa.csp.map(({ directive, probe }) => ({ directive, probe })),
      })).catch(() => ({ unavailable: true }));
      print(`STATE ${JSON.stringify(state)}`);
      print(`TRAFFIC ${JSON.stringify(activeTraffic ?? {})}`);
      print(`WORKER ${JSON.stringify({ metadataRequests: workerRequests.length, deniedHosts: [...deniedWorkerHosts], runtimeErrors })}`);
      await activePage.screenshot({ path: join(directory, 'failure.png'), fullPage: false }).catch(() => {});
    }
    throw error;
  }
}

// Same ordered content fingerprint convention as the existing workerd harness.
async function fingerprint() {
  const paths = [];
  async function collect(path) {
    const info = await stat(path);
    if (info.isDirectory()) for (const name of (await readdir(path)).sort()) await collect(join(path, name));
    else if (!path.endsWith('.map')) paths.push(path);
  }
  const output = join(ROOT, '.open-next');
  for (const name of ['worker.js', 'cloudflare', 'middleware', 'server-functions', 'assets', '.build']) {
    const path = join(output, name);
    if (name === '.build' && !await stat(path).catch(() => null)) continue;
    await collect(path);
  }
  const hash = createHash('sha256');
  for (const path of paths.sort()) {
    hash.update(relative(output, path).replaceAll('\\', '/')).update('\0')
      .update(createHash('sha256').update(await readFile(path)).digest()).update('\0');
  }
  return { sha256: hash.digest('hex'), files: paths.length };
}

async function sanitizedDefaults() {
  const source = await readFile(join(ROOT, '.open-next', 'cloudflare', 'next-env.mjs'), 'utf8');
  const exports = /^export const (production|development|test) = (\{[^\r\n]*\});[ \t]*\r?$/gm;
  const matches = [...source.matchAll(exports)];
  const allowed = new Set(['NEXT_PUBLIC_APP_NAME', 'NEXT_PUBLIC_APP_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY']);
  assert(matches.length === 3 && !source.replace(exports, '').trim(), 'Unexpected generated environment module shape');
  assert(matches.every((match) => Object.keys(JSON.parse(match[2])).every((key) => allowed.has(key))), 'Artifact still embeds private runtime defaults; main must rebuild sanitized output');
  return { privateEmbeddedDefaults: 0 };
}

const genres = [{ id: 28, name: 'Action' }, { id: 18, name: 'Drama' }, { id: 35, name: 'Comedy' }, { id: 16, name: 'Animation' }];
const lists = Object.fromEntries(['movie', 'tv'].map((type) => [type, Array.from({ length: 24 }, (_, index) => ({
  id: (type === 'movie' ? 900001 : 900101) + index,
  [type === 'movie' ? 'title' : 'name']: `QA synthetic ${type === 'movie' ? 'film' : 'series'} ${index + 1}`,
  overview: 'Invented QA metadata. Media is a generated test pattern, not this title.',
  [type === 'movie' ? 'release_date' : 'first_air_date']: '2026-01-01',
  original_language: ['en', 'hi', 'ta', 'te', 'ml', 'ja'][index % 6],
  origin_country: [index % 6 === 5 ? 'JP' : index % 6 ? 'IN' : 'US'],
  poster_path: null, backdrop_path: null, vote_average: 7, vote_count: 200,
  popularity: 50 - index, genre_ids: genres.map((genre) => genre.id), adult: false,
}))]));
function tmdbPayload(url) {
  const path = url.pathname.replace(/^\/3/, '');
  if (/^\/genre\/(movie|tv)\/list$/.test(path)) return { genres };
  const list = /^\/(?:discover|trending|search)\/(movie|tv)(?:\/week)?$/.exec(path);
  if (list) {
    let items = lists[list[1]];
    const language = url.searchParams.get('with_original_language');
    const country = url.searchParams.get('with_origin_country');
    if (language) items = items.filter((item) => language.split('|').includes(item.original_language));
    if (country) items = items.filter((item) => item.origin_country.includes(country));
    const page = Number(url.searchParams.get('page') ?? 1);
    return { page, results: items.slice((page - 1) * 20, page * 20), total_results: items.length, total_pages: Math.ceil(items.length / 20) };
  }
  const detail = /^\/(movie|tv)\/(\d+)(?:\/(credits|external_ids|videos))?$/.exec(path);
  if (!detail) return null;
  const [type, id, supplement] = detail.slice(1);
  const item = lists[type].find((entry) => entry.id === Number(id));
  if (!item) return null;
  const imdb_id = `tt${9_000_000 + Number(id) - (type === 'movie' ? 900000 : 900100)}`;
  const credits = { cast: [], crew: [] };
  const external_ids = { imdb_id };
  const videos = { results: [{ site: 'YouTube', type: 'Trailer', official: true, key: 'qaFixture01', name: 'Synthetic fallback placeholder', published_at: '2026-01-01T00:00:00Z' }] };
  if (supplement) return { credits, external_ids, videos }[supplement];
  return { ...item, genres, credits, external_ids, videos, imdb_id, runtime: 1, episode_run_time: [1], seasons: [],
    production_countries: item.origin_country.map((code) => ({ iso_3166_1: code })),
    release_dates: { results: [{ iso_3166_1: 'US', release_dates: [{ certification: 'PG-13' }] }] },
    content_ratings: { results: [{ iso_3166_1: 'US', rating: 'TV-PG' }] },
  };
}
function bingrPayload() {
  const expiry = Math.floor(Date.now() / 1000) + 3600;
  const variant = (height) => ({ url: `${MEDIA_ORIGIN}/qa-synthetic-${height}.mp4?Expires=${expiry}`, quality: `${height}p`, mime: 'MP4' });
  return { provider: 'imdb', contentType: 'Trailer', name: 'Synthetic QA test pattern', mp4: variant(720), all: [variant(720), variant(480)] };
}
async function makeMedia() {
  for (const height of [480, 720]) {
    const path = join(directory, `synthetic-${height}.mp4`);
    const encoded = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${height === 480 ? 854 : 1280}x${height}:rate=24`, '-t', '4', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '32', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', path], { windowsHide: true, timeout: 30_000, encoding: 'utf8' });
    assert(encoded.status === 0, 'FFmpeg synthetic fixture encoding failed; provide installed FFmpeg, no dependencies are installed by this script');
    const bytes = await readFile(path);
    assert(bytes.length < 4 * 1024 * 1024, 'Synthetic fixture exceeds its 4 MiB test-only bound');
    fixtureBytes.set(`/qa-synthetic-${height}.mp4`, bytes);
  }
}
async function startRuntime() {
  for (const key of Object.keys(process.env)) {
    if (!/^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|OS|USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP|HOMEDRIVE|HOMEPATH|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS)$/i.test(key)) delete process.env[key];
  }
  Object.assign(process.env, { NODE_ENV: 'production', WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false', CLOUDFLARE_INCLUDE_PROCESS_ENV: 'false' });
  fixtureServer = createServer((request, response) => {
    const payload = request.method === 'GET' ? tmdbPayload(new URL(request.url, 'http://127.0.0.1')) : null;
    response.writeHead(payload ? 200 : 404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(payload ?? { status_code: 34 }));
  });
  await new Promise((done, reject) => { fixtureServer.once('error', reject); fixtureServer.listen(0, '127.0.0.1', done); });
  const fixtureOrigin = `http://127.0.0.1:${fixtureServer.address().port}`;
  const config = JSON.parse(await readFile(join(ROOT, 'wrangler.jsonc'), 'utf8'));
  const name = `lumora-trailer-qa-${PORT}-${process.pid}`;
  const configPath = join(directory, 'wrangler.jsonc');
  await writeFile(configPath, JSON.stringify({ name, main: join(ROOT, '.open-next', 'worker.js'), compatibility_date: config.compatibility_date, compatibility_flags: config.compatibility_flags,
    assets: { directory: join(ROOT, '.open-next', 'assets'), binding: 'ASSETS' },
    services: [{ binding: 'WORKER_SELF_REFERENCE', service: name, remote: false }],
    vars: { NEXTJS_ENV: 'production', NODE_ENV: 'production', NEXT_PUBLIC_APP_NAME: 'Lumora', NEXT_PUBLIC_APP_URL: ORIGIN,
      NEXT_PUBLIC_SUPABASE_URL: '', NEXT_PUBLIC_SUPABASE_ANON_KEY: '', SUPABASE_SERVICE_ROLE_KEY: '',
      TMDB_API_BASE_URL: `${fixtureOrigin}/3`, TMDB_API_KEY: randomBytes(16).toString('hex'),
      VIDNEST_API_URL: '', VIDNEST_API_SECRET: randomBytes(32).toString('hex'), WYZIE_API_KEY: '', WYZIE_SUBTITLE_TOKEN_SECRET: '',
      ADSTERRA_KEY_LEADERBOARD: '', ADSTERRA_KEY_RECTANGLE: '', ADSTERRA_KEY_PREROLL: '',
    }, dev: { ip: '127.0.0.1', port: PORT, inspector_port: 0 }, observability: { enabled: false },
  }, null, 2));
  await writeFile(join(directory, '.env'), ''); await writeFile(join(directory, '.dev.vars'), '');
  mockAgent = new MockAgent(); mockAgent.disableNetConnect();
  const allowed = new Set([new URL(fixtureOrigin).host, new URL(ORIGIN).host]);
  mockAgent.enableNetConnect((host) => { const permit = allowed.has(host); if (!permit) deniedWorkerHosts.add(host); return permit; });
  mockAgent.get('https://bingr.one').intercept({ path: /^\/api\/trailer\/imdb\/tt9000\d{3}\?prefer=oldest$/, method: 'GET' }).reply((options) => {
    const path = new URL(options.path, 'https://bingr.one').pathname;
    const rawHeaders = options.headers;
    const headers = new Headers(Array.isArray(rawHeaders) && typeof rawHeaders[0] === 'string'
      ? Array.from({ length: rawHeaders.length / 2 }, (_, index) => [rawHeaders[index * 2], rawHeaders[index * 2 + 1]])
      : rawHeaders);
    assert(!['cookie', 'authorization', 'x-api-key', 'referer', 'x-forwarded-for', 'x-user-id'].some((key) => headers.has(key)), 'Worker forwarded private request headers to Bingr');
    workerRequests.push({ path, privateHeaders: false });
    return { statusCode: path.endsWith('/tt9000004') ? 404 : 200, data: JSON.stringify(bingrPayload()), responseOptions: { headers: { 'Content-Type': 'application/json' } } };
  }).persist();
  const { unstable_startWorker } = await import('wrangler');
  worker = await unstable_startWorker({ config: configPath, dev: { remote: false, persist: false, watch: false, liveReload: false, logLevel: 'none',
    outboundService: (request) => undiciFetch(request, { dispatcher: mockAgent, redirect: 'manual' }),
    structuredLogsHandler: (log) => {
      if (log.level === 'error') runtimeErrors += 1;
    },
  } });
  let deadline;
  try { await Promise.race([worker.ready, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Isolated workerd startup exceeded 45 seconds')), 45_000); })]); }
  finally { clearTimeout(deadline); }
  assert((await worker.url).port === String(PORT), 'Workerd did not use the isolated requested port');
}

async function session(options = {}) {
  const context = await browser.newContext({ bypassCSP: false, serviceWorkers: 'block', viewport: options.coarse ? { width: 390, height: 844 } : { width: 1360, height: 900 }, ...(options.coarse ? { isMobile: true, hasTouch: true } : {}) });
  const traffic = { api: 0, mp4: 0, youtube: 0, mutations: 0, failedAssets: 0, errors: 0 };
  await context.addInitScript(({ saveData, effectiveType }) => {
    window.__trailerQa = { csp: [], cls: 0 };
    document.addEventListener('securitypolicyviolation', (event) => window.__trailerQa.csp.push({ directive: event.effectiveDirective, probe: event.blockedURI.includes('trailer-qa.invalid') }));
    new PerformanceObserver((list) => { for (const entry of list.getEntries()) if (!entry.hadRecentInput) window.__trailerQa.cls += entry.value; }).observe({ type: 'layout-shift', buffered: true });
    if (saveData || effectiveType) Object.defineProperty(navigator, 'connection', { configurable: true, value: { saveData: Boolean(saveData), effectiveType: effectiveType ?? '4g' } });
    try { localStorage.setItem('lumora.consent.v1', JSON.stringify({ necessary: true, analytics: false, ads: false, decidedAt: '2026-01-01T00:00:00Z' })); } catch {}
  }, options);
  await context.route('**/*', async (route) => {
    const request = route.request(); const url = new URL(request.url());
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) { traffic.mutations += 1; await route.abort('blockedbyclient'); return; }
    if (url.origin === MEDIA_ORIGIN) {
      const bytes = fixtureBytes.get(url.pathname); assert(bytes, 'Browser requested nonfixture IMDb media'); traffic.mp4 += 1;
      const headers = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes', 'Content-Type': 'video/mp4' };
      const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers().range ?? '');
      if (range) {
        const start = Number(range[1]); const end = Math.min(bytes.length - 1, range[2] ? Number(range[2]) : bytes.length - 1);
        if (start >= bytes.length) { await route.fulfill({ status: 416, headers: { ...headers, 'Content-Range': `bytes */${bytes.length}` } }); return; }
        await route.fulfill({ status: 206, headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${bytes.length}` }, body: bytes.subarray(start, end + 1) });
      } else await route.fulfill({ status: 200, headers, body: request.method() === 'HEAD' ? Buffer.alloc(0) : bytes });
      return;
    }
    if (url.origin === 'https://www.youtube-nocookie.com') { traffic.youtube += 1; await route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Synthetic QA fallback placeholder</title>' }); return; }
    if (url.origin !== ORIGIN) { await route.abort('blockedbyclient'); return; }
    if (url.pathname === '/api/trailer') traffic.api += 1;
    await route.continue();
  });
  const page = await context.newPage(); activePage = page; activeTraffic = traffic;
  page.setDefaultTimeout(12_000); page.setDefaultNavigationTimeout(45_000);
  page.on('pageerror', (error) => {
    traffic.errors += 1;
    traffic.errorDetails ??= [];
    traffic.errorDetails.push({
      phase,
      message: safeError(error),
      arguments: [...error.message.matchAll(/args\[\]=([^&\s]+)/g)].map((match) => {
        try { return decodeURIComponent(match[1]); } catch { return ''; }
      }),
      stack: String(error.stack ?? '').replace(/https?:\/\/[^\s)]*/g, '<asset-url>').slice(0, 3000),
    });
  });
  page.on('response', (response) => { if (response.status() >= 400 && /\/_next\/.*\.(?:js|css)(?:\?|$)/.test(response.url())) traffic.failedAssets += 1; });
  if (options.reducedMotion) await page.emulateMedia({ reducedMotion: 'reduce' });
  return { context, page, traffic };
}
async function navigate(page, path = '/') {
  const response = await page.goto(`${ORIGIN}${path}`, { waitUntil: 'domcontentloaded' });
  assert(response?.ok(), 'Frozen built page did not return HTTP 200');
  assert(Boolean(response.headers()['content-security-policy']), 'Frozen built page lacks enforcing CSP');
  await page.waitForLoadState('networkidle');
}
function card(page, number = 1) { return page.locator(`a[href="/title/movie/qa-synthetic-film-${number}-${900000 + number}"][aria-label]`).first(); }
async function enter(target) {
  await target.scrollIntoViewIfNeeded();
  await target.evaluate((element) => element.dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse' })));
}
async function leave(target) { await target.evaluate((element) => element.dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'mouse' }))); }
async function decoded(target, height) {
  const video = target.locator('video').first(); await video.waitFor({ state: 'attached' });
  await until(() => video.evaluate((element, requiredHeight) => element.readyState >= 2 && !element.paused && element.videoHeight === requiredHeight, height), 'Muted autoplay never decoded the expected actual raster');
  const before = await video.evaluate((element) => ({ time: element.currentTime, frames: element.getVideoPlaybackQuality().totalVideoFrames }));
  const state = await until(async () => video.evaluate((element, start) => {
    const frames = element.getVideoPlaybackQuality().totalVideoFrames;
    return frames > start.frames + 5 && element.currentTime > start.time + 0.3 ? { height: element.videoHeight, frames: frames - start.frames, advanced: Number((element.currentTime - start.time).toFixed(3)), muted: element.muted } : null;
  }, before), 'Native media frames and time did not both advance');
  return { video, state };
}
async function unloaded(handle) {
  return until(() => handle.evaluate((video) => !video.isConnected && video.paused && !video.hasAttribute('src') && video.readyState === 0), 'Stopped preview did not clear src and unload its media resource', 4000);
}
async function guard(name, options) {
  const { context, page, traffic } = await session(options);
  try {
    await check(`no hover fetch: ${name}`, async () => {
      await navigate(page); const target = card(page); await target.waitFor();
      await enter(target); await page.waitForTimeout(900);
      assert(traffic.api === 0 && traffic.mp4 === 0 && await page.locator('video').count() === 0, 'Opt-out guard still requested metadata or media');
      return { apiRequests: traffic.api, mediaRequests: traffic.mp4 };
    });
  } finally { await context.close(); activePage = null; }
}

async function hoverCase() {
  const { context, page, traffic } = await session();
  try {
    await check('SSR and idle render request no trailer metadata or MP4', async () => {
      await navigate(page); await card(page).waitFor(); await page.waitForTimeout(1000);
      assert(await page.locator('video').count() === 0 && traffic.api === 0 && traffic.mp4 === 0 && workerRequests.length === 0, 'Trailer work began before user intent');
    });
    await check('strict application CSP actively blocks a forbidden frame', async () => {
      await page.evaluate(() => { const frame = document.createElement('iframe'); frame.hidden = true; frame.dataset.trailerQaProbe = ''; frame.src = 'https://trailer-qa.invalid/blocked'; document.body.appendChild(frame); });
      await until(() => page.evaluate(() => window.__trailerQa.csp.some((entry) => entry.probe && entry.directive === 'frame-src')), 'CSP probe did not produce an enforcing frame-src violation', 4000);
      await page.locator('[data-trailer-qa-probe]').evaluate((element) => element.remove());
    });
    await check('built trailer API resolves the synthetic TMDB identity without private data', async () => {
      const response = await fetch(`${ORIGIN}/api/trailer?tmdbId=900001&type=movie`);
      const body = await response.json();
      assert(response.ok && body.trailer?.mime === 'video/mp4', `Built trailer metadata lookup failed (HTTP ${response.status}).`);
      return { status: response.status, trailerAvailable: true };
    });
    await check('quick hover cancels the 650 ms intent delay without API work', async () => {
      const target = card(page); await enter(target); await page.waitForTimeout(180); await leave(target); await page.waitForTimeout(800);
      assert(traffic.api === 0 && traffic.mp4 === 0, 'Short hover still fetched trailer metadata/media');
    });
    let firstHandle;
    await check('intent delay and real muted 480p advancing hover playback without CLS', async () => {
      const target = card(page); await target.scrollIntoViewIfNeeded();
      const before = await target.boundingBox(); const cls = await page.evaluate(() => window.__trailerQa.cls);
      await enter(target); await page.waitForTimeout(500);
      assert(traffic.api === 0, 'Trailer API started before the 650 ms hover delay');
      const { video, state } = await decoded(target, 480); firstHandle = await video.elementHandle();
      assert(state.muted && await video.evaluate((element) => element.playsInline), 'Hover video is not muted and inline');
      assert(await video.evaluate((element) => element.crossOrigin === 'anonymous'), 'Hover media did not request anonymous CORS');
      const after = await target.boundingBox(); const delta = await page.evaluate((start) => window.__trailerQa.cls - start, cls);
      assert(Math.abs(before.width - after.width) < 1 && Math.abs(before.height - after.height) < 1 && delta <= 0.001, 'Hover media introduced layout shift');
      assert(new URL(await video.getAttribute('src')).origin === MEDIA_ORIGIN, 'Hover MP4 was routed through the Worker');
      return { ...state, clsDelta: delta };
    });
    await check('only one preview stays active even before the old pointer leaves', async () => {
      const second = card(page, 2); await enter(second); const { video, state } = await decoded(second, 480);
      assert(await page.locator('a video').count() === 1 && await firstHandle.evaluate((element) => element.paused), 'Two previews remained active');
      const handle = await video.elementHandle(); await leave(second); await unloaded(handle); await handle.dispose();
      await firstHandle.dispose();
      return { activeBeforeLeave: 1, muted: state.muted };
    });
    await check('preview leaving unloads media without fresh metadata', async () => {
      const target = card(page); await enter(target); const { video } = await decoded(target, 480);
      const handle = await video.elementHandle(); const requests = traffic.api;
      await leave(target); await unloaded(handle); await handle.dispose();
      assert(traffic.api === requests, 'Leave issued a fresh trailer lookup');
    });
    await check('offscreen IntersectionObserver stops and unloads preview', async () => {
      const target = card(page); await enter(target); const { video } = await decoded(target, 480); const handle = await video.elementHandle();
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await until(() => target.evaluate((element) => { const rect = element.getBoundingClientRect(); return rect.bottom <= 0 || rect.top >= window.innerHeight; }), 'Fixture card never actually moved offscreen', 4000);
      await unloaded(handle); await handle.dispose();
    });
    await check('document-hidden lifecycle stops current preview and blocks later intent', async () => {
      const target = card(page); await enter(target); const { video } = await decoded(target, 480); const handle = await video.elementHandle();
      await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
      await unloaded(handle); await handle.dispose(); const count = traffic.api;
      await enter(target); await page.waitForTimeout(900); assert(traffic.api === count, 'Hidden document started another lookup');
      await page.evaluate(() => { delete document.visibilityState; document.dispatchEvent(new Event('visibilitychange')); });
    });
    await check('preview automatically stops by the 30 second ceiling', async () => {
      const target = card(page); await enter(target); const { video } = await decoded(target, 480); const handle = await video.elementHandle();
      await until(() => target.locator('video').count().then((count) => count === 0), 'Preview exceeded its 30 second playback ceiling', 31_500);
      await unloaded(handle); await handle.dispose();
    });
    await check('no decoder CSP errors, broken built assets, or unhandled browser errors', async () => {
      assert(traffic.errors === 0 && traffic.failedAssets === 0, 'Browser exception or frozen JS/CSS asset failure');
      assert(await page.evaluate(() => !window.__trailerQa.csp.some((entry) => !entry.probe && /media-src|script-src/.test(entry.directive))), 'Required playback/script resource was blocked by CSP');
      return { trailerApiRequests: traffic.api, directMp4Requests: traffic.mp4, writesBlocked: traffic.mutations };
    });
  } finally { await context.close(); activePage = null; }
}
async function dialogCase(path, fallback = false) {
  const { context, page, traffic } = await session();
  try {
    await check(`${fallback ? 'YouTube fallback' : 'primary direct 720p'} native accessible dialog`, async () => {
      await navigate(page, path); const trigger = page.getByRole('button', { name: /Trailer$/ }).first(); await trigger.waitFor();
      assert(traffic.api === 0 && traffic.mp4 === 0 && traffic.youtube === 0, 'Dialog media/provider loaded before explicit open');
      await until(() => trigger.evaluate((element) => Object.keys(element).some((key) => key.startsWith('__reactProps') && typeof element[key]?.onClick === 'function')), 'Trailer trigger did not hydrate');
      await trigger.click(); const dialog = page.getByRole('dialog'); await dialog.waitFor({ state: 'visible' });
      assert(await dialog.evaluate((element) => element instanceof HTMLDialogElement && element.open && element.matches(':modal') && element.contains(document.activeElement)), 'Dialog is not a native modal with contained focus');
      if (fallback) {
        await dialog.locator('iframe').waitFor();
        assert(new URL(await dialog.locator('iframe').getAttribute('src')).origin === 'https://www.youtube-nocookie.com', 'Unavailable Bingr lookup did not use the existing privacy-enhanced YouTube fallback');
        assert(await dialog.locator('video').count() === 0, 'Fallback invented playable direct video');
      } else {
        const video = dialog.locator('video'); await video.waitFor();
        await until(() => video.evaluate((element) => element.videoHeight === 720 && element.readyState >= 2), 'Direct dialog fixture never decoded real 720p');
        assert(await video.evaluate((element) => element.controls && element.playsInline), 'Direct trailer lacks native accessible controls/inline playback');
        assert(await video.evaluate((element) => element.crossOrigin === 'anonymous'), 'Dialog media did not request anonymous CORS');
        assert(new URL(await video.getAttribute('src')).origin === MEDIA_ORIGIN && traffic.youtube === 0, 'Primary Bingr trailer used a proxy or eagerly loaded YouTube');
      }
      const innerBounds = await dialog.boundingBox();
      assert(innerBounds, 'Native dialog has no rendered bounds');
      await page.mouse.click(innerBounds.x + 1, innerBounds.y + 1);
      assert(await dialog.evaluate((element) => element.open), 'Click inside dialog padding incorrectly dismissed the trailer');
      await page.keyboard.press('Tab'); assert(await dialog.evaluate((element) => element.contains(document.activeElement)), 'Native modal let focus escape');
      await dialog.getByRole('button', { name: 'Close', exact: true }).click(); await dialog.waitFor({ state: 'detached' });
      assert(await trigger.evaluate((element) => document.activeElement === element), 'Close failed to restore focus to Trailer trigger');
      await trigger.click(); await page.getByRole('dialog').waitFor(); await page.keyboard.press('Escape');
      await page.getByRole('dialog').waitFor({ state: 'detached' });
      assert(await trigger.evaluate((element) => document.activeElement === element), 'Escape failed to restore focus to Trailer trigger');
      await trigger.click(); const backdropDialog = page.getByRole('dialog'); await backdropDialog.waitFor();
      const bounds = await backdropDialog.boundingBox();
      const viewport = page.viewportSize();
      assert(bounds && viewport, 'Native dialog has no rendered bounds or viewport');
      const centerX = Math.max(1, Math.min(viewport.width - 1, bounds.x + bounds.width / 2));
      const centerY = Math.max(1, Math.min(viewport.height - 1, bounds.y + bounds.height / 2));
      const outside = bounds.x > 1 ? [bounds.x / 2, centerY]
        : bounds.y > 1 ? [centerX, bounds.y / 2]
          : bounds.x + bounds.width < viewport.width - 1 ? [(bounds.x + bounds.width + viewport.width) / 2, centerY]
            : bounds.y + bounds.height < viewport.height - 1 ? [centerX, (bounds.y + bounds.height + viewport.height) / 2] : null;
      assert(outside, 'Native dialog fills every backdrop edge; no outside dismissal point exists');
      await page.mouse.click(outside[0], outside[1]);
      await backdropDialog.waitFor({ state: 'detached' });
      assert(await trigger.evaluate((element) => document.activeElement === element), 'Backdrop dismissal failed to restore focus to Trailer trigger');
      assert(traffic.errors === 0 && traffic.failedAssets === 0, 'Dialog emitted a browser exception or broken built asset');
      return { trailerApiRequests: traffic.api, directMp4Requests: traffic.mp4, fallbackFrames: traffic.youtube };
    });
  } finally { await context.close(); activePage = null; }
}

let accepted = false;
try {
  assert(Number.isInteger(PORT) && PORT >= 1024 && PORT <= 65535 && ![8791, 8795].includes(PORT), 'Invalid or nonisolated browser QA port');
  if (args.includes('--fingerprint-only')) {
    print(`ARTIFACT ${JSON.stringify(await fingerprint())}`);
  } else {
    assert(/^[a-f0-9]{64}$/.test(EXPECTED), 'Requires main-owned frozen artifact SHA256 via --expect-artifact; no build or inferred freeze is allowed');
    artifact = await fingerprint(); assert(artifact.sha256 === EXPECTED, 'Frozen artifact does not match the main-provided fingerprint');
    print(`ARTIFACT ${JSON.stringify(artifact)}`);
    assert((await stat(TEMP)).isDirectory(), 'Approved temporary parent is absent');
    directory = await mkdtemp(join(TEMP, 'lumora-trailer-qa-'));
    await check('artifact has no embedded private runtime defaults', sanitizedDefaults);
    await check('locally generated original H264 480p/720p test fixtures', makeMedia);
    await check('isolated frozen production workerd with synthetic public metadata', startRuntime);
    browser = await chromium.launch();
    if (!DIALOG_ONLY) {
      await hoverCase();
      await guard('reduced motion', { reducedMotion: true });
      await guard('data saver', { saveData: true });
      await guard('slow 2G', { effectiveType: 'slow-2g' });
      await guard('coarse pointer on mobile', { coarse: true });
    }
    await dialogCase(PRIMARY); await dialogCase(FALLBACK, true);
    await check('Worker never fetched MP4 bytes or Supabase and artifact remained frozen', async () => {
      assert(![...deniedWorkerHosts].some((host) => /media-imdb\.com|supabase/i.test(host)), 'Worker attempted MP4 proxy fetch or Supabase dependency');
      assert(workerRequests.length > 0 && workerRequests.every((request) => !request.privateHeaders), 'Actual Bingr normalization was not exercised safely');
      assert((await fingerprint()).sha256 === EXPECTED, 'Main-owned artifact changed during acceptance');
      return { publicBingrMetadataRequests: workerRequests.length, runtimeErrorLogs: runtimeErrors };
    });
    accepted = true;
  }
} catch (error) {
  if (!results.some((entry) => entry.status === 'FAIL')) { results.push({ name: 'setup', status: 'FAIL', message: safeError(error) }); print(`FAIL setup: ${safeError(error)}`); }
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {}); await worker?.dispose().catch(() => {}); await mockAgent?.close().catch(() => {});
  if (fixtureServer) { fixtureServer.closeAllConnections(); await new Promise((done) => fixtureServer.close(done)); }
  if (directory) {
    await writeFile(join(directory, 'report.json'), JSON.stringify({ status: accepted ? (DIALOG_ONLY ? 'DIALOG_ONLY_PASS_NOT_FULL_ACCEPTANCE' : 'PASS') : 'FAIL', artifact, results,
      assumptions: { frozenBuiltArtifact: true, cspBypassed: false, media: 'Generated FFmpeg testsrc2 H264 patterns; direct browser IMDb URL fulfillment only', metadata: 'Invented loopback TMDB + mocked Bingr, no copyrighted title dataset', visibility: 'Document lifecycle event simulated through actual browser handler', productionAvailability: 'Not asserted; main verified real IMDb MP4/CORS separately' },
    }, null, 2));
    print(`REPORT ${join(directory, 'report.json')}`);
  }
  if (!args.includes('--fingerprint-only')) { print(`${DIALOG_ONLY ? 'DIALOG ONLY' : 'TRAILER ACCEPTANCE'} ${accepted ? 'PASS' : 'FAIL'} passed=${results.filter((item) => item.status === 'PASS').length} failed=${results.filter((item) => item.status === 'FAIL').length}`); process.exitCode = accepted ? 0 : 1; }
}
