import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import Module, { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { browserHtmlStructure, lexicalHtmlStructure } from './html-structure.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const project = path.resolve(directory, '../../..');
const mode = process.argv.find((arg) => arg.startsWith('--react-mode='))?.split('=')[1] ?? 'development';
const smoke = process.argv.includes('--smoke');
assert.ok(['development', 'production'].includes(mode), 'React mode must be development or production');
process.env.NODE_ENV = mode;
const require = createRequire(import.meta.url);
const react = require('react');
assert.equal(react.version, '19.0.0', 'This regression intentionally targets installed React 19.0.0');
assert.equal(typeof globalThis.window, 'undefined', 'SSR must not receive a fake window');
assert.equal(typeof globalThis.document, 'undefined', 'SSR must not receive a fake DOM');

const snapshots = new Map();
const bundles = new Map();
const entry = path.join(directory, 'entry.jsx');
const boundary = path.join(directory, 'boundaries.jsx').replaceAll('\\', '/');
const hash = (value) => createHash('sha256').update(value).digest('hex');

function fixturePlugin(nativeMode) {
  return {
    name: 'private-player-boundaries',
    setup(builder) {
      builder.onResolve({ filter: /.*/ }, async (args) => {
        let exports;
        if (args.path === 'next/navigation') exports = 'useRouter';
        else if (args.path === 'next/link') exports = 'FixtureLink as default';
        else if (args.path === 'next/script') exports = 'FixtureScript as default';
        else if (args.path === 'video.js') exports = 'createVideoPlayer as default';
        else if (/features\/playback\/(session|report|progress)-actions$/.test(args.path)) {
          exports = 'reportPlaybackStartAction, reportPlaybackHeartbeatAction, reportPlaybackEndAction, reportPlaybackIssueAction, reportProgressAction';
        } else if (/(?:^|\/)transport$/.test(args.path) && args.importer.replaceAll('\\', '/').includes('/watch-party/web/')) {
          exports = 'WatchPartyTransport';
        } else if (nativeMode === 'native-dom-contract' && args.path === './NativePlayer'
          && path.basename(args.importer) === 'PlayerShell.tsx') exports = 'NativeDomStub as NativePlayer';
        if (exports) return { path: exports, namespace: 'private-boundary' };
        if (/^(?:server-only|@supabase\/|@opennextjs\/|next\/)/.test(args.path)) {
          throw new Error(`Unfaked server/framework boundary: ${args.path}`);
        }
        if (args.path.startsWith('@/')) {
          return builder.resolve(`./${args.path.slice(2)}`, { resolveDir: path.join(project, 'src'), kind: args.kind });
        }
        return null;
      });
      builder.onLoad({ filter: /.*/, namespace: 'private-boundary' }, (args) => ({
        contents: `export { ${args.path} } from ${JSON.stringify(boundary)};`,
        loader: 'jsx', resolveDir: directory,
      }));
      builder.onLoad({ filter: /\.(?:tsx?|jsx?|mjs|cjs)$/ }, async (args) => {
        if (!snapshots.has(args.path)) snapshots.set(args.path, await readFile(args.path, 'utf8'));
        const extension = path.extname(args.path).slice(1);
        return { contents: snapshots.get(args.path), loader: ['ts', 'tsx', 'jsx'].includes(extension) ? extension : 'js' };
      });
    },
  };
}

async function loadFixture(nativeMode) {
  if (bundles.has(nativeMode)) return bundles.get(nativeMode);
  const common = {
    entryPoints: [entry], bundle: true, write: false, jsx: 'automatic',
    define: { 'process.env.NODE_ENV': JSON.stringify(mode) },
    logLevel: 'silent', plugins: [fixturePlugin(nativeMode)], metafile: true,
  };
  // Test-only, in-memory TSX transpilation. No Next/build artifacts or disk output.
  const node = await build({ ...common, platform: 'node', format: 'cjs',
    external: ['react', 'react/*', 'react-dom', 'react-dom/*'] });
  const module = new Module(entry);
  module.filename = entry;
  module.paths = Module._nodeModulePaths(directory);
  module._compile(node.outputFiles[0].text, entry);
  const client = await build({ ...common, platform: 'browser', format: 'iife', sourcemap: 'inline' });
  const sourceInputs = Object.keys(client.metafile.inputs).filter((input) => /(?:^|\/)src\//.test(input.replaceAll('\\', '/')));
  assert.ok(sourceInputs.some((input) => input.endsWith('PlayerShell.tsx')), 'Actual PlayerShell must be bundled');
  assert.ok(sourceInputs.some((input) => input.endsWith('NativePlayer.tsx')), 'Actual NativePlayer contract must be bundled');
  assert.ok(sourceInputs.some((input) => input.endsWith('useWatchPartySession.ts')), 'Actual party hook must be bundled');
  assert.ok(sourceInputs.some((input) => input.endsWith('ConsentBanner.tsx')), 'Actual consent reader must be bundled');
  const fixture = { server: module.exports, client: client.outputFiles[0].text };
  assert.equal(fixture.server.version, react.version);
  bundles.set(nativeMode, fixture);
  return fixture;
}

const keys = {
  consent: ['local', 'lumora.consent.v1'],
  preroll: ['session', 'lumora:preroll-shown'],
  checkpoints: ['local', 'lumora:playback-checkpoints:v1'],
  display: ['local', 'lumora:player:display-mode:v1'],
  ping: ['local', 'lumora:player:show-ping:v1'],
  autonext: ['local', 'lumora:player:auto-next:v1'],
  party: ['session', 'lumora:watch-party:web:v1'],
};
const titleId = '00000000-0000-4000-8000-000000000001';
const roomCode = 'ABCDE23456';
const episodeHref = '/watch/tv/private-hydration?season=1&episode=3';

function propsFor(scenario, now) {
  const direct = { id: 'fixture-native', providerId: 'private-fixture', label: 'Direct', kind: 'hls',
    url: '/fixture/media?stream=0', streamCatalogUrl: '/fixture/catalog', consentRequired: false };
  const embed = { id: 'fixture-embed', providerId: 'private-fixture', label: 'Fixture embed', kind: 'iframe',
    url: '/fixture/embed', consentRequired: false };
  const props = {
    title: { id: titleId, name: 'Private Hydration Fixture', slug: 'private-hydration', type: 'tv', tmdbId: '999999999' },
    source: direct, sources: [direct, embed], viewerKey: 'guest',
    episodeId: '00000000-0000-4000-8000-000000000002', seasonNumber: 1, episodeNumber: 2,
    nextEpisode: { season: 1, episode: 3, label: 'S1 E3', name: 'Next Private Episode' },
    initialPosition: 12.75, resumeUpdatedAt: now - 60_000,
    introCatalogUrl: '/fixture/intro',
    watchPartyConfigured: true, reportingAvailable: false,
    watchPartyMedia: { kind: 'episode', mediaId: titleId, seasonNumber: 1, episodeNumber: 2 },
    adPolicy: { enabled: false, firstBreakSeconds: 900, intervalSeconds: 900, maxBreaks: 3, allowSkip: true, skipAfterSeconds: 5 },
  };
  if (scenario === 'preroll') props.preroll = { adsterraKey: 'private-nonfunctional-fixture-key', width: 320, height: 50 };
  if (scenario === 'consent') props.source = { ...direct, consentRequired: true };
  if (scenario === 'party-query') props.initialPartyRoomCode = roomCode;
  if (scenario === 'party-unavailable') { props.watchPartyConfigured = false; props.initialPartyRoomCode = roomCode; }
  if (scenario === 'navigation-api') props.episodeNavigationUrl = '/fixture/navigation';
  if (scenario === 'unavailable') { props.source = null; props.sources = []; props.error = { code: 'not-found' }; }
  if (scenario === 'embed-consent') props.source = { ...embed, consentRequired: true };
  return JSON.parse(JSON.stringify(props));
}

function storageFor(variant, props, now) {
  const config = { local: {}, session: {}, throwKeys: [], getterThrows: null };
  const values = {
    consent: JSON.stringify({ necessary: true, analytics: false, ads: true, decidedAt: '2026-11-04T00:00:00.000Z' }),
    preroll: '1',
    checkpoints: JSON.stringify([{ viewerKey: props.viewerKey, mediaKey: JSON.stringify([titleId, 'episode', 1, 2]),
      positionSeconds: 37.125, durationSeconds: 120, updatedAt: now - 1000, pendingSync: true }]),
    display: 'zoom', ping: 'true', autonext: 'true',
    party: JSON.stringify({ v: 1, roomCode, participantId: '00000000-0000-4000-8000-000000000003',
      resumeToken: 'wp1.PRIVATE_FIXTURE.NO_REAL_TOKEN', expiresAtMs: now + 3_600_000 }),
  };
  const seed = (name) => { const [scope, key] = keys[name]; config[scope][key] = values[name]; };
  if (['persisted', 'throwing-methods', 'preroll-pending', 'malformed', 'local-getter-throws', 'session-getter-throws'].includes(variant)
    || variant.startsWith('throw:')) for (const name of Object.keys(keys)) seed(name);
  if (variant.startsWith('only:')) seed(variant.slice(5));
  if (variant.startsWith('throw:')) config.throwKeys.push(keys[variant.slice(6)][1]);
  if (variant === 'throwing-methods') config.throwKeys = Object.values(keys).map((entry) => entry[1]);
  if (variant === 'preroll-pending') delete config.session[keys.preroll[1]];
  if (variant === 'malformed') {
    for (const [scope, key] of Object.values(keys)) config[scope][key] = '{invalid-json';
  }
  if (variant === 'local-getter-throws') config.getterThrows = 'local';
  if (variant === 'session-getter-throws') config.getterThrows = 'session';
  if (variant === 'legacy-checkpoint') config.local['lumora:guest-continue-watching'] = JSON.stringify([{
    slug: props.title.slug, type: 'tv', name: props.title.name, episodeId: props.episodeId,
    seasonNumber: 1, episodeNumber: 2, positionSeconds: 37.125, progress: 37.125 / 120, updatedAt: now - 1000,
  }]);
  return config;
}

function initializeBrowser(config) {
  const state = window.__playerFixture = { storage: [], actions: [], navigation: [], players: [], transports: [],
    transportRequests: [], transportMessages: [], fetches: [], blocked: [], recoverable: [], uncaught: [], caught: [],
    browserErrors: [], consoleErrors: [], commits: 0 };
  const describe = (value) => value instanceof Error
    ? { name: value.name, message: value.message, stack: value.stack } : value;
  const originalError = console.error.bind(console);
  console.error = (...args) => { state.consoleErrors.push(args.map(describe)); originalError(...args); };
  window.addEventListener('error', (event) => state.browserErrors.push({ message: event.message,
    stack: event.error?.stack ?? null, filename: event.filename, line: event.lineno }));
  window.addEventListener('unhandledrejection', (event) => state.browserErrors.push(describe(event.reason)));
  for (const scope of ['local', 'session']) {
    const data = new Map(Object.entries(config[scope]));
    const access = (operation, key) => {
      state.storage.push({ scope, operation, key });
      if (config.throwKeys.includes(key)) throw new DOMException(`Private fixture ${scope} storage method denied`, 'SecurityError');
    };
    const storage = {
      get length() { return data.size; },
      key: (index) => [...data.keys()][index] ?? null,
      getItem(key) { access('get', key); return data.get(key) ?? null; },
      setItem(key, value) { access('set', key); data.set(key, String(value)); },
      removeItem(key) { access('remove', key); data.delete(key); },
      clear() { data.clear(); },
    };
    Object.defineProperty(window, `${scope}Storage`, { configurable: true, get() {
      if (config.getterThrows === scope) {
        state.storage.push({ scope, operation: 'getter', key: null });
        throw new DOMException(`Private fixture ${scope} storage getter denied`, 'SecurityError');
      }
      return storage;
    } });
  }
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url, window.location.href);
    state.fetches.push({ path: url.pathname, method: init?.method ?? 'GET' });
    if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const bodies = {
      '/api/health': { ok: true }, '/api/subtitles': { tracks: [] }, '/fixture/intro': { intro: null },
      '/fixture/catalog': { streams: [{ id: '0', url: '/fixture/media?stream=0', qualities: [], audioTracks: [], subtitles: [] }] },
      '/fixture/navigation': { previous: null, next: { seasonNumber: 1, episodeNumber: 3,
        name: 'Next Private Episode', href: '/watch/tv/private-hydration?season=1&episode=3' } },
    };
    if (url.origin !== window.location.origin || !(url.pathname in bodies)) {
      state.blocked.push({ kind: 'fetch', path: url.pathname });
      throw new Error('Unapproved fixture fetch');
    }
    return new Response(JSON.stringify(bodies[url.pathname]), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  window.WebSocket = class { constructor() { state.blocked.push({ kind: 'websocket' }); throw new Error('No real fixture sockets'); } };
  window.XMLHttpRequest = class { constructor() { state.blocked.push({ kind: 'xhr' }); throw new Error('No real fixture XHR'); } };
  navigator.sendBeacon = () => { state.blocked.push({ kind: 'beacon' }); return false; };
}

async function settle(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });
}

function readable(config, name) {
  const [scope, key] = keys[name];
  return config.getterThrows !== scope && !config.throwKeys.includes(key) ? config[scope][key] : undefined;
}

function assertNoErrors(diagnostic) {
  for (const name of ['recoverable', 'uncaught', 'caught', 'browserErrors', 'consoleErrors', 'blocked']) {
    assert.equal(diagnostic[name].length, 0, `${name} must be empty`);
  }
}

const browser = await chromium.launch({ headless: true });
const cases = [];
const negativeControls = [];

async function runCase({ scenario, variant, nativeMode, viewport, strict = false, negative = false }) {
  const label = `${nativeMode}/${viewport}/${scenario}/${variant}${strict ? '/strict' : ''}`;
  const now = Date.now();
  const props = propsFor(scenario, now);
  const config = storageFor(variant, props, now);
  const fixture = await loadFixture(nativeMode);
  const context = await browser.newContext(viewport === 'mobile'
    ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }
    : { viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  let result = { label, pass: false };
  let stage = 'server-render';
  let serverMarkup;
  const requests = [];
  try {
    serverMarkup = fixture.server.renderMarkup(props, strict);
    const contract = fixture.server.renderNativeContract({ source: props.source ?? { url: '/fixture/media', kind: 'hls' }, titleId,
      titleSlug: props.title.slug, titleName: props.title.name });
    assert.equal(contract.actual, contract.stub, 'The native DOM stub must match the real initial SSR markup exactly');
    assert.deepEqual(lexicalHtmlStructure(contract.stub), ['div', 'div/div']);
    const wrapped = `<div id="private-fixture-root">${serverMarkup}</div>`;
    await context.addInitScript(initializeBrowser, config);
    await page.clock.install({ time: new Date(now) });
    const url = `http://fixture.invalid/watch/tv/private-hydration?season=1&episode=2${scenario === 'party-query' ? `&party=${roomCode}` : ''}`;
    await context.route('**/*', async (route) => {
      const requested = route.request().url();
      const parsed = new URL(requested);
      if (requested === url && route.request().isNavigationRequest()) {
        await route.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html><html><head><meta charset="utf-8"></head><body>${wrapped}</body></html>` });
      } else if (parsed.origin === 'http://fixture.invalid' && ['/fixture/embed', '/api/ad-frame', '/favicon.ico'].includes(parsed.pathname)) {
        requests.push({ path: parsed.pathname, fake: true });
        await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Private inert fixture</title>' });
      } else {
        requests.push({ path: parsed.pathname, blocked: true });
        await route.abort();
      }
    });
    await page.goto(url, { waitUntil: 'load' });
    stage = 'static-html-parse';
    const parsed = await page.evaluate(browserHtmlStructure, wrapped);
    assert.deepEqual(parsed, lexicalHtmlStructure(wrapped), 'Browser HTML parsing must not repair the SSR hierarchy');
    const initialContract = await page.evaluate(() => {
      const frame = document.querySelector('.lumora-player-frame');
      return !frame || (frame.childElementCount === 1 && frame.firstElementChild.localName === 'div'
        && frame.firstElementChild.childNodes.length === 0 && frame.firstElementChild.hasAttribute('data-vjs-player'));
    });
    assert.equal(initialContract, true, 'Mounted native SSR must contain an empty inner DIV, never an initial VIDEO');
    await page.addScriptTag({ content: fixture.client });
    stage = 'client-first-render';
    const clientInitial = await page.evaluate(({ props, strict }) => window.PlayerHydrationFixture.renderMarkup(props, strict), { props, strict });
    assert.equal(clientInitial, serverMarkup, 'Window/storage/viewport must not change the client first-render markup');
    const renderStorage = await page.evaluate(() => window.__playerFixture.storage.length);
    assert.equal(renderStorage, 0, 'Storage access must wait until effects, not occur in SSR/first render');
    if (negative) await page.locator('section[aria-label="Player for Private Hydration Fixture"] > p').evaluate((element) => {
      element.textContent = 'Deliberate private fixture mismatch';
    });
    await page.evaluate(({ props, strict }) => window.PlayerHydrationFixture.hydrate(props, strict), { props, strict });
    stage = 'hydration-and-effects';
    await page.waitForFunction(() => window.__playerFixture.commits > 0 || window.__playerFixture.uncaught.length > 0);
    await settle(page);
    if (negative) {
      const errors = await page.evaluate(() => window.__playerFixture.recoverable);
      assert.ok(errors.length > 0, 'Negative control must actually invoke onRecoverableError');
      assert.match(errors[0].message, /hydration|418|didn.t match/i);
      negativeControls.push({ label, pass: true, errors });
      return;
    }
    assertNoErrors(await page.evaluate(() => window.__playerFixture));
    stage = 'post-hydration-behavior';
    if (scenario === 'consent' || scenario === 'embed-consent') {
      assert.equal(await page.getByRole('group', { name: 'External player consent' }).count(), 1,
        'Persisted privacy consent must not remove the explicit provider gate');
      assert.equal(await page.locator('.lumora-player-frame').count(), 0);
      await page.getByRole('button', { name: 'Load external player' }).evaluate((element) => element.click());
      await settle(page);
    }
    if (scenario === 'preroll' && readable(config, 'consent') && readable(config, 'consent') !== '{invalid-json'
      && !readable(config, 'preroll')) {
      assert.ok((await page.locator('body').textContent()).includes('Advertisement'), 'Consented unseen preroll must mount after hydration');
      await page.clock.fastForward(8500);
      await settle(page);
    }
    const nativeVisible = !['unavailable', 'embed-consent'].includes(scenario);
    if (nativeVisible && nativeMode === 'actual-native') {
      await page.waitForFunction(() => window.__playerFixture.players.length > 0
        && document.querySelector('button[aria-label="Settings"]'));
      assert.equal(await page.locator('video-js').count(), 1, 'The actual native effect must initialize the video fake');
      const position = await page.evaluate(() => window.__playerFixture.players.at(-1).fixtureState.position);
      const checkpoint = readable(config, 'checkpoints');
      const expectedPosition = (checkpoint && checkpoint !== '{invalid-json') || variant === 'legacy-checkpoint' ? 37.125 : 12.75;
      assert.equal(position, expectedPosition, 'Actual native storage effects must select the expected resume point');
      await page.getByRole('button', { name: 'Settings', exact: true }).evaluate((element) => element.click());
      await settle(page);
      const expectedDisplay = readable(config, 'display') === 'zoom' ? 'Zoom' : 'Fit';
      assert.equal(await page.getByRole('button', { name: new RegExp(`^Display mode ${expectedDisplay}\\.`) }).count(), 1);
      assert.equal(await page.locator('.lumora-player-ping').count(), readable(config, 'ping') === 'true' ? 1 : 0);
      const autoNext = page.getByRole('button', { name: /^Turn (?:on|off) Auto Next$/ });
      assert.equal(await autoNext.getAttribute('aria-pressed'), String(readable(config, 'autonext') === 'true'));
    }
    if (nativeVisible && nativeMode === 'native-dom-contract') {
      const nativeProps = await page.evaluate(() => window.__playerFixture.nativeProps);
      assert.equal(nativeProps.autoNext, readable(config, 'autonext') === 'true');
      assert.equal(nativeProps.navigation.next.href, episodeHref);
    }
    if (scenario === 'party-query') {
      assert.equal(await page.getByRole('dialog', { name: 'Watch Party', exact: true }).count(), 1);
      assert.equal(await page.getByLabel('Room code', { exact: true }).inputValue(), roomCode);
      const party = readable(config, 'party');
      assert.equal(await page.getByRole('button', { name: `Resume ${roomCode}`, exact: true }).count(),
        party && party !== '{invalid-json' ? 1 : 0);
    }
    if (scenario === 'party-unavailable') {
      const panel = page.getByRole('dialog', { name: 'Watch Party', exact: true });
      assert.equal(await panel.count(), 1);
      assert.ok((await panel.textContent()).includes('Watch Party unavailable'));
      assert.equal(await panel.getByRole('button', { name: /Create party|Join room|Resume / }).count(), 0);
      assert.equal(await page.getByRole('button', { name: 'Watch Party unavailable', exact: true }).isDisabled(), true);
    }
    for (const reportButton of await page.getByRole('button', { name: 'Report playback issue', exact: true }).all()) {
      assert.equal(await reportButton.isDisabled(), true, 'Unconfigured reporting must be disabled before any action');
    }
    assert.ok((await page.locator('body').textContent()).includes('Reporting unavailable'));
    const diagnostics = await page.evaluate(() => {
      const state = window.__playerFixture;
      return { ...state, players: state.players.map((player) => player.fixtureState), transports: state.transports.length,
        rootAfter: document.getElementById('private-fixture-root').outerHTML };
    });
    assert.equal(diagnostics.propsJSON, JSON.stringify(props), 'SSR and hydration must receive identical serialized props');
    assert.equal(diagnostics.transportRequests.length, 0, 'Party/query/resume storage cannot open a real or fake room without user action');
    assertNoErrors(diagnostics);
    assert.equal(requests.filter((request) => request.blocked).length, 0, 'No unapproved browser requests');
    await page.evaluate(() => window.PlayerHydrationFixture.unmount());
    await settle(page);
    assertNoErrors(await page.evaluate(() => window.__playerFixture));
    result = { label, pass: true, staticParse: true, firstRenderEqual: true, identicalProps: true, recoverableErrors: 0,
      storageReads: diagnostics.storage.filter((access) => access.operation === 'get').length,
      actualNativeInitialized: nativeVisible && nativeMode === 'actual-native', ssrSHA256: hash(serverMarkup),
      strict, rootBeforeLength: diagnostics.rootBefore.length, rootAfterLength: diagnostics.rootAfter.length };
  } catch (error) {
    let diagnostic = null;
    try {
      diagnostic = await page.evaluate(() => {
        const state = window.__playerFixture;
        return state ? { ...state, players: state.players.map((player) => player.fixtureState), transports: state.transports.length,
          rootAfter: document.getElementById('private-fixture-root')?.outerHTML ?? null } : null;
      });
    } catch { /* A failed document load still retains the assertion/SSR stack. */ }
    result = { label, pass: false, stage, failure: { name: error.name, message: error.message, stack: error.stack }, diagnostic,
      serverMarkup: serverMarkup ?? null, requests };
    if (negative) negativeControls.push(result);
  } finally {
    if (!negative) cases.push(result);
    await context.close();
  }
}

try {
  for (const nativeMode of ['actual-native', 'native-dom-contract']) {
    for (const viewport of ['desktop', 'mobile']) {
      for (const scenario of ['fallback', 'preroll', 'consent', 'party-query', 'party-unavailable', 'navigation-api', 'unavailable', 'embed-consent']) {
        for (const variant of ['empty', 'persisted', 'throwing-methods']) {
          if (smoke && (nativeMode !== 'actual-native' || variant !== 'persisted' || !['fallback', 'party-query'].includes(scenario))) continue;
          await runCase({ scenario, variant, nativeMode, viewport });
        }
      }
    }
  }
  for (const viewport of ['desktop', 'mobile']) {
    for (const name of Object.keys(keys)) {
      if (smoke) continue;
      for (const prefix of ['only', 'throw']) await runCase({ scenario: name === 'party' ? 'party-query' : name === 'preroll' || name === 'consent' ? 'preroll' : 'fallback',
        variant: `${prefix}:${name}`, nativeMode: 'actual-native', viewport });
    }
    for (const variant of ['preroll-pending', 'malformed', 'legacy-checkpoint', 'local-getter-throws', 'session-getter-throws']) {
      if (smoke && variant !== 'preroll-pending') continue;
      await runCase({ scenario: variant === 'preroll-pending' ? 'preroll' : 'party-query', variant, nativeMode: 'actual-native', viewport });
    }
    if (!smoke) await runCase({ scenario: 'party-query', variant: 'persisted', nativeMode: 'actual-native', viewport, strict: true });
    await runCase({ scenario: 'fallback', variant: 'empty', nativeMode: 'actual-native', viewport, negative: true });
  }
  const invalid = '<div><p><div>Private invalid fixture</div></p></div>';
  const controlPage = await browser.newPage();
  const browserStructure = await controlPage.evaluate(browserHtmlStructure, invalid);
  assert.notDeepEqual(browserStructure, lexicalHtmlStructure(invalid), 'Static parser negative control must detect browser repair');
  negativeControls.push({ label: 'invalid-html-parse-repair', pass: true, lexical: lexicalHtmlStructure(invalid), browser: browserStructure });
  await controlPage.close();
} finally {
  await browser.close();
}

const sourceSnapshot = [];
for (const [filename, contents] of snapshots) {
  if (!filename.startsWith(path.join(project, 'src'))) continue;
  const current = await readFile(filename, 'utf8');
  sourceSnapshot.push({ file: path.relative(project, filename).replaceAll('\\', '/'), sha256: hash(contents), changedDuringRun: current !== contents });
}
const failures = cases.filter((result) => !result.pass);
const report = {
  fixture: 'Private actual-source PlayerShell SSR/hydration regression', react: react.version, reactMode: mode,
  browser: 'Installed Playwright Chromium', syntheticDataOnly: true, sourceSnapshot,
  summary: { cases: cases.length, passed: cases.length - failures.length, failed: failures.length,
    negativeControls: negativeControls.length, negativeControlsPassed: negativeControls.filter((result) => result.pass).length,
    unexpectedRecoverableErrors: failures.reduce((sum, result) => sum + (result.diagnostic?.recoverable.length ?? 0), 0),
    unexpectedUncaughtErrors: failures.reduce((sum, result) => sum + (result.diagnostic?.uncaught.length ?? 0), 0) },
  proofLimits: [
    'No Next RSC/streaming/workerd artifact, real route data, CSP, or production browser acceptance is exercised.',
    'The native-dom-contract mode isolates PlayerShell; only actual-native mode exercises NativePlayer storage/portal effects.',
    'Video readiness is deterministic fake state, not real media decoding or performance evidence.',
    'All server actions, Next navigation, watch-party transport, fetches, and ad/embed frame documents are private fakes.',
    'SSR and client bundles share pinned actual-source contents; changedDuringRun flags limit claims about current source.',
    'Referenced external browser reports are not loaded by this fixture; it cannot attribute an artifact-only React418 failure.',
  ],
  cases: cases.filter((result) => result.pass), failures, negativeControls,
};
const reportArgument = process.argv.find((arg) => arg.startsWith('--report='));
const reportPath = reportArgument ? path.resolve(reportArgument.slice('--report='.length))
  : path.join(directory, `report.${mode}${smoke ? '.smoke' : ''}.json`);
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ report: reportPath, react: report.react, reactMode: mode, summary: report.summary,
  sourceChangedDuringRun: sourceSnapshot.filter((source) => source.changedDuringRun),
  playerShell: sourceSnapshot.find((source) => source.file.endsWith('/PlayerShell.tsx')),
  failures: failures.map((result) => ({ label: result.label, stage: result.stage, failure: result.failure.message,
    recoverable: result.diagnostic?.recoverable, uncaught: result.diagnostic?.uncaught })),
  negativeControls: negativeControls.map((result) => ({ label: result.label, pass: result.pass,
    error: result.errors?.[0]?.message ?? null })),
}, null, 2));
if (failures.length || negativeControls.some((result) => !result.pass)) process.exitCode = 1;
