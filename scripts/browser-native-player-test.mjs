// Run only after the temporary test route/server and NativePlayer are ready.
// Every mutation is blocked; fixture GETs replace metadata and stream=N separately.
// No database setup, signed URL output, CSP bypass, or invented decoded 4K.
import { chromium } from 'playwright';
import { join } from 'node:path';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3100';
const WATCH_PATH = process.env.WATCH_PATH ?? '/watch/movie/inception-27205';
const MOBILE = process.env.VIEWPORT?.toLowerCase() === 'mobile';
const CATALOG_SIZE = Number(process.env.FIXTURE_STREAMS ?? 3);
const DEBUG_NETWORK = process.env.DEBUG_NETWORK === '1';
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR;
const CONTINUE_ON_FAILURE = process.env.CONTINUE_ON_FAILURE === '1';
const APP_ORIGIN = new URL(BASE_URL).origin;
const WATCH_URL = new URL(WATCH_PATH, BASE_URL).href;
const FIXTURE_URL = 'https://storage.googleapis.com/shaka-demo-assets/angel-one-hls/hls.m3u8';
const FIXTURE_ORIGIN = new URL(FIXTURE_URL).origin;
const SURFACE = 'section[aria-label^="Player for"]';
const VIDEO = `${SURFACE} video`;
const SETTINGS = '.lumora-player-settings';
const PRESENTATION = 'Lumora subtitle presentation';
const MEDIA_TIMEOUT = 45_000;
const UI_TIMEOUT = 20_000;
const results = [];
let phase = 'setup';

class AssertionFailure extends Error {}

function assert(condition, detail) {
  if (!condition) throw new AssertionFailure(detail);
}

function safeError(error) {
  return (error instanceof Error ? error.message : String(error))
    .split('\n')[0]
    .replace(/https?:\/\/[^\s)]+/gi, '<redacted>')
    .replace(/([?&](?:token|key|sig|signature)=)[^&\s)]+/gi, '$1<redacted>');
}

async function check(name, fn) {
  phase = name;
  try {
    const detail = await fn();
    results.push({ name, status: 'PASS' });
    process.stdout.write(`PASS  ${name}${detail ? ` (${detail})` : ''}\n`);
  } catch (error) {
    results.push({ name, status: 'FAIL' });
    console.error(`FAIL  ${name}: ${safeError(error)} [phase=${phase}]`);
    if (!CONTINUE_ON_FAILURE || name === 'Consent Gate And Nonblocking Catalog') throw error;
  }
}

async function until(fn, detail, timeout = MEDIA_TIMEOUT) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new AssertionFailure(detail);
}

function attributes(line) {
  return Object.fromEntries([...line.slice(line.indexOf(':') + 1)
    .matchAll(/([A-Z0-9-]+)=(?:"([^"]*)"|([^,]*))(?:,|$)/g)]
    .map((match) => [match[1], match[2] ?? match[3]]));
}

function serialize(tag, values) {
  const numeric = new Set(['BANDWIDTH', 'AVERAGE-BANDWIDTH', 'RESOLUTION', 'FRAME-RATE']);
  const unquoted = new Set(['TYPE', 'DEFAULT', 'AUTOSELECT', 'FORCED']);
  return `${tag}:${Object.entries(values).map(([key, value]) => (
    `${key}=${numeric.has(key) || unquoted.has(key) ? value : `"${value}"`}`
  )).join(',')}`;
}

function absoluteUri(uri, base) {
  const parsed = new URL(uri, base);
  assert(['https:', 'http:'].includes(parsed.protocol), 'fixture contains an unexpected URI scheme');
  return parsed.href;
}

async function loadFixture() {
  let response;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      response = await fetch(FIXTURE_URL, { signal: AbortSignal.timeout(20_000) });
      break;
    } catch (error) {
      if (attempt === 2) throw new Error(`public fixture fetch failed (${error.cause?.code ?? error.name})`);
    }
  }
  assert(response.ok, `public fixture manifest HTTP ${response.status}`);
  const text = await response.text();
  assert(text.trimStart().startsWith('#EXTM3U'), 'fixture is not HLS');
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const media = lines.filter((line) => line.startsWith('#EXT-X-MEDIA:')).map(attributes);
  const variants = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].startsWith('#EXT-X-STREAM-INF:')) continue;
    const attrs = attributes(lines[index]);
    const [width, height] = attrs.RESOLUTION.split('x').map(Number);
    const uri = lines[index + 1];
    assert(uri && !uri.startsWith('#'), 'variant is missing its child playlist');
    variants.push({ attrs, width, height, uri: absoluteUri(uri, response.url || FIXTURE_URL) });
  }
  return { media, variants, base: response.url || FIXTURE_URL };
}

async function loadSidecar(fixture) {
  const greek = fixture.media.find((track) => track.TYPE === 'SUBTITLES' && track.LANGUAGE === 'el');
  assert(greek, 'public asset has no genuine Greek subtitle rendition');
  const playlistUrl = absoluteUri(greek.URI, fixture.base);
  const playlist = await fetch(playlistUrl, { signal: AbortSignal.timeout(20_000) });
  assert(playlist.ok, 'public Greek subtitle playlist unavailable');
  const segments = (await playlist.text()).split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
  assert(segments.length >= 4, 'Greek fixture subtitle segment unavailable');
  // The real fourth segment has asset-global cue times around the tested 12s seek.
  const response = await fetch(absoluteUri(segments[3], playlistUrl), { signal: AbortSignal.timeout(20_000) });
  assert(response.ok, 'public Greek WebVTT unavailable');
  const text = await response.text();
  assert(text.trimStart().startsWith('WEBVTT') && text.includes('-->'), 'sidecar fixture must contain real WebVTT cues');
  return text;
}

// All fixtures use the same asset/timeline, actual 4:3 variants, and real media
// renditions. HLS group references are rewritten together with retained MEDIA.
function buildFixtures(fixture, count) {
  const definitions = count === 3 ? [
    { heights: [240], audio: ['en'], subtitles: ['en'] },
    { heights: [480], audio: ['en', 'de'], subtitles: ['fr'] },
    { heights: [576], audio: ['es'], subtitles: ['pt-BR'] },
  ] : [
    { heights: [240], audio: ['en'], subtitles: ['en'] },
    { heights: [480, 576], audio: ['en', 'de', 'es'], subtitles: ['fr', 'pt-BR'] },
  ];
  const labels = { en: 'English', de: 'German', es: 'Spanish', fr: 'French', 'pt-BR': 'Portuguese' };
  return definitions.map((definition, index) => {
    const id = String(index);
    const variants = definition.heights.map((height) => fixture.variants.find((variant) => variant.height === height));
    assert(variants.every(Boolean), 'public asset no longer has the required decoded resolutions');
    const lines = ['#EXTM3U', '#EXT-X-VERSION:6'];
    const tracks = (type, languages) => languages.map((language, trackIndex) => {
      const media = fixture.media.find((entry) => entry.TYPE === type && entry.LANGUAGE === language
        && (type !== 'AUDIO' || entry.CHANNELS === '2'));
      assert(media, `public fixture is missing ${type.toLowerCase()} ${language}`);
      const attrs = {
        ...media,
        URI: absoluteUri(media.URI, fixture.base),
        'GROUP-ID': `fixture-${type.toLowerCase()}-${id}`,
        NAME: labels[language],
        DEFAULT: trackIndex === 0 ? 'YES' : 'NO',
        AUTOSELECT: 'YES',
      };
      lines.push(serialize('#EXT-X-MEDIA', attrs));
      return {
        id: `${type.toLowerCase()}-${id}-${language}`,
        label: labels[language],
        language,
        ...(type === 'AUDIO' ? { default: trackIndex === 0 } : { kind: 'subtitles' }),
      };
    });
    const audioTracks = tracks('AUDIO', definition.audio);
    const subtitles = tracks('SUBTITLES', definition.subtitles);
    for (const variant of variants) {
      lines.push(serialize('#EXT-X-STREAM-INF', {
        ...variant.attrs,
        AUDIO: `fixture-audio-${id}`,
        SUBTITLES: `fixture-subtitles-${id}`,
      }), variant.uri);
    }
    const manifest = `${lines.join('\n')}\n`;
    const retainedMedia = lines.filter((line) => line.startsWith('#EXT-X-MEDIA:')).map(attributes);
    for (const line of lines.filter((entry) => entry.startsWith('#EXT-X-STREAM-INF:'))) {
      const variant = attributes(line);
      for (const type of ['AUDIO', 'SUBTITLES']) {
        assert(retainedMedia.some((entry) => entry.TYPE === type && entry['GROUP-ID'] === variant[type]),
          'filtered master contains a dangling MEDIA group');
      }
    }
    return {
      manifest,
      stream: {
        id,
        startupLatencyMs: [900, 80, 150][index],
        qualities: variants.map((variant) => ({
          id: `rendition-${id}-${variant.height}`,
          label: `${variant.height}p`,
          width: variant.width,
          height: variant.height,
          bitrateKbps: Math.round(Number(variant.attrs['AVERAGE-BANDWIDTH'] ?? variant.attrs.BANDWIDTH) / 1000),
        })),
        audioTracks,
        subtitles,
      },
    };
  });
}

function fixtureRequest(rawUrl) {
  const url = new URL(rawUrl);
  if (url.origin !== APP_ORIGIN || url.pathname !== '/api/vidnest' || url.searchParams.has('token')
    || !url.searchParams.has('tmdbId') || !url.searchParams.has('type')) return null;
  if (url.searchParams.get('metadata') === '1') return { kind: 'catalog', url };
  const stream = url.searchParams.get('stream');
  return stream === 'auto' ? { kind: 'manifest', stream: '0', automatic: true, url }
    : stream !== null && /^\d+$/.test(stream) ? { kind: 'manifest', stream, url } : null;
}

async function snapshot(video) {
  return video.evaluate((element) => ({
    time: element.currentTime,
    duration: element.duration,
    paused: element.paused,
    connected: element.isConnected,
    width: element.videoWidth,
    height: element.videoHeight,
    frames: element.getVideoPlaybackQuality?.().totalVideoFrames ?? element.webkitDecodedFrameCount ?? -1,
  }));
}

async function playable(page) {
  phase = 'native playable video';
  const video = page.locator(VIDEO).first();
  await video.waitFor({ state: 'attached', timeout: MEDIA_TIMEOUT });
  await until(async () => video.evaluate((element) => element.isConnected && element.readyState >= 2
    && element.videoWidth > 0 && element.videoHeight > 0), 'native video did not decode playable media');
  return video;
}

async function decode(video, seconds = 1) {
  phase = 'actual frame and time advance';
  await video.evaluate(async (element) => { element.muted = true; await element.play(); });
  const before = await snapshot(video);
  const after = await until(async () => {
    const state = await snapshot(video);
    return state.connected && state.time >= before.time + seconds && state.frames > before.frames ? state : null;
  }, 'playback failed to advance time and decoded frames');
  return after;
}

async function seek(video, seconds) {
  await video.evaluate((element, target) => {
    element.pause();
    const player = element.player ?? element.closest('.video-js')?.player;
    if (player) player.currentTime(target);
    else element.currentTime = target;
  }, seconds);
  await until(async () => {
    const state = await snapshot(video);
    return state.paused && Math.abs(state.time - seconds) < 0.35
      && await video.evaluate((element) => !element.seeking);
  }, 'paused seek did not settle');
}

async function consent(page, required = true) {
  const button = page.getByRole('button', { name: /load external player/i }).first();
  if (required) await button.waitFor({ state: 'visible', timeout: UI_TIMEOUT });
  if (await button.isVisible()) {
    // Visible streamed HTML is clickable before React installs the handler.
    await until(() => button.evaluate((element) => Object.keys(element).some((key) => key.startsWith('__reactProps')
      && typeof element[key]?.onClick === 'function')), 'player consent button did not hydrate', UI_TIMEOUT);
    await button.click();
    await button.waitFor({ state: 'hidden', timeout: UI_TIMEOUT });
  }
}

async function settings(page, open = true) {
  if (!open) {
    const active = page.locator('.lumora-player-toolbar button[aria-expanded="true"], .lumora-player-toolbar button[aria-pressed="true"]:not([aria-label="Stop casting"])').first();
    if (await active.count()) await active.click();
    await page.locator(SETTINGS).waitFor({ state: 'hidden' });
    return;
  }
  await openPanel(page, 'Settings');
}

async function openPanel(page, label) {
  await page.locator('.video-js').first().hover();
  const button = page.getByRole('button', { name: label, exact: true }).first();
  await button.waitFor({ state: 'visible' });
  const attribute = label === 'Settings' ? 'aria-expanded' : 'aria-pressed';
  if (await button.getAttribute(attribute) !== 'true') await button.click();
  await page.getByRole('region', { name: `${label} settings`, exact: true }).waitFor({ state: 'visible' });
}

function choiceSelect(page, label) {
  // Dedicated toolbar buttons have the same accessible names as their selects.
  return page.getByLabel(label, { exact: true }).and(page.locator('select'));
}

async function waitForChoices(page, label, minimum) {
  await openPanel(page, label);
  const select = choiceSelect(page, label);
  await until(async () => await select.count() === 1 && (await optionList(select)).length >= minimum,
    `${label} catalog choices did not load across streams`);
  return optionList(select);
}

async function toolbarControls(page) {
  for (const label of ['Quality', 'Audio', 'Subtitles', 'Cast']) {
    const button = page.getByRole('button', { name: label, exact: true }).first();
    assert(await button.isVisible(), `${label} dedicated control missing`);
    assert(await button.locator('svg').count() === 1 && (await button.innerText()).trim() === label,
      `${label} control must have its own icon and visible label`);
  }
  const button = page.getByRole('button', { name: 'Settings', exact: true }).first();
  assert(await button.isVisible() && await button.locator('svg').count() === 1 && !(await button.innerText()).trim(),
    'Settings must be an accessible icon-only gear');
}

async function optionList(select) {
  return select.evaluate((element) => Array.from(element.options, (option) => ({
    value: option.value, label: option.textContent?.trim() ?? '',
  })));
}

async function union(page) {
  phase = 'dedicated panels and catalog union';
  const qualities = await waitForChoices(page, 'Quality', 4);
  const audios = await waitForChoices(page, 'Audio', 3);
  const subs = await waitForChoices(page, 'Subtitles', 5);
  for (const height of [240, 480, 576]) {
    assert(qualities.some((entry) => entry.label === `${height}p`), `missing real ${height}p quality`);
  }
  assert(qualities.length === 4 && qualities.some((entry) => entry.value === 'auto'), 'qualities must be Auto plus three real distinct resolutions');
  assert(!qualities.some((entry) => /4k|2160|uhd/i.test(entry.label)), 'fixture must not claim a decoded 4K rendition');
  assert(audios.length === 3 && ['English', 'German', 'Spanish'].every((label) => audios.some((entry) => entry.label === label)),
    'audio union must contain three actual fixture languages without duplicates');
  assert(subs.length === 5 && subs.some((entry) => entry.value === 'off')
    && ['English', 'French', 'Portuguese', 'Greek'].every((label) => subs.some((entry) => entry.label === label)),
  'subtitle union must contain Off plus all HLS and genuine sidecar languages without presentation duplicates');
}

async function noDirectServers(page) {
  await settings(page);
  assert(await page.getByLabel('Server', { exact: true }).count() === 0,
    'catalog streams must not be presented as a separate native Server selector');
  assert(await choiceSelect(page, 'Source').count() === 0, 'external Source dropdown must be hidden during native playback');
  assert(await choiceSelect(page, 'Playback fallback').count() === 1, 'genuine embed fallback must be available inside the gear');
  for (const label of ['Playback fallback']) {
    const select = choiceSelect(page, label);
    if (!await select.count()) continue;
    const servers = await optionList(select);
    assert(servers.filter((entry) => /direct/i.test(entry.label)).length <= 1, 'multiple Direct Server options exposed');
    assert(!servers.some((entry) => /vidnest|stream\s*\d/i.test(entry.label)
      || /(?:^|[?&])stream=\d|^\d+$/.test(entry.value)), 'internal streams must not be public Source/fallback options');
  }
}

async function choose(page, label, value) {
  await openPanel(page, ['Quality', 'Audio', 'Subtitles'].includes(label) ? label : 'Settings');
  const select = choiceSelect(page, label);
  await select.selectOption(value);
  await until(async () => await select.inputValue() === value, `${label} UI did not retain selected option`);
}

async function switchStream(page, video, requests, label, value, expectedStream, paused, expectedHeight) {
  await seek(video, 22);
  if (!paused) await decode(video, 0.3);
  const before = await snapshot(video);
  const handle = await video.elementHandle();
  const count = requests.length;
  await choose(page, label, value);
  await until(() => requests.slice(count).some((entry) => entry.stream === String(expectedStream)),
    `${label} failed to request the required internal stream=${expectedStream}`);
  await playable(page);
  await until(async () => {
    const state = await snapshot(video);
    return state.paused === paused && Math.abs(state.time - before.time) <= (paused ? 0.75 : 4);
  }, `${label} stream switch lost current time or paused/playing state`);
  assert(await handle.evaluate((element) => element.isConnected), `${label} switch remounted/disposed the video instead of player.src`);
  const decoded = await decode(video, 0.7);
  if (expectedHeight) {
    try {
      await until(async () => (await snapshot(video)).height === expectedHeight, `${label} did not decode the selected real resolution`);
    } catch (error) {
      const state = await video.evaluate((element) => {
        const player = element.player ?? element.closest('.video-js')?.player;
        const levels = player?.qualityLevels?.();
        return { time: element.currentTime, duration: element.duration, paused: element.paused, width: element.videoWidth, height: element.videoHeight,
          levels: Array.from({ length: levels?.length ?? 0 }, (_, index) => ({ height: levels[index].height, enabled: levels[index].enabled })) };
      });
      throw new AssertionFailure(`${safeError(error)} ${JSON.stringify({ ...state, requestedStreams: requests.slice(count).map((entry) => entry.stream) })}`);
    }
  }
  assert(decoded.frames > 0, `${label} switched stream did not actually decode`);
  await video.evaluate((element) => element.pause());
  await handle.dispose();
}

async function assertMenuBounds(page, fullscreen = false, label = 'Settings') {
  await openPanel(page, label);
  const panel = page.locator(SETTINGS);
  const bounds = await panel.evaluate((element, inFullscreen) => {
    const rect = element.getBoundingClientRect();
    const root = inFullscreen ? document.fullscreenElement : element.closest('.video-js');
    const player = root?.getBoundingClientRect();
    let clipped = false;
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      const ancestorRect = ancestor.getBoundingClientRect();
      if (/(hidden|clip|scroll|auto)/.test(style.overflowX) && (rect.left < ancestorRect.left - 2 || rect.right > ancestorRect.right + 2)) clipped = true;
      if (/(hidden|clip|scroll|auto)/.test(style.overflowY) && (rect.top < ancestorRect.top - 2 || rect.bottom > ancestorRect.bottom + 2)) clipped = true;
      // Fullscreen is a top-layer element, not clipped by its old DOM ancestors.
      if (inFullscreen && ancestor === root) break;
    }
    return {
      contained: Boolean(root?.contains(element)), clipped,
      insidePlayer: Boolean(player && rect.left >= player.left - 2 && rect.right <= player.right + 2
        && rect.top >= player.top - 2 && rect.bottom <= player.bottom + 2),
      insideViewport: rect.left >= -2 && rect.top >= -2 && rect.right <= innerWidth + 2 && rect.bottom <= innerHeight + 2,
      overflowReachable: element.scrollHeight <= element.clientHeight + 2 || /(auto|scroll)/.test(getComputedStyle(element).overflowY),
      panel: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      player: player ? { x: player.x, y: player.y, width: player.width, height: player.height } : null,
      viewport: { width: innerWidth, height: innerHeight },
    };
  }, fullscreen);
  const valid = bounds.contained && bounds.insidePlayer && bounds.insideViewport && !bounds.clipped && bounds.overflowReachable;
  if (!valid && SCREENSHOT_DIR) await page.screenshot({
    path: join(SCREENSHOT_DIR, `native-player-${MOBILE ? 'mobile' : 'desktop'}-${CATALOG_SIZE}-${label.toLowerCase()}-failure.png`),
    fullPage: true, animations: 'disabled',
  });
  assert(valid, `${label} panel escapes player/viewport, is ancestor-clipped, or has inaccessible overflow ${JSON.stringify(bounds)}`);
  for (const control of label === 'Settings' ? ['Playback speed', 'Playback fallback'] : [label]) {
    const select = choiceSelect(page, control);
    await select.scrollIntoViewIfNeeded();
    const reachable = await select.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return Boolean(hit && (hit === element || element.contains(hit)));
    });
    assert(reachable, `${control} control cannot be reached inside the clipped/scrolling menu`);
    const colors = await select.evaluate((element) => {
      const style = getComputedStyle(element);
      const luminance = (color) => {
        const components = color.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [];
        if (components.length !== 3) return NaN;
        const linear = components.map((component) => {
          const channel = component / 255;
          return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        });
        return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
      };
      const foreground = luminance(style.color);
      const background = luminance(style.backgroundColor);
      return { darkScheme: style.colorScheme.includes('dark'), contrast: (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05) };
    });
    assert(colors.darkScheme && colors.contrast >= 4.5, `${control} loses dark native-control colors or readable contrast${fullscreen ? ' in fullscreen' : ''}`);
  }
}

async function assertSubtitleOffset(video, offset) {
  await until(async () => video.evaluate((element, { label, expected }) => {
    const player = element.player ?? element.closest('.video-js')?.player;
    const tracks = player?.textTracks?.();
    const presentation = Array.from({ length: tracks?.length ?? 0 }, (_, index) => tracks[index])
      .find((track) => track.label === label);
    const saved = window.__lumoraSmokeCues;
    if (!saved || !presentation?.cues?.length || presentation.mode !== 'showing' || saved.track.mode !== 'hidden') return false;
    return saved.cues.every(({ cue, start, end, text }) => {
      const clone = Array.from(presentation.cues).find((entry) => entry.text === text
        && Math.abs(entry.startTime - (start + expected)) < 0.02 && Math.abs(entry.endTime - (end + expected)) < 0.02);
      return cue.startTime === start && cue.endTime === end && clone && clone !== cue;
    });
  }, { label: PRESENTATION, expected: offset }), 'subtitle presentation offset drifted or source HLS cue timestamps changed');
}

async function checkpointMatches(page, seconds) {
  return page.evaluate((position) => {
    try {
      const entries = JSON.parse(localStorage.getItem('lumora:playback-checkpoints:v1') ?? '[]');
      return Array.isArray(entries) && entries.some((entry) => entry.viewerKey === 'guest'
        && typeof entry.mediaKey === 'string' && Number.isFinite(entry.positionSeconds)
        && Math.abs(entry.positionSeconds - position) < 0.15 && Number.isFinite(entry.updatedAt));
    } catch { return false; }
  }, seconds);
}

async function reloadAt(page, video, seconds) {
  await seek(video, seconds);
  await until(() => checkpointMatches(page, seconds), 'synchronous local guest checkpoint did not record the settled seek', UI_TIMEOUT);
  const session = await page.context().newCDPSession(page);
  await session.send('Network.enable');
  const navigation = page.waitForNavigation({ waitUntil: 'domcontentloaded' });
  await session.send('Page.reload', { ignoreCache: true });
  await navigation;
  await session.detach();
  // A hard reload recreates the explicit gate; wait for streamed SSR/hydration.
  await consent(page, true);
  let restoredVideo;
  try {
    restoredVideo = await playable(page);
  } catch (error) {
    const state = await page.evaluate((surfaceSelector) => {
      const surface = document.querySelector(surfaceSelector);
      const consentButton = Array.from(surface?.querySelectorAll('button') ?? []).find((button) => /load external player/i.test(button.textContent ?? ''));
      return {
        surface: Boolean(surface), videoCount: surface?.querySelectorAll('video').length ?? 0,
        consentStillPresent: Boolean(consentButton),
        unavailable: /No authorized source|temporarily unavailable/i.test(surface?.textContent ?? ''),
        loading: /Loading player/i.test(surface?.textContent ?? ''),
      };
    }, SURFACE);
    throw new AssertionFailure(`hard-reload player did not mount ${JSON.stringify(state)} (${safeError(error)})`);
  }
  await until(async () => Math.abs((await snapshot(restoredVideo)).time - seconds) < 0.15,
    'hard reload did not resume the exact local checkpoint');
  return restoredVideo;
}

let browser;
let context;
let releaseCatalog;
let completed = false;

try {
  assert(process.env.BYPASS_CSP !== '1', 'CSP bypass is forbidden for acceptance');
  assert(CATALOG_SIZE === 2 || CATALOG_SIZE === 3, 'FIXTURE_STREAMS must be 2 or 3');
  const asset = await loadFixture();
  const fixtures = buildFixtures(asset, CATALOG_SIZE);
  const sidecarVtt = await loadSidecar(asset);
  browser = await chromium.launch();
  context = await browser.newContext({
    serviceWorkers: 'block',
    viewport: MOBILE ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    ...(MOBILE ? { isMobile: true, hasTouch: true } : {}),
  });
  await context.addInitScript(() => {
    window.__lumoraCspViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      window.__lumoraCspViolations.push({ directive: event.effectiveDirective, blocked: event.blockedURI, disposition: event.disposition });
    });
    try {
      localStorage.setItem('lumora.consent.v1', JSON.stringify({ necessary: true, analytics: false, ads: false, decidedAt: '2026-01-01T00:00:00.000Z' }));
    } catch { /* Initial blank document can deny storage. */ }
  });
  const requests = [];
  const catalogs = [];
  const blockedMutations = [];
  const fixtureTraffic = [];
  const subtitleCatalogs = [];
  const sidecarRequests = [];
  const castSdkRequests = [];
  let catalogReleased = false;
  const catalogGate = new Promise((resolve) => { releaseCatalog = () => { catalogReleased = true; resolve(); }; });
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
      blockedMutations.push(request.method());
      await route.abort('blockedbyclient');
      return;
    }
    if (url.hostname === 'www.gstatic.com') {
      castSdkRequests.push(request.resourceType());
      await route.abort('blockedbyclient');
      return;
    }
    if (url.origin === APP_ORIGIN && url.pathname === '/api/subtitles') {
      if (url.searchParams.get('fixture') === 'angel-one-greek') {
        sidecarRequests.push('vtt');
        await route.fulfill({ status: 200, contentType: 'text/vtt', headers: { 'Cache-Control': 'no-store' }, body: sidecarVtt });
      } else {
        subtitleCatalogs.push('catalog');
        await route.fulfill({
          status: 200, contentType: 'application/json', headers: { 'Cache-Control': 'no-store' },
          body: JSON.stringify({ tracks: [{ id: 'fixture-greek', label: 'Greek', language: 'el', kind: 'subtitles',
            url: `${APP_ORIGIN}/api/subtitles?fixture=angel-one-greek` }] }),
        });
      }
      return;
    }
    // Fail closed for nonfixture local Vidnest GETs: never invoke the resolver.
    const info = fixtureRequest(request.url());
    if (url.origin === APP_ORIGIN && url.pathname === '/api/vidnest' && !info) {
      await route.abort('blockedbyclient');
      return;
    }
    if (!info) {
      if (url.origin === FIXTURE_ORIGIN) fixtureTraffic.push(request.resourceType());
      await route.continue();
      return;
    }
    if (info.kind === 'catalog') {
      catalogs.push({ released: catalogReleased });
      await catalogGate;
      const streams = fixtures.map(({ stream }) => {
        const manifestUrl = new URL(info.url.href);
        manifestUrl.searchParams.delete('metadata');
        manifestUrl.searchParams.set('stream', stream.id);
        return { ...stream, url: manifestUrl.href };
      });
      await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Cache-Control': 'no-store' }, body: JSON.stringify({ streams, recommendedStreamId: '1' }) });
    } else {
      requests.push({ stream: info.stream });
      const fixture = fixtures[Number(info.stream)];
      assert(fixture, 'player requested an out-of-catalog internal stream');
      await route.fulfill({ status: 200, contentType: 'application/vnd.apple.mpegurl', headers: { 'Cache-Control': 'no-store' }, body: fixture.manifest });
    }
  });
  const page = await context.newPage();
  page.setDefaultTimeout(UI_TIMEOUT);
  page.setDefaultNavigationTimeout(60_000);
  if (DEBUG_NETWORK) {
    page.on('console', (message) => {
      if (message.type() === 'error') process.stdout.write(`DEBUG browser: ${safeError(message.text())}\n`);
    });
    page.on('pageerror', (error) => process.stdout.write(`DEBUG page error: ${safeError(error)}\n`));
    page.on('requestfailed', (request) => {
      if (request.method() === 'GET' && new URL(request.url()).origin === FIXTURE_ORIGIN) {
        process.stdout.write(`DEBUG fixture request failed: ${safeError(request.failure()?.errorText ?? 'unknown')}\n`);
      }
    });
  }
  process.stdout.write(`RUN   ${MOBILE ? 'mobile 390x844' : 'desktop 1440x900'}, ${CATALOG_SIZE} distinct streams, CSP enforced\n`);

  let video;
  let automaticSwitch;
  await check('Consent Gate And Nonblocking Catalog', async () => {
    const response = await page.goto(WATCH_URL, { waitUntil: 'domcontentloaded' });
    assert(response?.ok(), 'WATCH_PATH is not a successful page');
    assert(Boolean(response.headers()['content-security-policy']), 'missing enforcing Content-Security-Policy header');
    await page.locator(SURFACE).first().waitFor({ state: 'visible' });
    await page.getByRole('button', { name: /load external player/i }).first().waitFor({ state: 'visible' });
    await page.waitForTimeout(750);
    assert(catalogs.length === 0 && requests.length === 0 && fixtureTraffic.length === 0 && subtitleCatalogs.length === 0
      && sidecarRequests.length === 0, 'catalog, subtitles, or media requested before explicit player consent');
    await consent(page);
    await until(() => catalogs.length === 1 && subtitleCatalogs.length === 1 && requests.some((entry) => entry.stream === '0'),
      'missing independent stream/subtitle metadata and initial stream=0 requests');
    video = await playable(page);
    const decoded = await decode(video, 1.5);
    if (DEBUG_NETWORK) process.stdout.write(`DEBUG initial decode ${decoded.width}x${decoded.height}\n`);
    assert(decoded.width === 320 && decoded.height === 240, 'initial fixture did not decode its actual 320x240 rendition');
    assert(!catalogReleased, 'metadata was not kept pending while initial playback decoded');
    assert(await page.getByText(/Advertisement .* video starts after this ad/i).count() === 0, 'ads=false did not bypass pre-roll');
    automaticSwitch = { before: await snapshot(video), at: Date.now(), requestCount: requests.length, handle: await video.elementHandle() };
    releaseCatalog();
    if (DEBUG_NETWORK) process.stdout.write('DEBUG catalog released\n');
    await union(page);
    return `${decoded.width}x${decoded.height}, frames advance before catalog response`;
  });

  await check('Enforced CSP', async () => {
    await page.evaluate(() => {
      const frame = document.createElement('iframe');
      frame.dataset.smokeCspProbe = '';
      frame.hidden = true;
      frame.src = 'https://lumora-csp-test.invalid/blocked';
      document.body.appendChild(frame);
    });
    const blocked = await until(() => page.evaluate(() => window.__lumoraCspViolations.some((entry) => entry.disposition === 'enforce'
      && entry.directive === 'frame-src' && entry.blocked.includes('lumora-csp-test.invalid'))),
    'CSP did not enforce a forbidden frame', 5_000);
    await page.locator('[data-smoke-csp-probe]').evaluate((element) => element.remove());
    assert(blocked, 'CSP probe unexpectedly permitted an external frame');
    assert(await page.evaluate(() => !window.__lumoraCspViolations.some((entry) => entry.disposition === 'enforce'
      && /worker-src|media-src/.test(entry.directive))), 'CSP blocked required player worker or media resources');
  });

  await check('Fastest Compatible Recommendation Preserves Playing Position', async () => {
    const { before, at, requestCount, handle } = automaticSwitch;
    await until(() => requests.slice(requestCount).some((entry) => entry.stream === '1'), 'catalog recommendation did not switch to fastest compatible fixture stream=1');
    await playable(page);
    await until(async () => {
      const state = await snapshot(video);
      return !state.paused && state.time >= before.time - 0.25 && state.time < before.time + (Date.now() - at) / 1000 + 1;
    }, 'automatic stream recommendation lost the playing state or current position');
    assert(await handle.evaluate((element) => element.isConnected), 'automatic recommendation remounted the native video');
    await until(async () => video.evaluate((element) => {
      const player = element.player ?? element.closest('.video-js')?.player;
      const tracks = player?.audioTracks?.();
      const enabled = Array.from({ length: tracks?.length ?? 0 }, (_, index) => tracks[index]).filter((track) => track.enabled);
      return enabled.length === 1 && enabled[0].language === 'en';
    }), 'automatic fastest selection discarded compatible English audio');
    await until(async () => {
      const state = await snapshot(video);
      return CATALOG_SIZE === 3 ? state.height === 480 : [480, 576].includes(state.height);
    }, 'recommended stream did not decode its actual advertised raster');
    const decoded = await decode(video, 0.7);
    assert(CATALOG_SIZE === 3 ? decoded.height === 480 : [480, 576].includes(decoded.height), 'recommended stream did not decode its actual advertised raster');
    await handle.dispose();
    return 'fixture startup-latency ranking, not a throughput benchmark';
  });

  await check('One Direct Source, No Internal Servers', () => noDirectServers(page));
  await check('Dedicated Icon Label Controls And Icon Only Gear', () => toolbarControls(page));
  await check('Real Quality Audio Subtitle Union', () => union(page));

  await check('Paused Quality Switch Preserves Time And Decodes', async () => {
    await choose(page, 'Quality', 'quality:240');
    await playable(page);
    await until(async () => (await snapshot(video)).height === 240, 'quality switch setup did not settle on the actual 240p stream');
    await switchStream(page, video, requests, 'Quality', 'quality:576', CATALOG_SIZE - 1, true, 576);
    await choose(page, 'Quality', 'quality:240');
    await playable(page);
    await until(async () => (await snapshot(video)).height === 240, 'lower quality did not return to the actual 240p stream');
  });

  await check('Quality Auto Enables Current Real Renditions', async () => {
    const count = requests.length;
    await choose(page, 'Quality', 'auto');
    await until(() => requests.slice(count).some((entry) => entry.stream === '1'), 'Quality Auto did not choose fastest compatible fixture stream=1');
    await playable(page);
    await until(async () => video.evaluate((element, expectedHeights) => {
      const player = element.player ?? element.closest('.video-js')?.player;
      const list = player?.qualityLevels?.();
      const levels = Array.from({ length: list?.length ?? 0 }, (_, index) => list[index]);
      return levels.length === expectedHeights.length && expectedHeights.every((height) => levels.some((level) => level.height === height && level.enabled));
    }, CATALOG_SIZE === 3 ? [480] : [480, 576]), 'Auto did not enable every actual fastest-current-stream rendition');
  });

  await check('Playing Audio Switch Preserves Time And Decodes', async () => {
    await choose(page, 'Quality', 'quality:240');
    await choose(page, 'Audio', 'en::');
    await playable(page);
    await switchStream(page, video, requests, 'Audio', 'de::', 1, false);
    await until(async () => video.evaluate((element) => {
      const player = element.player ?? element.closest('.video-js')?.player;
      const list = player?.audioTracks?.();
      const active = Array.from({ length: list?.length ?? 0 }, (_, index) => list[index]).filter((track) => track.enabled);
      return active.length === 1 && active[0].language === 'de';
    }), 'German UI selection did not activate the actual German media track');
  });

  await check('Paused Subtitle Switch Preserves Time And Decodes', async () => {
    await choose(page, 'Subtitles', 'en::');
    await playable(page);
    await switchStream(page, video, requests, 'Subtitles', 'pt-br::', CATALOG_SIZE - 1, true);
  });

  await check('Subtitle Delay Advance Reset Only Change Cloned Cues', async () => {
    await seek(video, 12);
    await until(async () => video.evaluate((element, label) => {
      const player = element.player ?? element.closest('.video-js')?.player;
      const list = player?.textTracks?.();
      const tracks = Array.from({ length: list?.length ?? 0 }, (_, index) => list[index]);
      const original = tracks.find((track) => track.label !== label && track.language?.toLowerCase() === 'pt-br'
        && ['subtitles', 'captions'].includes(track.kind));
      const presentation = tracks.find((track) => track.label === label);
      const cues = Array.from(original?.cues ?? []).filter((cue) => cue.startTime >= 1).slice(0, 3);
      if (!cues.length || !presentation?.cues?.length) return false;
      window.__lumoraSmokeCues = { track: original, cues: cues.map((cue) => ({ cue, start: cue.startTime, end: cue.endTime, text: cue.text })) };
      return true;
    }, PRESENTATION), 'HLS source and cloned presentation subtitle cues were not loaded');
    await openPanel(page, 'Subtitles');
    const delay = page.getByRole('button', { name: 'Delay subtitles by 0.25 seconds', exact: true });
    const advance = page.getByRole('button', { name: 'Advance subtitles by 0.25 seconds', exact: true });
    const reset = page.getByRole('button', { name: 'Reset subtitle timing', exact: true });
    await assertSubtitleOffset(video, 0);
    await delay.click();
    await assertSubtitleOffset(video, 0.25);
    await advance.click();
    await assertSubtitleOffset(video, 0);
    await advance.click();
    await assertSubtitleOffset(video, -0.25);
    await reset.click();
    await assertSubtitleOffset(video, 0);
    await choose(page, 'Subtitles', 'off');
    assert(await video.evaluate((element) => {
      const player = element.player ?? element.closest('.video-js')?.player;
      const list = player?.textTracks?.();
      return Array.from({ length: list?.length ?? 0 }, (_, index) => list[index])
        .filter((track) => ['subtitles', 'captions'].includes(track.kind)).every((track) => track.mode !== 'showing');
    }), 'Subtitles Off leaves a subtitle or cloned presentation visible');
  });

  await check('Subtitle API Loads Real Same Asset VTT', async () => {
    const count = requests.length;
    assert(sidecarRequests.length === 0, 'unselected subtitle sidecars must not be eagerly fetched');
    await choose(page, 'Subtitles', 'el::');
    await seek(video, 12.5);
    await until(async () => video.evaluate((element) => {
      const player = element.player ?? element.closest('.video-js')?.player;
      const list = player?.textTracks?.();
      const original = Array.from({ length: list?.length ?? 0 }, (_, index) => list[index])
        .find((track) => track.language === 'el' && track.label === 'Greek');
      const cues = Array.from(original?.cues ?? []);
      if (!cues.length || original.mode !== 'hidden') return false;
      window.__lumoraSmokeCues = { track: original, cues: cues.map((cue) => ({ cue, start: cue.startTime, end: cue.endTime, text: cue.text })) };
      return cues.some((cue) => cue.startTime < 12.5 && cue.endTime > 12.5);
    }), 'real same-origin Greek sidecar cues did not cover the aligned asset time');
    assert(subtitleCatalogs.length > 0 && sidecarRequests.length > 0, 'subtitle metadata and same-origin VTT must be intercepted separately');
    assert(requests.length === count, 'choosing a global sidecar unexpectedly switched its compatible media stream');
    await assertSubtitleOffset(video, 0);
    await page.getByRole('button', { name: 'Delay subtitles by 0.25 seconds', exact: true }).click();
    await assertSubtitleOffset(video, 0.25);
    await page.getByRole('button', { name: 'Reset subtitle timing', exact: true }).click();
    await assertSubtitleOffset(video, 0);
    await choose(page, 'Subtitles', 'off');
    assert(await video.evaluate((element) => {
      const player = element.player ?? element.closest('.video-js')?.player;
      const tracks = player?.textTracks?.();
      return Array.from({ length: tracks?.length ?? 0 }, (_, index) => tracks[index]).every((track) => track.label !== 'Greek');
    }), 'unselected sidecar remains installed after Subtitles Off');
  });

  await check('Gear Playback Speed And Normal Reset', async () => {
    await seek(video, 12);
    await choose(page, 'Playback speed', '1.5');
    assert(await video.evaluate((element) => element.playbackRate === 1.5 && element.paused && Math.abs(element.currentTime - 12) < 0.4),
      'gear playback speed did not set 1.5x while preserving paused position');
    await decode(video, 0.7);
    await choose(page, 'Playback speed', '1');
    assert(await video.evaluate((element) => element.playbackRate === 1 && !element.paused), 'Normal reset lost the playing state or playback rate');
    assert((await optionList(choiceSelect(page, 'Playback speed'))).some((option) => option.value === '1' && option.label === 'Normal'),
      'normal-speed choice is not labeled Normal');
    await decode(video, 0.5);
    await video.evaluate((element) => element.pause());
    for (const label of ['Quality', 'Audio', 'Subtitles']) assert(await choiceSelect(page, label).count() === 0,
      `${label} selector belongs in its dedicated panel, not the Settings gear`);
    assert(await page.getByRole('button', { name: 'Reset subtitle timing', exact: true }).count() === 0,
      'subtitle timing belongs only in the dedicated subtitle panel');
  });

  await check('Settings Menu Clipping And Colors', async () => {
    for (const label of ['Quality', 'Audio', 'Subtitles', 'Settings']) await assertMenuBounds(page, false, label);
    if (SCREENSHOT_DIR) {
      await page.locator(SETTINGS).evaluate((element) => { element.scrollTop = 0; });
      await page.locator(SURFACE).first().screenshot({
        path: join(SCREENSHOT_DIR, `native-player-${MOBILE ? 'mobile' : 'desktop'}-${CATALOG_SIZE}-settings.png`),
        animations: 'disabled',
      });
    }
  });

  await check('Fullscreen Settings Menu Clipping And Colors', async () => {
    await settings(page, false);
    await page.locator('.video-js').first().hover();
    await page.getByRole('button', { name: 'Fullscreen', exact: true }).first().click();
    await page.waitForFunction(() => Boolean(document.fullscreenElement), undefined, { timeout: 5_000 });
    try {
      for (const label of ['Quality', 'Audio', 'Subtitles', 'Settings']) await assertMenuBounds(page, true, label);
    } finally {
      await settings(page, false);
      await page.evaluate(() => document.fullscreenElement ? document.exitFullscreen() : undefined);
      await page.waitForFunction(() => !document.fullscreenElement);
    }
  });

  await check('Ten Second Buttons And Boundary Clamps', async () => {
    await settings(page, false);
    const backward = page.locator('.vjs-skip-backward-10').first();
    const forward = page.locator('.vjs-skip-forward-10').first();
    await page.locator('.video-js').first().hover();
    assert(await backward.getAttribute('aria-label') || await backward.innerText(), 'backward button has no accessible name');
    assert(await forward.getAttribute('aria-label') || await forward.innerText(), 'forward button has no accessible name');
    await seek(video, 20);
    await forward.click();
    await until(async () => Math.abs((await snapshot(video)).time - 30) < 0.4, '+10 button does not seek forward ten seconds');
    await backward.click();
    await until(async () => Math.abs((await snapshot(video)).time - 20) < 0.4, '-10 button does not seek backward ten seconds');
    await seek(video, 3);
    await backward.click();
    await until(async () => (await snapshot(video)).time < 0.2, '-10 button does not clamp at zero');
    const duration = (await snapshot(video)).duration;
    assert(Number.isFinite(duration) && duration > 30, 'fixture duration is unavailable');
    await seek(video, duration - 3);
    await forward.click();
    await until(async () => Math.abs((await snapshot(video)).time - duration) < 0.3, '+10 button does not clamp at duration');
  });

  if (MOBILE) await check('Mobile Touch Double Taps', async () => {
    await settings(page, false);
    const tap = async (side) => {
      const rect = await page.locator('.video-js').first().boundingBox();
      assert(rect, 'touch player surface has no geometry');
      const x = rect.x + rect.width * (side === 'left' ? 0.15 : 0.85);
      const y = rect.y + rect.height * 0.3;
      await page.touchscreen.tap(x, y);
      await page.waitForTimeout(100);
      await page.touchscreen.tap(x, y);
    };
    await seek(video, 20);
    await tap('right');
    await until(async () => Math.abs((await snapshot(video)).time - 30) < 0.6, 'right touch doubletap did not seek +10');
    await tap('left');
    await until(async () => Math.abs((await snapshot(video)).time - 20) < 0.6, 'left touch doubletap did not seek -10');
    await seek(video, 3);
    await tap('left');
    await until(async () => (await snapshot(video)).time < 0.2, 'touch backward doubletap did not clamp zero');
  });

  await check('Watched Elapsed And Percentage Labels', async () => {
    await seek(video, 20);
    await until(async () => {
      const label = page.locator('.lumora-player-progress');
      const text = (await label.innerText()).replace(/\s+/g, ' ');
      const accessible = await label.getAttribute('aria-label');
      const percent = /(\d+(?:\.\d+)?)%/.exec(text);
      const state = await snapshot(video);
      return /(?:0:20|00:20)/.test(text) && /watched.*0:20.*percent/i.test(accessible ?? '') && percent
        && Math.abs(Number(percent[1]) - state.time / state.duration * 100) <= 1.1;
    }, 'watched label does not expose actual elapsed position and duration-derived percentage', UI_TIMEOUT);
  });

  await check('Movie Has No Up Next Overlay', async () => {
    assert(await page.locator('.lumora-player-up-next').count() === 0 && await page.getByRole('link', { name: /play next episode/i }).count() === 0,
      'movie fixture must not invent a next episode');
    const duration = (await snapshot(video)).duration;
    await seek(video, duration - 2);
    assert(await page.locator('.lumora-player-up-next').count() === 0, 'movie displays Up Next near the end');
  });

  await check('Cast Rejection And Native Null Handle Keep Local Playback', async () => {
    // Pin the real toolbar before starting playback so auto-hide cannot eat the click.
    await settings(page);
    await seek(video, 20);
    await decode(video, 0.3);
    const handle = await video.elementHandle();
    await video.evaluate((element) => {
      Object.defineProperty(element, 'webkitShowPlaybackTargetPicker', { configurable: true, value: undefined });
      Object.defineProperty(element, 'remote', { configurable: true, value: {
        prompt: () => Promise.reject(new DOMException('Fixture adaptive playback unsupported', 'NotSupportedError')),
      } });
    });
    await page.locator('.video-js').first().hover();
    await page.getByRole('button', { name: 'Cast', exact: true }).click();
    await page.locator('.lumora-player-cast-status.is-error').waitFor({ state: 'visible' });
    const message = await page.locator('.lumora-player-cast-status').innerText();
    assert(/public HTTPS|local|could not start/i.test(message), 'Cast did not expose a controlled safe availability/rejection message');
    assert(!(await snapshot(video)).paused && await handle.evaluate((element) => element.isConnected), 'Cast rejection paused or remounted local playback');
    assert(await page.locator('.lumora-player-cast-controls').count() === 0, 'Cast rejection must not display a connected remote overlay');
    await decode(video, 0.7);
    await video.evaluate((element) => { Object.defineProperty(element, 'remote', { configurable: true, value: { prompt: () => Promise.resolve() } }); });
    await page.locator('.video-js').first().hover();
    await page.getByRole('button', { name: 'Cast', exact: true }).click();
    await until(async () => /Device picker opened/.test(await page.locator('.lumora-player-cast-status').innerText()),
      'successful native picker did not return the controlled null-handle state');
    assert(!(await snapshot(video)).paused && await handle.evaluate((element) => element.isConnected), 'null native Cast handle paused or replaced local playback');
    assert(await page.locator('.lumora-player-cast-controls').count() === 0 && await video.evaluate((element) => {
      const player = element.player ?? element.closest('.video-js')?.player;
      return player?.controls?.() === true;
    }), 'null Cast handle displayed a connected overlay or disabled local controls');
    await decode(video, 0.7);
    assert(castSdkRequests.length === 0, 'local rejection/native picker should not request any real Google SDK');
    await handle.dispose();
    await video.evaluate((element) => element.pause());
    await settings(page, false);
    return 'controlled rejection and picker stub only; no hardware claim';
  });

  await check('Hard Reload Resume Below Two Percent', async () => {
    const duration = (await snapshot(video)).duration;
    const early = Math.min(0.75, duration * 0.01);
    assert(early > 0 && early / duration < 0.02, 'early checkpoint fixture is not below two percent');
    video = await reloadAt(page, video, early);
    assert((await snapshot(video)).time / duration < 0.02, 'early resume was incorrectly discarded as barely started');
  });

  await check('Hard Reload Resume After Backward Seek', async () => {
    await seek(video, 24);
    await until(() => checkpointMatches(page, 24), 'forward checkpoint not written');
    video = await reloadAt(page, video, 7);
    const after = await decode(video, 0.7);
    assert(after.time >= 7 && after.frames > 0, 'resumed backward checkpoint did not decode');
  });

  await check('Hard Reload Zero Resets Previous Resume', async () => {
    video = await reloadAt(page, video, 0);
    assert((await snapshot(video)).time < 0.15, 'zero checkpoint revived an older resume position');
    await decode(video, 0.7);
  });

  await check('No Database Writes And Healthy Player CSP', async () => {
    // The route interceptor aborts mutation requests before they reach servers.
    assert(await page.evaluate(() => !window.__lumoraCspViolations.some((entry) => entry.disposition === 'enforce'
      && /worker-src|media-src/.test(entry.directive))), 'player worker/media was blocked by CSP after reload');
    await settings(page);
    await noDirectServers(page);
    await union(page);
    return `mutation requests blocked=${blockedMutations.length}`;
  });
  completed = true;
} catch (error) {
  if (!results.some((result) => result.status === 'FAIL')) {
    results.push({ name: 'Setup', status: 'FAIL' });
    console.error(`FAIL  Setup: ${safeError(error)}`);
  }
} finally {
  releaseCatalog?.();
  await context?.close();
  await browser?.close();
}

const passed = results.filter((result) => result.status === 'PASS').length;
const failed = results.filter((result) => result.status === 'FAIL').length;
const accepted = completed && failed === 0;
process.stdout.write(`\nACCEPTANCE ${accepted ? 'PASS' : 'FAIL'} | ${MOBILE ? 'mobile' : 'desktop'} | streams=${CATALOG_SIZE} | passed=${passed} failed=${failed}${completed ? '' : ' | remaining checks not run'}\n`);
process.exitCode = accepted ? 0 : 1;
