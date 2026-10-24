// Browser smoke test for Lumora's native HLS player. The local Vidnest resolve
// request is intercepted in-browser, so this test never inserts a media_sources
// row or calls the upstream Vidnest resolver.
import { chromium } from 'playwright';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3100';
const WATCH_PATH = process.env.WATCH_PATH ?? '/watch/movie/inception-27205';
const MOBILE_VIEWPORT = process.env.VIEWPORT?.toLowerCase() === 'mobile';
const DEBUG_NETWORK = process.env.DEBUG_NETWORK === '1';
const BYPASS_CSP = process.env.BYPASS_CSP === '1';
const WATCH_URL = new URL(WATCH_PATH, BASE_URL).href;
const APP_ORIGIN = new URL(BASE_URL).origin;
const FIXTURE_URL = 'https://storage.googleapis.com/shaka-demo-assets/angel-one-hls/hls.m3u8';
const FIXTURE_ORIGIN = new URL(FIXTURE_URL).origin;
const VIDEO_SELECTOR = 'section[aria-label^="Player for"] video';
const MEDIA_TIMEOUT_MS = 45_000;
const UI_TIMEOUT_MS = 20_000;
const OLD_FALLBACK_TIMEOUT_MS = 10_000;

class AssertionFailure extends Error {}

function assert(condition, label) {
  if (!condition) throw new AssertionFailure(label);
  console.log(`PASS  ${label}`);
}

function skip(label) {
  console.log(`SKIP  ${label}`);
}

function safeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .split('\n')[0]
    .replace(/([?&](?:token|key|sig|signature)=)[^&\s)]+/gi, '$1<redacted>')
    .replace(/https?:\/\/[^\s)]+/gi, '<url>');
}

function absoluteUri(value, baseUrl) {
  try {
    const url = new URL(value, baseUrl);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : value;
  } catch {
    return value;
  }
}

function absolutizeManifest(manifest, baseUrl) {
  return manifest
    .split(/\r?\n/)
    .map((line) => {
      const value = line.trim();
      if (!value) return line;
      if (value.startsWith('#')) {
        return line.replace(/URI=(["'])(.*?)\1/g, (_match, quote, uri) => (
          `URI=${quote}${absoluteUri(uri, baseUrl)}${quote}`
        ));
      }
      return line.replace(value, absoluteUri(value, baseUrl));
    })
    .join('\n');
}

async function loadFixtureManifest() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(FIXTURE_URL, { signal: controller.signal });
    if (!response.ok) throw new Error(`fixture returned HTTP ${response.status}`);
    const manifest = await response.text();
    if (!manifest.trimStart().startsWith('#EXTM3U')) throw new Error('fixture is not an HLS manifest');
    return absolutizeManifest(manifest, response.url || FIXTURE_URL);
  } finally {
    clearTimeout(timeout);
  }
}

function fixtureRequestInfo(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const stream = url.searchParams.get('stream');
    if (
      url.origin !== APP_ORIGIN
      || url.pathname !== '/api/vidnest'
      || url.searchParams.has('token')
      || !url.searchParams.has('tmdbId')
      || !url.searchParams.has('type')
      || stream === null
      || !/^\d+$/.test(stream)
    ) return null;
    return { stream };
  } catch {
    return null;
  }
}

function safeNetworkKind(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.origin === APP_ORIGIN && url.pathname === '/api/vidnest') return 'local Vidnest manifest';
    if (url.origin !== FIXTURE_ORIGIN) return null;
    if (url.pathname.endsWith('.m3u8')) return 'fixture playlist';
    if (url.pathname.endsWith('.vtt') || url.pathname.endsWith('.webvtt')) return 'fixture subtitle';
    return 'fixture media';
  } catch {
    return null;
  }
}

async function waitForVisible(locator, timeout = UI_TIMEOUT_MS) {
  try {
    await locator.waitFor({ state: 'visible', timeout });
    return true;
  } catch {
    return false;
  }
}

async function acceptPlayerConsent(page, required = false) {
  const button = page.getByRole('button', { name: /load external player/i }).first();
  const visible = await waitForVisible(button, required ? UI_TIMEOUT_MS : 1_500);
  if (visible) await button.click();
  if (required) assert(visible, 'player consent gate accepted');
  return visible;
}

async function waitForPlayableVideo(page) {
  const video = page.locator(VIDEO_SELECTOR).first();
  await video.waitFor({ state: 'attached', timeout: MEDIA_TIMEOUT_MS });
  await video.evaluate((element, timeoutMs) => new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (!element.isConnected) {
        reject(new Error('video detached before becoming playable'));
        return;
      }
      if (element.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && element.videoWidth > 0 && element.videoHeight > 0) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        const playerError = element.player?.error?.();
        const errorDetail = playerError ? ` playerError=${playerError.code}:${playerError.message}` : '';
        reject(new Error(
          `video did not become playable before timeout (readyState=${element.readyState}, networkState=${element.networkState}, dimensions=${element.videoWidth}x${element.videoHeight}${errorDetail})`,
        ));
        return;
      }
      setTimeout(check, 100);
    };
    check();
  }), MEDIA_TIMEOUT_MS);
  return video;
}

async function playAndMeasure(video, minimumAdvanceSeconds = 2) {
  return video.evaluate(async (element, { minimumAdvanceSeconds: minimumAdvance, timeoutMs }) => {
    const decodedFrames = () => {
      const quality = element.getVideoPlaybackQuality?.();
      if (quality && Number.isFinite(quality.totalVideoFrames)) return quality.totalVideoFrames;
      const legacy = element.webkitDecodedFrameCount;
      return Number.isFinite(legacy) ? legacy : -1;
    };

    element.muted = true;
    await element.play();
    const startedAt = element.currentTime;
    const startingFrames = decodedFrames();
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const currentFrames = decodedFrames();
      if (
        element.isConnected
        && element.currentTime - startedAt >= minimumAdvance
        && startingFrames >= 0
        && currentFrames > startingFrames
      ) {
        return {
          connected: true,
          currentTime: element.currentTime,
          decodedFrames: currentFrames,
          frameDelta: currentFrames - startingFrames,
          height: element.videoHeight,
          readyState: element.readyState,
          timeDelta: element.currentTime - startedAt,
          width: element.videoWidth,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    return {
      connected: element.isConnected,
      currentTime: element.currentTime,
      decodedFrames: decodedFrames(),
      frameDelta: decodedFrames() - startingFrames,
      height: element.videoHeight,
      readyState: element.readyState,
      timeDelta: element.currentTime - startedAt,
      width: element.videoWidth,
    };
  }, { minimumAdvanceSeconds, timeoutMs: MEDIA_TIMEOUT_MS });
}

async function mediaSnapshot(video) {
  return video.evaluate((element) => {
    const quality = element.getVideoPlaybackQuality?.();
    const decodedFrames = quality?.totalVideoFrames ?? element.webkitDecodedFrameCount ?? -1;
    return {
      connected: element.isConnected,
      currentTime: element.currentTime,
      decodedFrames,
      height: element.videoHeight,
      paused: element.paused,
      readyState: element.readyState,
      width: element.videoWidth,
    };
  });
}

async function qualityState(video) {
  return video.evaluate((element) => {
    const player = element.player ?? element.closest('.video-js')?.player;
    const levels = player?.qualityLevels?.();
    if (!levels) return null;
    return Array.from({ length: levels.length }, (_, index) => ({
      enabled: Boolean(levels[index]?.enabled),
      id: String(levels[index]?.id ?? ''),
    }));
  });
}

async function waitForQualityState(video, predicate, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  let state = null;
  while (Date.now() < deadline) {
    state = await qualityState(video);
    if (state && predicate(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return state;
}

async function audioState(video) {
  return video.evaluate((element) => {
    const player = element.player ?? element.closest('.video-js')?.player;
    const tracks = player?.audioTracks?.();
    if (!tracks) return null;
    return Array.from({ length: tracks.length }, (_, index) => ({
      enabled: Boolean(tracks[index]?.enabled),
      id: String(tracks[index]?.id ?? ''),
    }));
  });
}

async function subtitleState(video) {
  return video.evaluate((element) => {
    const player = element.player ?? element.closest('.video-js')?.player;
    const tracks = player?.textTracks?.();
    if (!tracks) return null;
    return Array.from({ length: tracks.length }, (_, index) => tracks[index])
      .filter((track) => track?.kind === 'subtitles' || track?.kind === 'captions')
      .map((track) => ({ id: String(track.id ?? ''), mode: track.mode }));
  });
}

async function options(select) {
  return select.evaluate((element) => Array.from(element.options, (option) => ({
    label: option.textContent?.trim() ?? '',
    value: option.value,
  })));
}

function settingsSelect(page, label) {
  return page.locator('#hls-settings label').filter({ hasText: label }).locator('select').first();
}

async function waitForOptions(select, minimumCount, label) {
  try {
    await select.locator('option').nth(minimumCount - 1).waitFor({ state: 'attached', timeout: MEDIA_TIMEOUT_MS });
  } catch {
    const count = await select.locator('option').count().catch(() => 0);
    throw new AssertionFailure(`${label} menu did not expose ${minimumCount} options before timeout (count=${count})`);
  }
}

async function waitForFixtureIntercept(page, intercepts, previousCount, timeout = MEDIA_TIMEOUT_MS) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (intercepts.length > previousCount) return intercepts[previousCount] ?? intercepts.at(-1) ?? null;
    await page.waitForTimeout(50);
  }
  return null;
}

async function selectAlternateFixtureSource(page, serverSelect, currentValue, initialStream, intercepts) {
  const sourceOptions = (await options(serverSelect)).filter((option) => option.value && option.value !== currentValue);
  assert(sourceOptions.length > 0, 'at least one alternate server is available');

  for (const option of sourceOptions) {
    const previousCount = intercepts.length;
    await serverSelect.selectOption(option.value);
    await acceptPlayerConsent(page);
    const info = await waitForFixtureIntercept(page, intercepts, previousCount, 6_000);
    if (info && info.stream !== initialStream) return { option, stream: info.stream };
  }
  return null;
}

let browser;
let passed = false;

try {
  const fixtureManifest = await loadFixtureManifest();
  browser = await chromium.launch();
  const context = await browser.newContext({
    bypassCSP: BYPASS_CSP,
    serviceWorkers: 'block',
    viewport: MOBILE_VIEWPORT ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    ...(MOBILE_VIEWPORT ? { hasTouch: true, isMobile: true } : {}),
  });
  await context.addInitScript(() => {
    try {
      localStorage.setItem('lumora.consent.v1', JSON.stringify({
        necessary: true,
        analytics: false,
        ads: false,
        decidedAt: '2026-01-01T00:00:00.000Z',
      }));
    } catch {
      // Storage can be unavailable on the initial blank document.
    }
  });

  const page = await context.newPage();
  console.log(`RUN   ${MOBILE_VIEWPORT ? 'mobile 390x844' : 'desktop 1440x900'}${BYPASS_CSP ? ' (CSP bypass diagnostic)' : ''}`);
  if (DEBUG_NETWORK) {
    page.on('response', (response) => {
      const kind = safeNetworkKind(response.url());
      if (kind) console.log(`DEBUG response ${response.status()} ${kind}`);
    });
    page.on('requestfailed', (request) => {
      const kind = safeNetworkKind(request.url());
      if (kind) console.log(`DEBUG request failed ${kind}: ${safeError(request.failure()?.errorText ?? 'unknown')}`);
    });
    page.on('console', (message) => {
      if (message.type() === 'error') console.log(`DEBUG browser console: ${safeError(message.text())}`);
    });
  }
  page.setDefaultTimeout(UI_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(60_000);

  const fixtureIntercepts = [];
  await page.route('**/api/vidnest**', async (route) => {
    const info = fixtureRequestInfo(route.request().url());
    if (!info) {
      await route.continue();
      return;
    }
    fixtureIntercepts.push(info);
    await route.fulfill({
      status: 200,
      contentType: 'application/vnd.apple.mpegurl',
      headers: { 'Cache-Control': 'no-store' },
      body: fixtureManifest,
    });
  });

  await page.goto(WATCH_URL, { waitUntil: 'domcontentloaded' });
  const playerSurface = page.locator('section[aria-label^="Player for"]').first();
  assert(await waitForVisible(playerSurface), 'WATCH_PATH resolves to a player surface');
  const initialInterceptCount = fixtureIntercepts.length;
  await acceptPlayerConsent(page, true);
  const initialRequestInfo = await waitForFixtureIntercept(page, fixtureIntercepts, initialInterceptCount);
  assert(initialRequestInfo !== null, 'player requests a local Vidnest HLS source');
  assert(await page.getByText(/Advertisement .* video starts after this ad/i).count() === 0,
    'ads=false bypasses the configured pre-roll without a session marker');
  assert(fixtureIntercepts.length > initialInterceptCount, 'local Vidnest HLS request intercepted without database setup');

  const mountedAt = Date.now();
  const video = await waitForPlayableVideo(page);
  const firstVideoHandle = await video.elementHandle();
  assert(firstVideoHandle !== null, 'connected native video element rendered');

  const playback = await playAndMeasure(video);
  assert(playback.connected, 'video remains connected while playing');
  assert(playback.width > 0 && playback.height > 0, `video has nonzero decoded dimensions (${playback.width}x${playback.height})`);
  assert(playback.readyState >= 2, `video has current media data (readyState=${playback.readyState})`);
  assert(playback.timeDelta >= 2, `playback time advances (${playback.timeDelta.toFixed(1)}s)`);
  assert(playback.frameDelta > 0, `video decodes frames (${playback.frameDelta} new frames)`);

  const settingsButton = page.getByRole('button', { name: /settings/i }).first();
  assert(await waitForVisible(settingsButton), 'NativePlayer Settings control appears');
  await settingsButton.click();
  assert(await settingsButton.getAttribute('aria-expanded') === 'true', 'NativePlayer Settings menu opens');
  assert(await waitForVisible(page.locator('#hls-settings')), 'combined playback Settings panel is visible');

  const qualitySelect = settingsSelect(page, 'Quality');
  const audioSelect = settingsSelect(page, 'Audio');
  const subtitleSelect = settingsSelect(page, 'Subtitles');
  const serverSelect = settingsSelect(page, 'Server');
  const settingsLabels = await page.locator('#hls-settings label > span').allTextContents();
  assert(settingsLabels.includes('Server'), `combined Settings includes Server (${settingsLabels.join(', ') || 'no labels'})`);
  await waitForOptions(serverSelect, 2, 'Server');
  await waitForOptions(qualitySelect, 2, 'Quality');
  await waitForOptions(audioSelect, 2, 'Audio');
  await waitForOptions(subtitleSelect, 2, 'Subtitles');

  const serverOptions = await options(serverSelect);
  const qualityOptions = await options(qualitySelect);
  const audioOptions = await options(audioSelect);
  const subtitleOptions = await options(subtitleSelect);
  assert(serverOptions.length > 1, `player Settings exposes ${serverOptions.length} server choices`);
  assert(await page.getByLabel('Source', { exact: true }).count() === 0,
    'standalone Source selector is hidden during native playback');
  assert(qualityOptions.some((option) => option.value === 'auto') && qualityOptions.length > 2,
    `quality menu exposes Auto and ${qualityOptions.length - 1} manual levels`);
  assert(audioOptions.length > 1, `audio menu exposes ${audioOptions.length} tracks`);
  assert(subtitleOptions.some((option) => option.value === 'off') && subtitleOptions.length > 2,
    `subtitle menu exposes Off and ${subtitleOptions.length - 1} tracks`);

  const manualQuality = qualityOptions
    .filter((option) => option.value !== 'auto')
    .sort((a, b) => (Number.parseInt(b.label, 10) || 0) - (Number.parseInt(a.label, 10) || 0))[0];
  assert(Boolean(manualQuality), 'manual quality option is available');
  await qualitySelect.selectOption(manualQuality.value);
  assert((await qualitySelect.inputValue()) === manualQuality.value, `quality UI selects ${manualQuality.label}`);
  const manualQualityState = await waitForQualityState(video, (state) => {
    const enabled = state.filter((level) => level.enabled);
    return state.length === qualityOptions.length - 1
      && enabled.length === 1
      && enabled[0]?.id === manualQuality.value;
  });
  assert(manualQualityState?.length === qualityOptions.length - 1,
    `quality API exposes ${qualityOptions.length - 1} renditions after manual selection (actual=${manualQualityState?.length ?? 'unavailable'})`);
  const enabledManualLevels = manualQualityState?.filter((level) => level.enabled) ?? [];
  const selectedManualLevelEnabled = enabledManualLevels.some((level) => level.id === manualQuality.value);
  assert(
    enabledManualLevels.length === 1 && selectedManualLevelEnabled,
    `manual quality selection enables only ${manualQuality.label} (enabled=${enabledManualLevels.length}, selectedEnabled=${selectedManualLevelEnabled})`,
  );

  await qualitySelect.selectOption('auto');
  const autoQualityState = await waitForQualityState(video, (state) => (
    state.length === qualityOptions.length - 1 && state.every((level) => level.enabled)
  ));
  assert(
    Boolean(autoQualityState?.length) && autoQualityState.every((level) => level.enabled),
    'Quality Auto re-enables every rendition',
  );

  const currentAudio = await audioSelect.inputValue();
  const alternateAudio = audioOptions.find((option) => option.value !== currentAudio) ?? audioOptions[0];
  await audioSelect.selectOption(alternateAudio.value);
  await page.waitForTimeout(250);
  const selectedAudioState = await audioState(video);
  const enabledAudioTracks = selectedAudioState?.filter((track) => track.enabled) ?? [];
  assert(
    enabledAudioTracks.length === 1 && enabledAudioTracks[0]?.id === alternateAudio.value,
    `audio selection activates ${alternateAudio.label}`,
  );

  const currentSubtitle = await subtitleSelect.inputValue();
  const selectedSubtitle = subtitleOptions.find((option) => option.value !== 'off' && option.value !== currentSubtitle)
    ?? subtitleOptions.find((option) => option.value !== 'off');
  assert(Boolean(selectedSubtitle), 'selectable subtitle track is available');
  await subtitleSelect.selectOption(selectedSubtitle.value);
  await page.waitForTimeout(250);
  const selectedSubtitleState = await subtitleState(video);
  assert(
    selectedSubtitleState?.some((track) => track.id === selectedSubtitle.value && track.mode === 'showing') === true,
    `subtitle selection shows ${selectedSubtitle.label}`,
  );
  await subtitleSelect.selectOption('off');
  await page.waitForTimeout(250);
  const disabledSubtitleState = await subtitleState(video);
  assert(disabledSubtitleState?.every((track) => track.mode !== 'showing') === true, 'Subtitles Off hides all subtitle tracks');

  const beforeTimeout = await mediaSnapshot(video);
  const waitPastFallback = Math.max(3_000, OLD_FALLBACK_TIMEOUT_MS + 1_500 - (Date.now() - mountedAt));
  await page.waitForTimeout(waitPastFallback);
  const afterTimeout = await firstVideoHandle.evaluate((element) => {
    const quality = element.getVideoPlaybackQuality?.();
    return {
      connected: element.isConnected,
      currentTime: element.currentTime,
      decodedFrames: quality?.totalVideoFrames ?? element.webkitDecodedFrameCount ?? -1,
    };
  });
  assert(afterTimeout.connected, 'same video remains connected past the former 10-second fallback timeout');
  assert(afterTimeout.currentTime > beforeTimeout.currentTime + 1, 'playback continues past the former fallback timeout');
  assert(afterTimeout.decodedFrames > beforeTimeout.decodedFrames, 'decoded frames continue past the former fallback timeout');

  await settingsButton.click();
  await page.locator('.video-js').first().hover();
  const fullscreenButton = page.locator('.vjs-fullscreen-control').first();
  assert(await waitForVisible(fullscreenButton, 5_000), 'Video.js fullscreen control is available');
  let fullscreenEntered = false;
  try {
    await fullscreenButton.click({ timeout: 5_000 });
    await page.waitForFunction(() => {
      const element = document.querySelector('section[aria-label^="Player for"] video');
      const player = element?.player ?? element?.closest('.video-js')?.player;
      return Boolean(document.fullscreenElement || player?.isFullscreen?.());
    }, undefined, { timeout: 3_000 });
    fullscreenEntered = true;
  } catch {
    skip('headless Chromium did not permit a fullscreen transition; control presence was verified');
  }
  if (fullscreenEntered) {
    console.log('PASS  fullscreen mode can be entered');
    await settingsButton.click();
    const fullscreenServerSelect = settingsSelect(page, 'Server');
    assert(await waitForVisible(fullscreenServerSelect, 3_000), 'player Settings remain visible in fullscreen');
    const settingsInsideFullscreenPlayer = await fullscreenServerSelect.evaluate((select) => {
      const fullscreenRoot = document.fullscreenElement ?? select.closest('.vjs-fullscreen');
      return Boolean(fullscreenRoot?.contains(select));
    });
    assert(settingsInsideFullscreenPlayer, 'Server selector is rendered inside the fullscreen player');
    await settingsButton.click();
    await page.evaluate(async () => {
      if (document.fullscreenElement) await document.exitFullscreen();
      else {
        const element = document.querySelector('section[aria-label^="Player for"] video');
        const player = element?.player ?? element?.closest('.video-js')?.player;
        player?.exitFullscreen?.();
      }
    });
  }

  await settingsButton.click();
  const serverSelectForSwitch = settingsSelect(page, 'Server');
  assert(await waitForVisible(serverSelectForSwitch), 'Server selector is available inside player Settings');
  const currentSource = await serverSelectForSwitch.inputValue();
  const instanceMarker = `smoke-${Date.now()}`;
  await video.evaluate((element, marker) => { element.dataset.smokeInstance = marker; }, instanceMarker);
  const alternate = await selectAlternateFixtureSource(
    page,
    serverSelectForSwitch,
    currentSource,
    initialRequestInfo.stream,
    fixtureIntercepts,
  );
  assert(Boolean(alternate), 'player Settings server switch requests a different intercepted Vidnest stream');
  await page.waitForFunction((marker) => {
    const element = document.querySelector('section[aria-label^="Player for"] video');
    return Boolean(element?.isConnected && element.dataset.smokeInstance !== marker);
  }, instanceMarker, { timeout: MEDIA_TIMEOUT_MS });
  assert(await firstVideoHandle.evaluate((element) => !element.isConnected), 'server switch disposes the previous video element');

  const remountedVideo = await waitForPlayableVideo(page);
  const remountedPlayback = await playAndMeasure(remountedVideo, 1.5);
  assert(remountedPlayback.connected && remountedPlayback.timeDelta >= 1.5 && remountedPlayback.frameDelta > 0,
    'server-switch remount plays and decodes the intercepted HLS fixture');
  const remountedSettingsButton = page.getByRole('button', { name: /settings/i }).first();
  assert(await waitForVisible(remountedSettingsButton), 'Settings control returns after server remount');
  await remountedSettingsButton.click();
  const remountedServerSelect = settingsSelect(page, 'Server');
  assert((await remountedServerSelect.inputValue()) === alternate.option.value,
    'alternate server remains selected in player Settings after remount');

  passed = true;
} catch (error) {
  if (error instanceof AssertionFailure) console.error(`FAIL  ${error.message}`);
  else console.error(`FAIL  smoke test aborted: ${safeError(error)}`);
} finally {
  await browser?.close();
}

console.log(passed ? '\nALL PASSED' : '\nFAILED');
process.exit(passed ? 0 : 1);
