// Harness only: existing OpenNext output, loopback TMDB, and licensed Angel One.
// No source/build/deploy changes, real credentials, production writes, or CSP bypass.
import { chromium } from 'playwright';
import { MockAgent, fetch as undiciFetch } from 'undici';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
function argument(name, fallback) {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
}
const PORT = Number(argument('--port', '8795'));
const VIEWPORTS = argument('--viewports', 'both');
const EXPECTED_ARTIFACT = argument('--expect-artifact', '');
const RUNTIME_ONLY = args.includes('--runtime-only');
const MANUAL_ONLY = args.includes('--manual-only');
const TITLES_ONLY = args.includes('--titles-only');
const TRACE_HYDRATION = args.includes('--trace-hydration');
const TRACE_SEQUENCE = args.includes('--trace-sequence');
const HYDRATION_TRACE_ONLY = TITLES_ONLY && TRACE_HYDRATION;
const TITLE_PASSES = Number(argument('--title-passes', '1'));
const SELECTED_VIEWPORTS = VIEWPORTS === 'both' ? ['desktop', 'mobile'] : [VIEWPORTS];
const TEMP_ROOT = process.platform === 'win32'
  ? 'C:\\Users\\ADHYAN~1\\AppData\\Local\\Temp\\kilo'
  : process.env.TMPDIR ?? '/tmp';
const ORIGIN = `http://127.0.0.1:${PORT}`;
const WATCH_PATH = '/watch/movie/fake-test-inception-27205';
const SURFACE = 'section[aria-label^="Player for"]';
const VIDEO = `${SURFACE} video`;
const FIXTURE_BASE = 'https://storage.googleapis.com/shaka-demo-assets/angel-one-hls/';
const MEDIA_PREFIX = '/__acceptance-media/';
const MEDIA_TIMEOUT = 35_000;
const UI_TIMEOUT = 15_000;
const results = [];
const assetCache = new Map();
const fixtureRequests = [];
const deniedWorkerHosts = new Set();
const runtimeLogs = [];
const hydrationFrames = [];
const titleBrowserErrors = [];
let reportDirectory;
let worker;
let tmdbServer;
let browser;
let mockAgent;
let artifact;
let activePage;
let activeTraffic;
let phase = 'setup';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function safeError(error) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/https?:\/\/[^\s"'<>)]*/gi, '<url-redacted>')
    .replace(/(?:Bearer\s+|(?:token|api_key|secret|signature|authorization)["'\s:=]+)[^\s,;"'}]+/gi, '<credential-redacted>')
    .split('\n')[0].slice(0, 1000);
}
function print(message) { process.stdout.write(`${message}\n`); }
async function until(fn, message, timeout = MEDIA_TIMEOUT) {
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
      const state = await diagnostics(activePage).catch(() => ({ unavailable: true }));
      print(`STATE ${JSON.stringify(state)}`);
      await writeFile(join(reportDirectory, 'failure-state.json'), JSON.stringify({ phase, state }, null, 2));
      await activePage.screenshot({ path: join(reportDirectory, 'failure.png'), fullPage: true }).catch(() => {});
    }
    throw error;
  }
}

async function fingerprint() {
  const paths = [];
  async function collect(path) {
    const info = await stat(path);
    if (info.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await collect(join(path, name));
    } else if (!path.endsWith('.map')) paths.push(path);
  }
  const output = join(ROOT, '.open-next');
  for (const name of ['worker.js', 'cloudflare', 'middleware', 'server-functions', 'assets', '.build']) {
    await collect(join(output, name));
  }
  const hash = createHash('sha256');
  let bytes = 0;
  for (const path of paths.sort()) {
    const content = await readFile(path);
    const name = relative(output, path).replaceAll('\\', '/');
    hash.update(name).update('\0').update(createHash('sha256').update(content).digest()).update('\0');
    bytes += content.length;
  }
  const init = await readFile(join(output, 'cloudflare', 'init.js'), 'utf8');
  const timestamp = Number(/__BUILD_TIMESTAMP_MS__:\s*(\d+)/.exec(init)?.[1]);
  const server = await readFile(join(output, 'server-functions', 'default', 'handler.mjs'));
  return {
    sha256: hash.digest('hex'), files: paths.length, bytes,
    serverSha256: createHash('sha256').update(server).digest('hex'),
    ...(Number.isFinite(timestamp) ? { builtAt: new Date(timestamp).toISOString() } : {}),
  };
}

const GENRES = {
  movie: [{ id: 28, name: 'Action' }, { id: 18, name: 'Drama' }, { id: 35, name: 'Comedy' }, { id: 16, name: 'Animation' }],
  tv: [{ id: 10759, name: 'Action & Adventure' }, { id: 18, name: 'Drama' }, { id: 35, name: 'Comedy' }, { id: 16, name: 'Animation' }],
};
const IDS = {
  movie: [27205, 155, 550, 157336, 603, 680, 13, 12, 862, 807, 238, 240, 278, 424, 497, 73, 101, 11, 1891, 1892, 329, 285, 22, 120],
  tv: [1399, 1396, 66732, 1398, 1402, 1668, 1412, 456, 60625, 1408, 2316, 1434],
};
const LISTS = Object.fromEntries(Object.entries(IDS).map(([type, ids]) => [type, ids.map((id, index) => ({
  id,
  [type === 'movie' ? 'title' : 'name']: id === 27205 ? 'FAKE TEST Inception' : `FAKE TEST ${type} ${id}`,
  [type === 'movie' ? 'original_title' : 'original_name']: `FAKE TEST original ${id}`,
  overview: 'Synthetic acceptance metadata, not a real synopsis. Playback is licensed Angel One, not this title.',
  [type === 'movie' ? 'release_date' : 'first_air_date']: '2026-01-01',
  original_language: ['en', 'hi', 'ta', 'te', 'ml', 'ja'][index % 6],
  origin_country: [index % 6 === 5 ? 'JP' : index % 6 ? 'IN' : 'US'],
  poster_path: null, backdrop_path: null,
  vote_average: 7.1, vote_count: 500, popularity: 50 - index,
  genre_ids: GENRES[type].map((genre) => genre.id), adult: false,
}))]));

function tmdbPayload(url) {
  const path = url.pathname.replace(/^\/3/, '');
  const genre = /^\/genre\/(movie|tv)\/list$/.exec(path);
  if (genre) return { genres: GENRES[genre[1]] };
  const list = /^\/(?:discover|trending|search)\/(movie|tv)(?:\/week)?$/.exec(path);
  if (list) {
    let items = LISTS[list[1]];
    const language = url.searchParams.get('with_original_language');
    const country = url.searchParams.get('with_origin_country');
    const query = url.searchParams.get('query');
    if (language) items = items.filter((item) => language.split('|').includes(item.original_language));
    if (country) items = items.filter((item) => item.origin_country.includes(country));
    if (query) items = items.filter((item) => JSON.stringify(item).toLowerCase().includes(query.toLowerCase()));
    const page = Number(url.searchParams.get('page') ?? 1);
    return { page, results: items.slice((page - 1) * 20, page * 20), total_results: items.length, total_pages: Math.ceil(items.length / 20) };
  }
  const detail = /^\/(movie|tv)\/(\d+)(?:\/(credits|external_ids|videos))?$/.exec(path);
  if (detail) {
    const [type, rawId, supplement] = detail.slice(1);
    const item = LISTS[type].find((entry) => entry.id === Number(rawId));
    if (!item) return null;
    const credits = { cast: [{ id: 6193, name: 'FAKE TEST Performer 6193', character: 'Synthetic fixture character', known_for_department: 'Acting', profile_path: null, order: 0 }], crew: [] };
    const external_ids = { imdb_id: null };
    const videos = { results: [] };
    if (supplement) return { credits, external_ids, videos }[supplement];
    return {
      ...item, genres: GENRES[type], credits, external_ids, videos, imdb_id: null,
      runtime: 1, episode_run_time: [1], production_countries: item.origin_country.map((code) => ({ iso_3166_1: code })),
      release_dates: { results: [{ iso_3166_1: 'US', release_dates: [{ certification: 'PG' }] }] },
      content_ratings: { results: [{ iso_3166_1: 'US', rating: 'TV-PG' }] },
      ...(type === 'tv' ? { seasons: [{ season_number: 1, name: 'FAKE TEST Season 1', overview: 'Synthetic season.', air_date: '2026-01-01', poster_path: null, episode_count: 2 }] } : {}),
    };
  }
  const season = /^\/tv\/1399\/season\/1$/.exec(path);
  if (season) return { id: 3624, season_number: 1, episodes: [63056, 63057].map((id, index) => ({ id, episode_number: index + 1, name: `FAKE TEST Episode ${index + 1}`, overview: 'Synthetic episode.', air_date: '2026-01-01', runtime: 1, still_path: null })) };
  return null;
}

async function startRuntime() {
  for (const key of Object.keys(process.env)) {
    if (!/^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|OS|USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP|HOMEDRIVE|HOMEPATH|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS)$/i.test(key)) delete process.env[key];
  }
  Object.assign(process.env, {
    NODE_ENV: 'production', WRANGLER_SEND_METRICS: 'false',
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false', CLOUDFLARE_INCLUDE_PROCESS_ENV: 'false',
  });
  tmdbServer = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    fixtureRequests.push({ path: url.pathname, method: request.method });
    if (request.method !== 'GET') { response.writeHead(405); response.end(); return; }
    const payload = tmdbPayload(url);
    response.writeHead(payload ? 200 : 404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(payload ?? { status_code: 34, status_message: 'Unknown synthetic TMDB route.' }));
  });
  await new Promise((done, reject) => { tmdbServer.once('error', reject); tmdbServer.listen(0, '127.0.0.1', done); });
  const fixtureOrigin = `http://127.0.0.1:${tmdbServer.address().port}`;
  const productionConfig = JSON.parse(await readFile(join(ROOT, 'wrangler.jsonc'), 'utf8'));
  const name = `lumora-acceptance-${PORT}-${process.pid}`;
  const configPath = join(reportDirectory, 'wrangler.jsonc');
  await writeFile(configPath, JSON.stringify({
    name, main: join(ROOT, '.open-next', 'worker.js'),
    compatibility_date: productionConfig.compatibility_date,
    compatibility_flags: productionConfig.compatibility_flags,
    assets: { directory: join(ROOT, '.open-next', 'assets'), binding: 'ASSETS' },
    services: [{ binding: 'WORKER_SELF_REFERENCE', service: name, remote: false }],
    vars: {
      NEXTJS_ENV: 'production', NODE_ENV: 'production', NEXT_PUBLIC_APP_NAME: 'Lumora', NEXT_PUBLIC_APP_URL: ORIGIN,
      NEXT_PUBLIC_SUPABASE_URL: '', NEXT_PUBLIC_SUPABASE_ANON_KEY: '', SUPABASE_SERVICE_ROLE_KEY: '',
      TMDB_API_BASE_URL: `${fixtureOrigin}/3`, TMDB_API_KEY: randomBytes(16).toString('hex'),
      VIDNEST_API_URL: '', VIDNEST_API_SECRET: randomBytes(32).toString('hex'), VIDNEST_CDN_BASE_URL: '',
      WYZIE_API_KEY: '', WYZIE_SUBTITLE_TOKEN_SECRET: '',
      ADSTERRA_KEY_LEADERBOARD: '', ADSTERRA_KEY_RECTANGLE: '', ADSTERRA_KEY_PREROLL: '',
    },
    dev: { ip: '127.0.0.1', port: PORT, inspector_port: 0 },
    observability: { enabled: false },
  }, null, 2));
  await writeFile(join(reportDirectory, '.dev.vars'), '');
  await writeFile(join(reportDirectory, '.env'), '');
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  const allowed = new Set([new URL(fixtureOrigin).host, new URL(ORIGIN).host]);
  mockAgent.enableNetConnect((host) => {
    const permitted = allowed.has(host);
    if (!permitted) deniedWorkerHosts.add(host);
    return permitted;
  });
  const { unstable_startWorker } = await import('wrangler');
  worker = await unstable_startWorker({
    config: configPath,
    dev: {
      remote: false, persist: false, watch: false, liveReload: false, logLevel: 'none',
      outboundService: (request) => undiciFetch(request, { dispatcher: mockAgent, redirect: 'manual' }),
      structuredLogsHandler: (log) => {
        if (log.level === 'error') runtimeLogs.push({ level: 'error' });
      },
    },
  });
  let readyTimer;
  try {
    await Promise.race([worker.ready, new Promise((_, reject) => { readyTimer = setTimeout(() => reject(new Error('isolated workerd startup exceeded 45 seconds')), 45_000); })]);
  } finally { clearTimeout(readyTimer); }
  const runtimeUrl = await worker.url;
  assert(runtimeUrl.port === String(PORT), 'Wrangler did not use the isolated requested port');
  return { compatibilityDate: productionConfig.compatibility_date, compatibilityFlags: productionConfig.compatibility_flags };
}

function attributes(line) {
  return Object.fromEntries([...line.slice(line.indexOf(':') + 1).matchAll(/([A-Z0-9-]+)=(?:"([^"]*)"|([^,]*))(?:,|$)/g)]
    .map((match) => [match[1], match[2] ?? match[3]]));
}
function serialize(tag, values) {
  const raw = new Set(['BANDWIDTH', 'AVERAGE-BANDWIDTH', 'RESOLUTION', 'FRAME-RATE', 'TYPE', 'DEFAULT', 'AUTOSELECT', 'FORCED']);
  return `${tag}:${Object.entries(values).map(([key, value]) => `${key}=${raw.has(key) ? value : `"${value}"`}`).join(',')}`;
}
function safeAssetUrl(uri, base = FIXTURE_BASE) {
  const url = new URL(uri, base);
  assert(url.href.startsWith(FIXTURE_BASE) && !url.username && !url.password && !url.search && !url.hash,
    'HLS fixture attempted to leave the licensed asset directory');
  return url.href;
}
function mediaUrl(uri, base) {
  return `${ORIGIN}${MEDIA_PREFIX}${Buffer.from(safeAssetUrl(uri, base)).toString('base64url')}`;
}
function rewritePlaylist(text, base) {
  return text.split(/\r?\n/).map((line) => {
    if (!line.trim() || line.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${mediaUrl(uri, base)}"`);
    return mediaUrl(line.trim(), base);
  }).join('\n');
}
async function asset(url) {
  url = safeAssetUrl(url);
  if (!assetCache.has(url)) {
    assetCache.set(url, (async () => {
      let response;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try { response = await fetch(url, { signal: AbortSignal.timeout(20_000), redirect: 'error' }); break; }
        catch (error) { if (attempt === 2) throw new Error(`licensed fixture transport failed (${error.cause?.code ?? error.name}); no application availability result`); }
      }
      assert(response.ok, `licensed fixture HTTP ${response.status}; no application availability result`);
      const body = Buffer.from(await response.arrayBuffer());
      assert(body.length <= 8 * 1024 * 1024, 'fixture resource exceeds the test-only size cap');
      return { body, contentType: response.headers.get('content-type') ?? 'application/octet-stream' };
    })());
  }
  return assetCache.get(url);
}
async function makeStreams() {
  const masterUrl = `${FIXTURE_BASE}hls.m3u8`;
  const text = (await asset(masterUrl)).body.toString('utf8');
  assert(text.startsWith('#EXTM3U'), 'licensed fixture root is not HLS');
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const media = lines.filter((line) => line.startsWith('#EXT-X-MEDIA:')).map(attributes);
  const variants = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].startsWith('#EXT-X-STREAM-INF:')) continue;
    const attrs = attributes(lines[index]);
    const [width, height] = attrs.RESOLUTION.split('x').map(Number);
    variants.push({ attrs, width, height, uri: safeAssetUrl(lines[index + 1], masterUrl) });
  }
  return [240, 480, 576].map((height, index) => {
    const variant = variants.find((entry) => entry.height === height);
    assert(variant, `licensed asset lacks its actual ${height}p rendition`);
    const audioLanguages = index === 1 ? ['en', 'de'] : ['en'];
    const retained = media.filter((entry) => entry.TYPE === 'AUDIO' && audioLanguages.includes(entry.LANGUAGE) && entry.CHANNELS === '2');
    assert(retained.length === audioLanguages.length, 'licensed asset lacks the required genuine audio renditions');
    const group = `acceptance-audio-${index}`;
    const manifest = ['#EXTM3U', '#EXT-X-VERSION:6', ...retained.map((entry, trackIndex) => serialize('#EXT-X-MEDIA', {
      ...entry, 'GROUP-ID': group, URI: mediaUrl(entry.URI, masterUrl),
      DEFAULT: trackIndex === 0 ? 'YES' : 'NO', AUTOSELECT: 'YES',
    })), serialize('#EXT-X-STREAM-INF', { ...Object.fromEntries(Object.entries(variant.attrs).filter(([key]) => key !== 'SUBTITLES')), AUDIO: group }), mediaUrl(variant.uri, masterUrl), ''].join('\n');
    return {
      manifest,
      stream: {
        id: String(index), url: `${ORIGIN}/api/vidnest?token=fixture-stream-${index}`,
        expiresAt: Date.now() + 60 * 60 * 1000,
        startupLatencyMs: [900, 80, 150][index],
        qualities: [{ id: `real-${height}`, label: `${height}p`, width: variant.width, height, bitrateKbps: Math.round(Number(variant.attrs.BANDWIDTH) / 1000) }],
        audioTracks: retained.map((entry, trackIndex) => ({ id: `audio-${index}-${entry.LANGUAGE}`, label: entry.LANGUAGE === 'de' ? 'German' : 'English', language: entry.LANGUAGE, default: trackIndex === 0 })),
        subtitles: [],
      },
    };
  });
}

async function diagnostics(page) {
  const state = await page.evaluate((selector) => {
    const surface = document.querySelector(selector);
    const video = surface?.querySelector('video');
    const player = video?.player ?? video?.closest('.video-js')?.player;
    const levels = player?.qualityLevels?.();
    return {
      surface: Boolean(surface), videos: surface?.querySelectorAll('video').length ?? 0,
      updating: /Updating playback/.test(surface?.textContent ?? ''),
      playerError: player?.error?.()?.code ?? null,
      video: video ? { time: video.currentTime, duration: Number.isFinite(video.duration) ? video.duration : null,
        paused: video.paused, ready: video.readyState, width: video.videoWidth, height: video.videoHeight,
        seeking: video.seeking, rate: video.playbackRate, volume: video.volume, muted: video.muted,
        frames: video.getVideoPlaybackQuality?.().totalVideoFrames ?? -1 } : null,
      levels: Array.from({ length: levels?.length ?? 0 }, (_, index) => ({ height: levels[index].height, enabled: levels[index].enabled })),
      csp: (window.__acceptanceCsp ?? []).map((entry) => ({ directive: entry.directive, disposition: entry.disposition })),
      motion: (window.__acceptanceMotion ?? []).slice(-20),
      events: (window.__acceptanceEvents ?? []).slice(-35),
      choices: Array.from(surface?.querySelectorAll('select') ?? [], (select) => ({
        label: select.getAttribute('aria-label') ?? select.labels?.[0]?.textContent?.trim(),
        value: select.value, options: Array.from(select.options, (option) => ({ label: option.textContent?.trim(), value: option.value })),
      })),
    };
  }, SURFACE);
  return { ...state, traffic: activeTraffic ? { streams: activeTraffic.streams.map((entry) => entry.id), catalogs: activeTraffic.catalogs, unsignedRoots: activeTraffic.unsignedRoots, documents: activeTraffic.documents, subtitles: activeTraffic.subtitles, media: activeTraffic.media, navigations: activeTraffic.navigations, mutations: activeTraffic.mutations,
    pageErrors: activeTraffic.pageErrors, pageErrorDetails: activeTraffic.pageErrorDetails, failedAssets: activeTraffic.failedAssets } : null };
}
async function snapshot(video) {
  return video.evaluate((element) => ({ time: element.currentTime, duration: element.duration, paused: element.paused,
    ready: element.readyState, connected: element.isConnected, width: element.videoWidth, height: element.videoHeight,
    rate: element.playbackRate, volume: element.volume, muted: element.muted,
    frames: element.getVideoPlaybackQuality?.().totalVideoFrames ?? element.webkitDecodedFrameCount ?? -1 }));
}
async function playable(page) {
  const video = page.locator(VIDEO).first();
  await video.waitFor({ state: 'attached', timeout: MEDIA_TIMEOUT });
  await until(() => video.evaluate((element) => element.readyState >= 2 && element.videoWidth > 0), 'actual video never decoded playable media');
  return video;
}
async function decode(video, seconds = 1) {
  await video.evaluate(async (element) => {
    element.muted = true;
    await Promise.race([element.play(), new Promise((_, reject) => setTimeout(() => reject(new Error('play promise did not settle')), 10_000))]);
  });
  const before = await snapshot(video);
  return until(async () => {
    const state = await snapshot(video);
    return state.time >= before.time + seconds && state.frames > before.frames ? state : null;
  }, 'decoded frames and content time did not both advance');
}
async function seek(video, position) {
  await video.evaluate((element, target) => {
    element.pause();
    const player = element.player ?? element.closest('.video-js')?.player;
    if (player) player.currentTime(target); else element.currentTime = target;
  }, position);
  await until(() => video.evaluate((element, target) => element.paused && !element.seeking && Math.abs(element.currentTime - target) < 0.15, position), 'paused seek did not settle at the exact position');
}
async function consent(page) {
  const button = page.getByRole('button', { name: /load external player/i }).first();
  await button.waitFor({ state: 'visible' });
  await until(() => button.evaluate((element) => Object.keys(element).some((key) => key.startsWith('__reactProps') && typeof element[key]?.onClick === 'function')), 'consent button never hydrated', UI_TIMEOUT);
  await button.click();
  await button.waitFor({ state: 'hidden' });
}
async function panel(page, label) {
  await page.locator('.video-js').first().hover();
  const button = page.getByRole('button', { name: label, exact: true }).first();
  await button.waitFor({ state: 'visible' });
  const expanded = await button.getAttribute('aria-expanded');
  const pressed = await button.getAttribute('aria-pressed');
  if (expanded !== 'true' && pressed !== 'true') await button.click();
  await page.getByRole('region', { name: `${label} settings`, exact: true }).waitFor({ state: 'visible' });
  return page.getByLabel(label, { exact: true }).and(page.locator('select'));
}
async function options(select) {
  return select.evaluate((element) => Array.from(element.options, (option) => ({ value: option.value, label: option.textContent?.trim() ?? '' })));
}
async function choose(page, label, value) {
  const select = ['Quality', 'Audio', 'Subtitles'].includes(label) ? await panel(page, label) : (await panel(page, 'Settings'), page.getByLabel(label, { exact: true }).and(page.locator('select')));
  await select.selectOption(value);
  await until(async () => await select.inputValue() === value, `${label} did not retain the manual choice`, UI_TIMEOUT);
}
async function settled(page, video, before, paused, height) {
  await until(async () => {
    const state = await snapshot(video);
    return state.ready >= 2 && state.paused === paused && Math.abs(state.time - before.time) <= (paused ? 0.3 : 4)
      && Math.abs(state.rate - before.rate) < 0.01 && Math.abs(state.volume - before.volume) < 0.01 && state.muted === before.muted;
  }, 'source switch lost position, pause/play, rate, volume, or muted state');
  await page.locator('.lumora-player-switch-status').waitFor({ state: 'hidden', timeout: MEDIA_TIMEOUT });
  const preserved = await snapshot(video);
  assert(preserved.paused === paused && Math.abs(preserved.time - before.time) <= (paused ? 0.3 : 4)
    && Math.abs(preserved.rate - before.rate) < 0.01 && Math.abs(preserved.volume - before.volume) < 0.01
    && preserved.muted === before.muted, 'settled source did not retain the original playback state');
  await decode(video, 0.6);
  if (height) await until(async () => (await snapshot(video)).height === height, `selected quality never decoded its actual ${height}p raster`);
  const decoded = await snapshot(video);
  assert(decoded.frames > preserved.frames && decoded.time >= preserved.time + 0.6, 'switched stream did not advance real decoded frames and time');
  // The decode probe intentionally plays/mutes; undo only those test-induced changes.
  if (paused) await seek(video, before.time);
  await video.evaluate((element, muted) => { element.muted = muted; }, before.muted);
  return { preserved, decoded, advanced: Number((decoded.time - preserved.time).toFixed(3)), decodedFrames: decoded.frames - preserved.frames };
}

function viewportOptions(viewport) {
  return { bypassCSP: false, serviceWorkers: 'block', viewport: viewport === 'mobile' ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    ...(viewport === 'mobile' ? { isMobile: true, hasTouch: true } : {}) };
}

async function layout(page, selector) {
  const bounds = await page.evaluate((target) => {
    const rect = document.querySelector(target)?.getBoundingClientRect();
    return { viewportWidth: innerWidth, documentWidth: document.documentElement.scrollWidth,
      left: rect?.left, right: rect?.right, width: rect?.width };
  }, selector);
  assert(bounds.width > 0 && bounds.left >= -1 && bounds.right <= bounds.viewportWidth + 1
    && bounds.documentWidth <= bounds.viewportWidth + 1, 'responsive content overflows the viewport');
  return bounds;
}
async function checkpoint(page, position) {
  return page.evaluate((target) => {
    try {
      const entries = JSON.parse(localStorage.getItem('lumora:playback-checkpoints:v1') ?? '[]');
      return entries.some((entry) => entry.viewerKey === 'guest' && entry.mediaKey.includes('27205')
        && Math.abs(entry.positionSeconds - target) < 0.15 && Number.isFinite(entry.updatedAt));
    } catch { return false; }
  }, position);
}
async function reloadAt(page, video, position) {
  await seek(video, position);
  await until(() => checkpoint(page, position), 'local guest checkpoint did not synchronously record the seek');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await consent(page);
  const restored = await playable(page);
  await until(async () => Math.abs((await snapshot(restored)).time - position) < 0.15, 'hard reload did not restore the exact latest checkpoint');
  return restored;
}

async function browserCase(streams, viewport, opaqueAudio) {
  const name = `${viewport}/${opaqueAudio ? 'numbered-audio' : 'manual-quality'}`;
  const context = await browser.newContext(viewportOptions(viewport));
  const traffic = { streams: [], catalogs: 0, unsignedRoots: 0, documents: [], subtitles: 0, media: 0, navigations: 0, mutations: 0, external: 0, pageErrors: [], pageErrorDetails: [], failedAssets: [] };
  activeTraffic = traffic;
  let released = false;
  let release;
  const gate = new Promise((done) => { release = () => { released = true; done(); }; });
  await context.addInitScript(() => {
    window.__acceptanceCsp = [];
    window.__acceptanceEvents = [];
    document.addEventListener('securitypolicyviolation', (event) => window.__acceptanceCsp.push({ directive: event.effectiveDirective, disposition: event.disposition, probe: event.blockedURI.includes('lumora-acceptance.invalid') }));
    for (const type of ['loadstart', 'loadedmetadata', 'canplay', 'playing', 'pause', 'seeking', 'seeked', 'emptied', 'error']) {
      document.addEventListener(type, (event) => {
        if (!(event.target instanceof HTMLVideoElement)) return;
        const video = event.target;
        window.__acceptanceEvents.push({ type, time: Number(video.currentTime.toFixed(3)), ready: video.readyState, paused: video.paused });
        if (window.__acceptanceEvents.length > 250) window.__acceptanceEvents.shift();
      }, true);
    }
    try { if (!localStorage.getItem('lumora.consent.v1')) localStorage.setItem('lumora.consent.v1', JSON.stringify({ necessary: true, analytics: false, ads: false, decidedAt: '2026-01-01T00:00:00.000Z' })); } catch {}
  });
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    try {
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) { traffic.mutations += 1; await route.abort('blockedbyclient'); return; }
      if (url.origin !== ORIGIN) { traffic.external += 1; await route.abort('blockedbyclient'); return; }
      if (url.pathname.startsWith(MEDIA_PREFIX)) {
        traffic.media += 1;
        const original = Buffer.from(url.pathname.slice(MEDIA_PREFIX.length), 'base64url').toString('utf8');
        const resource = await asset(original);
        const hls = resource.body.subarray(0, 7).toString() === '#EXTM3U';
        let body = hls ? Buffer.from(rewritePlaylist(resource.body.toString('utf8'), original)) : resource.body;
        let status = 200;
        const headers = { 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' };
        const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers().range ?? '');
        if (range && !hls) {
          const total = body.length;
          const start = Number(range[1]);
          const end = Math.min(total - 1, range[2] ? Number(range[2]) : total - 1);
          if (start >= total) { await route.fulfill({ status: 416, headers: { 'Content-Range': `bytes */${total}` } }); return; }
          body = body.subarray(start, end + 1); status = 206; headers['Content-Range'] = `bytes ${start}-${end}/${total}`;
        }
        await route.fulfill({ status, headers, contentType: hls ? 'application/vnd.apple.mpegurl' : resource.contentType, body });
        return;
      }
      if (url.pathname === '/api/vidnest') {
        if (url.searchParams.get('metadata') === '1') {
          assert(url.searchParams.get('tmdbId') === '27205' && url.searchParams.get('type') === 'movie' && !url.searchParams.has('token'), 'nonfixture catalog request was blocked');
          traffic.catalogs += 1;
          traffic.documents.at(-1).catalogs += 1;
          await gate;
          await route.fulfill({ contentType: 'application/json', headers: { 'Cache-Control': 'no-store' }, body: JSON.stringify({ streams: streams.map(({ stream }) => ({ ...stream, ...(opaqueAudio ? { audioTracks: [] } : {}) })), recommendedStreamId: '1', expiresAt: Math.min(...streams.map(({ stream }) => stream.expiresAt)) }) });
        } else {
          if (!url.searchParams.has('token')) {
            traffic.unsignedRoots += 1;
            traffic.documents.at(-1).unsignedRoots += 1;
          }
          const id = /^fixture-stream-(\d+)$/.exec(url.searchParams.get('token') ?? '')?.[1];
          assert(id !== undefined && streams[Number(id)], 'playback repeated an unsigned resolver lookup or used a nonfixture capability');
          traffic.streams.push({ id, at: Date.now() });
          traffic.documents.at(-1).streams.push(id);
          await route.fulfill({ contentType: 'application/vnd.apple.mpegurl', headers: { 'Cache-Control': 'no-store', 'X-Vidnest-Stream-Id': id }, body: streams[Number(id)].manifest });
        }
        return;
      }
      if (url.pathname === '/api/subtitles') { traffic.subtitles += 1; await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ tracks: [], configured: false }) }); return; }
      await route.continue();
    } catch (error) {
      traffic.failedAssets.push(safeError(error));
      await route.abort('failed').catch(() => {});
    }
  });
  const page = await context.newPage();
  activePage = page;
  page.setDefaultTimeout(UI_TIMEOUT);
  page.setDefaultNavigationTimeout(60_000);
  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame()) return;
    traffic.navigations += 1;
  });
  page.on('request', (request) => {
    // Next's same-document history updates also emit framenavigated; only a
    // top-level document request starts a new per-page resolution budget.
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      traffic.documents.push({ catalogs: 0, unsignedRoots: 0, streams: [] });
    }
  });
  page.on('pageerror', (error) => {
    traffic.pageErrors.push(safeError(error));
    traffic.pageErrorDetails.push({
      arguments: [...error.message.matchAll(/args\[\]=([^&\s]+)/g)].map((match) => {
        try { return decodeURIComponent(match[1]); } catch { return ''; }
      }),
      stack: String(error.stack ?? '').replace(/https?:\/\/[^\s)]*/g, '<asset-url>').slice(0, 3000),
    });
  });
  page.on('response', (response) => {
    if (response.status() >= 400 && /\/_next\/.*\.(?:js|css)(?:\?|$)/.test(response.url())) traffic.failedAssets.push(`built asset HTTP ${response.status()}`);
  });
  page.on('console', (message) => {
    if (message.type() === 'error' && /React error #418|hydration failed|hydration mismatch|server rendered HTML/i.test(message.text())) traffic.pageErrors.push(safeError(message.text()));
  });
  let video;
  try {
    await check(`${name}: consent, single catalog lookup, and real decode`, async () => {
      const response = await page.goto(`${ORIGIN}${WATCH_PATH}`, { waitUntil: 'domcontentloaded' });
      assert(response?.ok(), 'actual built watch page did not return HTTP 200');
      assert(Boolean(response.headers()['content-security-policy']), 'actual watch page lacks enforcing CSP');
      await page.getByRole('heading', { name: 'FAKE TEST Inception', exact: true }).waitFor();
      await page.getByRole('button', { name: /load external player/i }).first().waitFor();
      await page.waitForTimeout(600);
      assert(traffic.streams.length === 0 && traffic.catalogs === 0 && traffic.media === 0, 'player media/catalog loaded before explicit consent');
      await consent(page);
      await until(() => traffic.catalogs === 1, 'initial catalog lookup did not start');
      assert(!released && traffic.streams.length === 0 && traffic.unsignedRoots === 0, 'Direct playback made a second resolution request before its catalog arrived');
      release();
      video = await playable(page);
      const decoded = await decode(video, 1);
      assert(decoded.width === streams[1].stream.qualities[0].width && decoded.height === 480, 'initial playback did not decode the fastest verified fixture stream');
      assert(traffic.streams[0]?.id === '1', 'initial source did not use the fastest catalog capability');
      assert(traffic.catalogs === 1 && traffic.unsignedRoots === 0, 'initial playback repeated source resolution');
      return { width: decoded.width, height: decoded.height, frames: decoded.frames, time: Number(decoded.time.toFixed(3)), catalogRequests: traffic.catalogs, unsignedResolverRequests: traffic.unsignedRoots, layout: await layout(page, SURFACE) };
    });
    await check(`${name}: CSP enforcement`, async () => {
      await page.evaluate(() => { const frame = document.createElement('iframe'); frame.hidden = true; frame.dataset.acceptanceProbe = ''; frame.src = 'https://lumora-acceptance.invalid/blocked'; document.body.appendChild(frame); });
      await until(() => page.evaluate(() => window.__acceptanceCsp.some((entry) => entry.probe && entry.disposition === 'enforce' && entry.directive === 'frame-src')), 'CSP did not actually block the forbidden frame', 5000);
      await page.locator('[data-acceptance-probe]').evaluate((element) => element.remove());
      assert(await page.evaluate(() => !window.__acceptanceCsp.some((entry) => entry.disposition === 'enforce' && /worker-src|media-src/.test(entry.directive))), 'CSP blocked a required decoder worker/media resource');
    });
    await choose(page, 'Playback speed', '1.25');
    await video.evaluate((element) => { const player = element.player ?? element.closest('.video-js')?.player; if (player) player.volume(0.23); else element.volume = 0.23; });
    if (!opaqueAudio) {
      await check(`${name}: manual Quality stays selected without rediscovery`, async () => {
        await seek(video, 12.75);
        const before = await snapshot(video);
        await choose(page, 'Quality', 'quality:240');
        const playback = await settled(page, video, before, true, 240);
        const requestCount = traffic.streams.length;
        const select = await panel(page, 'Quality');
        await until(async () => (await options(select)).length === 4, 'catalog did not expose Auto and three actual qualities');
        assert(await select.inputValue() === 'quality:240', 'catalog replaced the manual Quality choice');
        await page.waitForTimeout(1200);
        const after = await snapshot(video);
        assert(traffic.streams.length === requestCount && after.paused && Math.abs(after.time - before.time) < 0.15, 'recommendation changed manual source/time/pause');
        assert(traffic.catalogs === 1 && traffic.unsignedRoots === 0, 'manual Quality triggered source rediscovery');
        return { quality: '240p', position: after.time, automaticSwitches: traffic.streams.length - requestCount, playback };
      });
      await check(`${name}: paused manual Quality source switch`, async () => {
        await seek(video, 20.5);
        const before = await snapshot(video);
        const handle = await video.elementHandle();
        const count = traffic.streams.length;
        await choose(page, 'Quality', 'quality:576');
        await until(() => traffic.streams.slice(count).some((entry) => entry.id === '2'), 'manual 576p did not request its exact internal stream');
        const playback = await settled(page, video, before, true, 576);
        assert(await handle.evaluate((element) => element.isConnected), 'manual switch remounted/disposed the actual video');
        await handle.dispose();
        return { decoded: (await snapshot(video)).height, preservedPosition: before.time, preservedRate: before.rate, playback };
      });
    } else {
      await check(`${name}: honest numbered Audio stream choices`, async () => {
        release();
        const select = await panel(page, 'Audio');
        await until(async () => (await options(select)).filter((option) => /\b(?:audio\s+stream|stream)\s+[123]\b/i.test(option.label)).length === 3, 'three metadata-opaque streams are missing numbered Audio choices');
        const choices = (await options(select)).filter((option) => /\b(?:audio\s+stream|stream)\s+[123]\b/i.test(option.label));
        assert(!choices.some((option) => /hindi|japanese|german|spanish/i.test(option.label)), 'numbered stream choices invent languages');
        return { labels: choices.map((option) => option.label) };
      });
      for (const [number, paused] of [[1, true], [2, false], [3, true]]) {
        await check(`${name}: Audio stream ${number} preserves state and decodes`, async () => {
          await seek(video, 18.25);
          if (!paused) await decode(video, 0.3);
          const before = await snapshot(video);
          const handle = await video.elementHandle();
          const select = await panel(page, 'Audio');
          const choice = (await options(select)).find((option) => new RegExp(`\\b(?:audio\\s+stream|stream)\\s+${number}\\b`, 'i').test(option.label));
          assert(choice, 'numbered Audio option disappeared');
          await choose(page, 'Audio', choice.value);
          await until(() => traffic.streams.at(-1)?.id === String(number - 1), 'Audio choice did not use the intended stream');
          const playback = await settled(page, video, before, paused, [240, 480, 576][number - 1]);
          assert(await handle.evaluate((element) => element.isConnected), 'Audio stream change remounted/disposed the video');
          await handle.dispose();
          return { decodedHeight: (await snapshot(video)).height, pausedBefore: paused, savedPosition: before.time, playback };
        });
      }
    }
    await check(`${name}: no source reload loop or Updating playback freeze`, async () => {
      await page.locator('.lumora-player-switch-status').waitFor({ state: 'hidden' });
      const requests = traffic.streams.length;
      const navigations = traffic.navigations;
      const start = await snapshot(video);
      const end = await decode(video, 10);
      assert(traffic.streams.length === requests && traffic.navigations === navigations, 'uncommanded source/document reload loop detected');
      assert(!await page.locator('.lumora-player-switch-status').count(), 'Updating playback overlay returned during stable playback');
      assert(traffic.catalogs === 1 && traffic.unsignedRoots === 0, 'audio/quality changes repeated source resolution');
      return { advanced: Number((end.time - start.time).toFixed(3)), decodedFrames: end.frames - start.frames, extraRootRequests: traffic.streams.length - requests, catalogRequests: traffic.catalogs, unsignedResolverRequests: traffic.unsignedRoots };
    });
    await check(`${name}: seek and local checkpoint`, async () => {
      await seek(video, 24);
      await until(() => checkpoint(page, 24), 'forward seek checkpoint missing');
      await seek(video, 7.25);
      await until(() => checkpoint(page, 7.25), 'latest backward checkpoint missing');
      const state = await snapshot(video);
      assert(state.paused && Math.abs(state.time - 7.25) < 0.15, 'seek lost the paused state');
      return { position: state.time };
    });
    if (!opaqueAudio) {
      for (const [label, position] of [['early below 2 percent', 0.75], ['backward', 7.25], ['zero reset', 0]]) {
        await check(`${name}: hard reload ${label}`, async () => {
          if (label === 'backward') { await seek(video, 24); await until(() => checkpoint(page, 24), 'prior forward checkpoint missing'); }
          video = await reloadAt(page, video, position);
          const state = await snapshot(video);
          if (label.startsWith('early')) assert(position / state.duration < 0.02, 'early resume sample is not below 2 percent');
          return { restoredPosition: Number(state.time.toFixed(3)) };
        });
      }
      await decode(video, 1);
    }
    await check(`${name}: built assets, browser errors, and required CSP`, async () => {
      assert(traffic.failedAssets.length === 0, `fixture/built asset failures: ${traffic.failedAssets.join('; ')}`);
      assert(traffic.pageErrors.length === 0, `browser unhandled errors: ${traffic.pageErrors.join('; ')}`);
      assert(traffic.documents.length === (opaqueAudio ? 1 : 4) && traffic.documents.every((entry) => entry.catalogs === 1 && entry.unsignedRoots === 0), 'each consented page must use exactly one catalog and zero unsigned resolver lookups');
      assert(await page.evaluate(() => !window.__acceptanceCsp.some((entry) => entry.disposition === 'enforce' && /worker-src|media-src/.test(entry.directive))), 'media/worker CSP failure after state changes');
      return { mutationRequestsBlocked: traffic.mutations, mediaRequests: traffic.media, catalogRequests: traffic.catalogs, unsignedResolverRequests: traffic.unsignedRoots, subtitleRequests: traffic.subtitles, documents: traffic.documents, externalBrowserRequestsBlocked: traffic.external };
    });
    await writeFile(join(reportDirectory, `${viewport}-${opaqueAudio ? 'numbered-audio' : 'manual-quality'}-state.json`), JSON.stringify(await diagnostics(page), null, 2));
  } finally {
    release();
    await context.close();
    activePage = null;
    activeTraffic = null;
  }
}

async function motionCase(viewport, reducedMotion) {
  const context = await browser.newContext({ ...viewportOptions(viewport), reducedMotion: reducedMotion ? 'reduce' : 'no-preference' });
  const errors = [];
  try {
    await context.addInitScript(() => {
      window.__acceptanceMotion = [];
      try { localStorage.setItem('lumora.consent.v1', JSON.stringify({ necessary: true, analytics: false, ads: false, decidedAt: '2026-01-01T00:00:00.000Z' })); } catch {}
      document.addEventListener('animationstart', (event) => {
        if (!/^lumora-(content-enter|menu-enter|artwork-settle)$/.test(event.animationName) || window.__acceptanceMotion.length >= 128) return;
        const element = event.target;
        const style = getComputedStyle(element);
        const record = { name: event.animationName, className: element.className,
          scrollTarget: element.hasAttribute('data-acceptance-scroll-target'), durationMs: parseFloat(style.animationDuration) * 1000,
          iterations: style.animationIterationCount, samples: 0, minY: Infinity, maxY: -Infinity, minOpacity: 1, finished: false };
        window.__acceptanceMotion.push(record);
        const started = performance.now();
        const sample = () => {
          const current = getComputedStyle(element);
          const y = current.transform === 'none' ? 0 : new DOMMatrixReadOnly(current.transform).m42;
          record.minY = Math.min(record.minY, y);
          record.maxY = Math.max(record.maxY, y);
          record.minOpacity = Math.min(record.minOpacity, Number(current.opacity));
          record.samples += 1;
          if (!record.finished && !record.cancelled && element.isConnected && performance.now() - started < 2000) requestAnimationFrame(sample);
        };
        const finish = (end) => {
          if (end.target !== element || end.animationName !== event.animationName) return;
          record.finished = end.type === 'animationend';
          record.cancelled = !record.finished;
          element.removeEventListener('animationend', finish);
          element.removeEventListener('animationcancel', finish);
        };
        element.addEventListener('animationend', finish);
        element.addEventListener('animationcancel', finish);
        sample();
      });
    });
    await context.route('**/*', (route) => new URL(route.request().url()).origin === ORIGIN
      && ['GET', 'HEAD', 'OPTIONS'].includes(route.request().method()) ? route.continue() : route.abort('blockedbyclient'));
    const page = await context.newPage();
    activePage = page;
    page.setDefaultTimeout(UI_TIMEOUT);
    page.setDefaultNavigationTimeout(60_000);
    page.on('pageerror', (error) => errors.push(safeError(error)));
    page.on('console', (message) => {
      if (message.type() === 'error' && /React error #418|hydration failed|hydration mismatch|server rendered HTML/i.test(message.text())) errors.push(safeError(message.text()));
    });
    page.on('response', (response) => {
      if (response.status() >= 400 && /\/_next\/.*\.(?:js|css)(?:\?|$)/.test(response.url())) errors.push(`built asset HTTP ${response.status()}`);
    });
    await check(`${viewport}: homepage ${reducedMotion ? 'reduced motion and accessible navigation' : 'visible entrance and scroll motion'}`, async () => {
      const response = await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' });
      assert(response?.ok() && response.headers()['content-security-policy'], 'homepage did not return HTTP 200 with enforcing CSP');
      await page.getByRole('link', { name: /FAKE TEST Inception/i }).first().waitFor();
      const next = page.getByRole('button', { name: 'Next trending title', exact: true });
      const trailer = page.getByRole('button', { name: 'Trailer', exact: true }).first();
      await until(() => trailer.evaluate((element) => Object.keys(element).some((key) => key.startsWith('__reactProps') && typeof element[key]?.onClick === 'function')), 'homepage controls never hydrated', UI_TIMEOUT);
      const links = await page.locator('a[href^="/title/"]').count();
      const bounds = await layout(page, '.hero-slide:not([inert]) .hero-title, .discovery-home > .discovery-hero .hero-title');
      let motion;
      if (reducedMotion) {
        motion = await page.evaluate(() => {
          const elements = [...document.querySelectorAll('.hero-title, .site-nav-link, .site-mobile-nav-link, .section-reveal, .shelf-item')];
          return { reduced: matchMedia('(prefers-reduced-motion: reduce)').matches, elements: elements.length,
            moving: elements.filter((element) => {
              const style = getComputedStyle(element);
              return style.animationName !== 'none' || style.transform !== 'none';
            }).length, pending: document.querySelectorAll('[data-reveal-state="pending"]').length,
            meaningfulAnimations: window.__acceptanceMotion.filter((entry) => entry.durationMs > 1).length };
        });
        assert(motion.reduced && motion.elements > 0 && motion.moving === 0 && motion.pending === 0 && motion.meaningfulAnimations === 0,
          'reduced motion left nonessential animation, transforms, or pending content');
        if (await next.count()) {
          const previous = await page.locator('.hero-slide:not([inert])').getAttribute('aria-label');
          await next.click();
          await until(async () => await page.locator('.hero-slide:not([inert])').getAttribute('aria-label') !== previous, 'reduced motion disabled manual carousel navigation', UI_TIMEOUT);
          motion.manualNavigation = 'carousel';
        } else {
          // Null artwork deliberately selects the application's single-Hero fallback.
          const explore = page.locator('.hero-info-link').first();
          const destination = await explore.getAttribute('href');
          assert(destination?.startsWith('/title/'), 'single Hero is missing its title navigation');
          await explore.click();
          await page.waitForURL(`${ORIGIN}${destination}`);
          await page.getByRole('heading', { name: 'FAKE TEST Inception', exact: true }).waitFor();
          motion.manualNavigation = 'single-hero-title-link';
        }
      } else {
        const entrance = await until(() => page.evaluate(() => {
          const hero = window.__acceptanceMotion.find((entry) => entry.className.includes('hero-title') && entry.finished && entry.maxY - entry.minY >= 8);
          const nav = window.__acceptanceMotion.find((entry) => entry.name === 'lumora-menu-enter' && entry.finished && entry.maxY - entry.minY >= 3);
          return hero && nav ? { hero, nav } : null;
        }), 'homepage/menu animation did not visibly move and finish', UI_TIMEOUT);
        assert(entrance.hero.minOpacity >= 0.99 && entrance.hero.iterations === '1' && entrance.nav.iterations === '1', 'primary text was hidden or entrance motion was not finite');
        await page.screenshot({ path: join(reportDirectory, `${viewport}-homepage.png`) });
        const target = page.locator('.shelf-item[data-reveal-state="pending"]').first();
        await target.waitFor({ state: 'attached' });
        await target.evaluate((element) => { element.dataset.acceptanceScrollTarget = ''; });
        await target.scrollIntoViewIfNeeded();
        const scroll = await until(() => page.evaluate(() => window.__acceptanceMotion.find((entry) => entry.scrollTarget && entry.finished && entry.maxY - entry.minY >= 8)),
          'offscreen card did not visibly reveal after scrolling', UI_TIMEOUT);
        assert(scroll.minOpacity >= 0.99 && scroll.iterations === '1', 'card reveal hid content or repeated indefinitely');
        const delays = await page.locator('.shelf-item').evaluateAll((elements) => [...new Set(elements.slice(0, 6).map((element) => getComputedStyle(element).getPropertyValue('--motion-delay').trim()))]);
        assert(delays.length > 1, 'visible cards have no staggered entrance timing');
        motion = { ...entrance, scroll, staggerDelays: delays };
      }
      await page.screenshot({ path: join(reportDirectory, `${viewport}-${reducedMotion ? 'reduced-motion' : 'scroll-motion'}.png`) });
      assert(errors.length === 0, `homepage browser errors: ${errors.join('; ')}`);
      return { syntheticTitleLinks: links, layout: bounds, unhandledBrowserErrors: 0, motion };
    });
  } finally {
    await context.close();
    activePage = null;
  }
}

const valueOptions = new Set(['--port', '--viewports', '--expect-artifact', '--title-passes']);
const flagOptions = new Set(['--runtime-only', '--manual-only', '--titles-only', '--trace-hydration', '--trace-sequence', '--fingerprint-only']);
for (let index = 0; index < args.length; index++) {
  if (valueOptions.has(args[index])) {
    assert(args[index + 1] && !args[index + 1].startsWith('--'), 'missing acceptance option value');
    index++;
  } else assert(flagOptions.has(args[index]), 'unknown acceptance option');
}
if (args.includes('--fingerprint-only')) {
  const current = await fingerprint();
  assert(!EXPECTED_ARTIFACT || EXPECTED_ARTIFACT === current.sha256, 'candidate artifact does not match --expect-artifact');
  await new Promise((done, reject) => process.stdout.write(`ARTIFACT ${JSON.stringify(current)}\nFINGERPRINT_ONLY_NOT_ACCEPTANCE\n`, (error) => error ? reject(error) : done()));
  process.exit(0);
}

let accepted = false;
try {
  assert(Number.isInteger(PORT) && PORT >= 1024 && PORT <= 65535 && PORT !== 8791, 'invalid/nonisolated port');
  assert(['both', 'desktop', 'mobile'].includes(VIEWPORTS), '--viewports must be both, desktop, or mobile');
  assert(!TRACE_SEQUENCE || HYDRATION_TRACE_ONLY, '--trace-sequence requires --titles-only and --trace-hydration');
  assert(Number.isInteger(TITLE_PASSES) && TITLE_PASSES >= 1 && TITLE_PASSES <= 12, 'title diagnostic passes must be between 1 and 12');
  assert((await stat(TEMP_ROOT)).isDirectory(), 'approved temporary parent is absent');
  reportDirectory = await mkdtemp(join(TEMP_ROOT, 'lumora-workerd-acceptance-'));
  artifact = await fingerprint();
  print(`ARTIFACT ${JSON.stringify(artifact)}`);
  assert(!EXPECTED_ARTIFACT || EXPECTED_ARTIFACT === artifact.sha256, 'candidate artifact does not match --expect-artifact');
  await check('sanitized embedded runtime defaults', async () => {
    const source = await readFile(join(ROOT, '.open-next', 'cloudflare', 'next-env.mjs'), 'utf8');
    const exports = /^export const (production|development|test) = (\{[^\r\n]*\});[ \t]*\r?$/gm;
    const matches = [...source.matchAll(exports)];
    assert(matches.length === 3 && !source.replace(exports, '').trim(), 'unexpected generated environment module shape');
    const allowed = new Set(['NEXT_PUBLIC_APP_NAME', 'NEXT_PUBLIC_APP_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY']);
    assert(matches.every((match) => Object.keys(JSON.parse(match[2])).every((key) => allowed.has(key))), 'private defaults remain embedded in the artifact');
    assert(matches.every((match) => ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'].every((key) => JSON.parse(match[2])[key] === '')), 'public authentication build defaults must be explicitly empty');
    return { modes: matches.map((match) => match[1]), privateDefaults: 0, publicAuthenticationDefaultsEmpty: true };
  });
  await check('isolated production workerd and raw TMDB normalization', async () => {
    const config = await startRuntime();
    const response = await fetch(`${ORIGIN}/api/catalog?type=movie&limit=24`);
    assert(response.ok, `built catalog API HTTP ${response.status}`);
    const catalog = await response.json();
    assert(catalog.titles?.some((title) => title.name === 'FAKE TEST Inception' && title.id === 'tmdb:movie:27205'), 'workerd did not normalize the loopback raw TMDB list');
    const detailResponse = await fetch(`${ORIGIN}/api/catalog?type=movie&slug=fake-test-inception-27205`);
    const detail = await detailResponse.json();
    assert(detailResponse.ok && detail.cast?.some((person) => person.name === 'FAKE TEST Performer 6193'), 'workerd did not normalize raw TMDB detail/cast');
    const tvResponse = await fetch(`${ORIGIN}/api/catalog?type=tv&slug=fake-test-tv-1399`);
    const tv = await tvResponse.json();
    assert(tvResponse.ok && tv.seasons?.[0]?.episodes?.length === 2, 'workerd did not normalize raw TMDB TV season/episodes');
    assert(fixtureRequests.some((request) => request.path === '/3/genre/movie/list') && fixtureRequests.some((request) => request.path === '/3/movie/27205'), 'fixture was not reached by actual worker HTTP fetches');
    return { ...config, movies: catalog.titles.length, cast: detail.cast.length, episodes: tv.seasons[0].episodes.length, supabaseBindingsPresent: false };
  });
  if (!RUNTIME_ONLY) {
    browser = await chromium.launch();
    for (const viewport of SELECTED_VIEWPORTS) {
    await check(`${viewport}: public movie and TV detail pages hydrate with authentication unconfigured`, async () => {
      const context = await browser.newContext(viewportOptions(viewport));
      const pageErrors = [];
      const rendered = [];
      try {
        await context.addInitScript(() => {
          try { localStorage.setItem('lumora.consent.v1', JSON.stringify({ necessary: true, analytics: false, ads: false, decidedAt: '2026-01-01T00:00:00.000Z' })); } catch {}
        });
        await context.route('**/*', (route) => new URL(route.request().url()).origin === ORIGIN ? route.continue() : route.abort('blockedbyclient'));
        const page = await context.newPage();
        activePage = page;
        page.setDefaultTimeout(UI_TIMEOUT);
        page.setDefaultNavigationTimeout(60_000);
        page.on('console', (message) => {
          if (message.type() === 'error' && /React error #418|hydration failed|hydration mismatch|server rendered HTML/i.test(message.text())) pageErrors.push({ message: safeError(message.text()) });
        });
        page.on('response', (response) => {
          if (response.status() >= 400 && /\/_next\/.*\.(?:js|css)(?:\?|$)/.test(response.url())) pageErrors.push({ message: `built asset HTTP ${response.status()}` });
        });
        if (TRACE_HYDRATION) {
          const debuggerSession = await context.newCDPSession(page);
          await debuggerSession.send('Debugger.enable');
          const chunks = join(ROOT, '.open-next', 'assets', '_next', 'static', 'chunks');
          const reactChunk = (await readdir(chunks)).find((name) => name.startsWith('4bd1b696-') && name.endsWith('.js'));
          assert(reactChunk, 'React DOM diagnostic chunk was not found');
          const reactSource = await readFile(join(chunks, reactChunk), 'utf8');
          const match = /function rD\([^)]*\)\{/.exec(reactSource);
          assert(match, 'Hydration diagnostic function was not found');
          const prefix = reactSource.slice(0, match.index + match[0].length);
          await debuggerSession.send('Debugger.setBreakpointByUrl', {
            url: `${ORIGIN}/_next/static/chunks/${reactChunk}`,
            lineNumber: prefix.split('\n').length - 1,
            columnNumber: prefix.length - prefix.lastIndexOf('\n') - 1,
          });
          debuggerSession.on('Debugger.paused', async (event) => {
            try {
              const frame = event.callFrames.find((entry) => entry.functionName === 'rD' || entry.functionName === 'throwOnHydrationMismatch');
              if (frame) {
                const result = await debuggerSession.send('Debugger.evaluateOnCallFrame', {
                  callFrameId: frame.callFrameId,
                  expression: `JSON.stringify((()=>{const shape=(value,depth=0)=>{if(value==null||typeof value==='boolean'||typeof value==='number')return value;if(typeof value==='string')return value.slice(0,600);if(depth>2)return {truncated:true};if(Array.isArray(value))return value.slice(0,10).map(item=>shape(item,depth+1));return {type:typeof value.type==='function'?value.type.name:typeof value.type==='string'?value.type:typeof value.type,className:value.props?.className,id:value.props?.id,children:shape(value.props?.children,depth+1)};};const chain=[];let f=arguments[0];for(let i=0;f&&i<16;i++,f=f.return){const p=f.pendingProps;chain.push({tag:f.tag,type:typeof f.type==='function'?f.type.name:typeof f.type==='string'?f.type:typeof f.type,className:p?.className,id:p?.id,childrenType:typeof p?.children,children:shape(p?.children),node:f.stateNode?.nodeName,html:f.stateNode?.outerHTML?.slice(0,1800)});}return {chain,body:document.body.innerHTML.slice(0,3500)};})())`,
                  returnByValue: true,
                });
                const observation = { viewport, path: new URL(page.url()).pathname, pass: Math.floor(rendered.length / 2) + 1,
                  frame: result.result?.value ? JSON.parse(result.result.value) : { unavailable: true }, serverCandidates: [] };
                for (const scope of frame.scopeChain.filter((entry) => entry.type === 'closure' || entry.type === 'local').slice(0, 3)) {
                  const properties = await debuggerSession.send('Runtime.getProperties', { objectId: scope.object.objectId, ownProperties: true, generatePreview: false });
                  for (const property of properties.result.filter((entry) => entry.value?.subtype === 'node').slice(0, 6)) {
                    const candidate = await debuggerSession.send('Runtime.callFunctionOn', {
                      objectId: property.value.objectId,
                      functionDeclaration: `function(){return {node:this.nodeName,text:this.nodeValue,html:this.outerHTML?.slice(0,2500),parent:this.parentElement?.outerHTML.slice(0,6000),previous:this.previousSibling?.outerHTML?.slice(0,1800)??this.previousSibling?.nodeValue,next:this.nextSibling?.outerHTML?.slice(0,1800)??this.nextSibling?.nodeValue};}`,
                      returnByValue: true,
                    });
                    observation.serverCandidates.push({ scope: scope.type, name: property.name, ...(candidate.result?.value ?? { unavailable: true }) });
                  }
                }
                hydrationFrames.push(observation);
                await writeFile(join(reportDirectory, 'hydration-frames.json'), JSON.stringify(hydrationFrames, null, 2));
                print(`HYDRATION_FRAME ${JSON.stringify(observation)}`);
              }
            } catch (error) {
              const observation = { viewport, path: new URL(page.url()).pathname, captureError: safeError(error) };
              hydrationFrames.push(observation);
              print(`HYDRATION_FRAME_CAPTURE_ERROR ${JSON.stringify(observation)}`);
            } finally {
              await debuggerSession.send('Debugger.resume').catch(() => {});
            }
          });
        }
        page.on('pageerror', (error) => {
          const detail = {
            path: new URL(page.url()).pathname,
            message: safeError(error),
            arguments: [...error.message.matchAll(/args\[\]=([^&\s]+)/g)].map((match) => {
              try { return decodeURIComponent(match[1]); } catch { return ''; }
            }),
            stack: String(error.stack ?? '').replace(/https?:\/\/[^\s)]*/g, '<asset-url>').slice(0, 3000),
          };
          pageErrors.push(detail);
          titleBrowserErrors.push(detail);
          print(`TITLE_BROWSER_ERROR ${JSON.stringify(detail)}`);
        });
        const titleCases = [
          ['/title/movie/fake-test-inception-27205', 'FAKE TEST Inception'],
          ['/title/tv/fake-test-tv-1399', 'FAKE TEST tv 1399'],
        ];
        for (const [path, name] of Array.from({ length: TITLE_PASSES }, () => titleCases).flat()) {
          const response = await page.goto(`${ORIGIN}${path}`, { waitUntil: 'domcontentloaded' });
          assert(response?.ok(), 'public detail route did not return HTTP 200');
          await page.getByRole('heading', { name, exact: true }).first().waitFor({ timeout: UI_TIMEOUT });
          await page.getByRole('link', { name: 'Play', exact: true }).first().waitFor({ timeout: UI_TIMEOUT });
          assert(await page.locator('main').getByText('Synthetic acceptance metadata, not a real synopsis.', { exact: false }).count() > 0,
            'public detail synopsis was lost behind an authentication failure');
          const trailer = page.getByRole('button', { name: 'Trailer', exact: true }).first();
          await until(() => trailer.evaluate((element) => Object.keys(element).some((key) => key.startsWith('__reactProps') && typeof element[key]?.onClick === 'function')), 'public detail controls never hydrated', UI_TIMEOUT);
          await page.waitForLoadState('networkidle');
          rendered.push({ path, layout: await layout(page, '#title-heading') });
          await page.screenshot({ path: join(reportDirectory, `${viewport}-title-${path.includes('/tv/') ? 'tv' : 'movie'}.png`) });
          if (HYDRATION_TRACE_ONLY) assert(pageErrors.length === 0 && hydrationFrames.length === 0, 'hydration trace stopped at the first mismatch; see hydration-frames.json and report.json');
        }
        assert(pageErrors.length === 0, `public detail pages emitted a browser rendering exception: ${pageErrors.map((entry) => entry.message).join('; ')}`);
        return { rendered, unhandledBrowserErrors: 0, authenticationConfigured: false };
      } finally {
        await context.close();
        activePage = null;
      }
    });
    if (!HYDRATION_TRACE_ONLY || TRACE_SEQUENCE) {
      await motionCase(viewport, false);
      await motionCase(viewport, true);
    }
    }
    if (!TITLES_ONLY) {
      const streams = await makeStreams();
      for (const viewport of SELECTED_VIEWPORTS) {
        await browserCase(streams, viewport, false);
        if (!MANUAL_ONLY) await browserCase(streams, viewport, true);
      }
    }
  }
  await check('candidate artifact unchanged throughout test', async () => {
    const after = await fingerprint();
    assert(after.sha256 === artifact.sha256, 'OpenNext artifact changed during testing; rebuild/retest required');
    return { sha256: after.sha256 };
  });
  accepted = true;
} catch (error) {
  if (!results.some((entry) => entry.status === 'FAIL')) {
    results.push({ name: phase, status: 'FAIL', message: safeError(error) });
    print(`FAIL ${phase}: ${safeError(error)}`);
  }
} finally {
  await browser?.close().catch(() => {});
  await worker?.dispose().catch(() => {});
  await mockAgent?.close().catch(() => {});
  if (tmdbServer) {
    tmdbServer.closeAllConnections();
    await new Promise((done) => tmdbServer.close(done));
  }
  const report = {
    status: accepted ? (RUNTIME_ONLY ? 'RUNTIME_ONLY_PASS_NOT_BROWSER_ACCEPTANCE'
      : HYDRATION_TRACE_ONLY ? 'HYDRATION_TRACE_NO_MISMATCH_CAPTURED_NOT_RELEASE_ACCEPTANCE'
        : TITLES_ONLY ? 'TITLES_ONLY_PASS_NOT_PLAYBACK_ACCEPTANCE'
         : MANUAL_ONLY ? 'MANUAL_ONLY_PASS_NOT_NUMBERED_AUDIO' : 'PASS') : 'FAIL',
    artifact, results, hydrationFrames, titleBrowserErrors,
    assumptions: {
      actualBuiltOpenNext: true, rawTmdb: 'loopback HTTP synthetic metadata, stable real IDs',
      media: 'licensed public Shaka Angel One; browser requests rewritten/intercepted same-origin',
      resolverApi: 'browser intercepted; real resolver/capability/proxy availability NOT verified',
      productionNetwork: 'separate root/variant/media evidence supplied by main; not asserted here',
      supabase: 'empty test bindings; browser mutations blocked; external worker egress denied',
      cspBypassed: false, nodeEnv: 'production', viewports: VIEWPORTS, port: PORT,
      titleHydrationPassesPerViewport: RUNTIME_ONLY ? 0 : TITLE_PASSES,
      normalAndReducedMotionTested: !RUNTIME_ONLY && (!HYDRATION_TRACE_ONLY || TRACE_SEQUENCE),
      hydrationSequenceDiagnostic: TRACE_SEQUENCE,
      numberedAudioTested: !RUNTIME_ONLY && !TITLES_ONLY && !MANUAL_ONLY,
    },
    fixtureHttpRequests: fixtureRequests, deniedWorkerHostCount: deniedWorkerHosts.size, runtimeErrorLogs: runtimeLogs.length,
  };
  if (reportDirectory) await writeFile(join(reportDirectory, 'report.json'), JSON.stringify(report, null, 2));
  print(`\n${RUNTIME_ONLY ? 'RUNTIME ONLY' : HYDRATION_TRACE_ONLY ? 'HYDRATION TRACE (NOT RELEASE ACCEPTANCE)' : TITLES_ONLY ? 'TITLES AND MOTION ONLY (NOT PLAYBACK ACCEPTANCE)' : MANUAL_ONLY ? 'MANUAL BROWSER ACCEPTANCE (NOT NUMBERED AUDIO)' : 'BROWSER ACCEPTANCE'} ${accepted ? 'PASS' : 'FAIL'} passed=${results.filter((entry) => entry.status === 'PASS').length} failed=${results.filter((entry) => entry.status === 'FAIL').length}`);
  if (reportDirectory) print(`REPORT ${join(reportDirectory, 'report.json')}`);
  process.exitCode = accepted ? 0 : 1;
}
