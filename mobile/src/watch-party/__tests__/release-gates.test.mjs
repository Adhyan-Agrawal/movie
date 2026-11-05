import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { getStateFromPath } from '@react-navigation/core';
import { ROOT, deferred, film, named, nodes, text } from '../../components/__tests__/browse-harness.mjs';

const require = createRequire(import.meta.url);
const compiled = new Map();
const direct = { id: 'direct', kind: 'hls', label: 'Direct', url: 'https://hulkofyt.eu.org/api/vidnest?stream=auto', consentRequired: false };
const external = { id: 'external', kind: 'embed', label: 'External', url: 'https://hulkofyt.eu.org/watch/tv/example-1399', consentRequired: false };
const tvParams = { titleId: 'tmdb:tv:1399', type: 'tv', slug: 'example-1399', name: 'Example', tmdbId: '1399', season: 2, episode: 3 };
const episodeUrl = 'https://hulkofyt.eu.org/api/episode-navigation?type=tv&tmdbId=1399&season=2&episode=3';
const neighbors = { previous: { seasonNumber: 2, episodeNumber: 2, name: 'Previous', href: '/watch/tv/example-1399?season=2&episode=2' },
  next: { seasonNumber: 2, episodeNumber: 4, name: 'Next', href: '/watch/tv/example-1399?season=2&episode=4' } };

// Execute the owned components and APIs with deterministic hooks/native ports, not an Android renderer.
function harness(options = {}) {
  const modules = new Map(), roots = [], timers = new Map(), calls = [], navigation = [];
  const storage = new Map(Object.entries(options.storage ?? {}));
  let owner, timerId = 0;
  const depsEqual = (left, right) => left && right && left.length === right.length && left.every((item, i) => Object.is(item, right[i]));
  const slot = (kind, initial) => owner.slots[owner.cursor++] ??= { kind, ...initial };
  const react = {
    useState(initial) {
      const root = owner;
      const state = slot('state', { value: typeof initial === 'function' ? initial() : initial });
      return [state.value, (next) => {
        if (!root.alive) { root.lateWrites++; return; }
        const value = typeof next === 'function' ? next(state.value) : next;
        if (!Object.is(state.value, value)) { state.value = value; root.dirty = true; }
      }];
    },
    useRef(initial) { return slot('ref', { value: { current: initial } }).value; },
    useMemo(factory, deps) {
      const state = slot('memo', {});
      if (!depsEqual(state.deps, deps)) { state.deps = deps; state.value = factory(); }
      return state.value;
    },
    useCallback(callback, deps) { return react.useMemo(() => callback, deps); },
    useEffect(effect, deps) {
      const state = slot('effect', {});
      if (!depsEqual(state.deps, deps)) { state.deps = deps; state.effect = effect; state.pending = true; }
    },
  };
  const record = (name, fn) => (...args) => { calls.push({ name, args }); return fn(...args); };
  const session = options.session ?? null;
  const supabaseModule = { supabaseConfigured: options.authConfigured ?? false, supabase: {
    auth: {
      signUp: record('auth.signUp', async () => {
        if (options.signUpReject) throw new Error('auth unavailable');
        return options.signUp ?? { data: { session: null, user: null }, error: null };
      }),
      signInWithPassword: record('auth.signIn', async () => options.signIn ?? { data: { session: null }, error: null }),
      getSession: record('auth.getSession', async () => {
        if (options.sessionReject) throw new Error('auth unavailable');
        return { data: { session }, error: options.sessionError ?? null };
      }),
      getUser: record('auth.getUser', async () => ({ data: { user: options.user ?? session?.user ?? null }, error: options.userError ?? null })),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
    from: record('private.from', (table) => {
      if (!options.queries?.[table]) throw new Error(`Unexpected private query: ${table}`);
      const query = {};
      for (const method of ['select', 'eq', 'order', 'limit', 'abortSignal']) query[method] = () => query;
      query.maybeSingle = async () => options.queries[table];
      return query;
    }),
  } };
  const asyncStorage = { getItem: record('storage.getItem', async (key) => storage.get(key) ?? null),
    setItem: record('storage.setItem', async (key, value) => { storage.set(key, value); }), removeItem: async (key) => { storage.delete(key); } };
  const party = { state: { phase: 'idle', room: null, self: null, playback: null, participants: [], chat: [], error: null, rateLimitedUntilMs: null },
    savedResume: null, syncStatus: 'ready', registerPlayerPort() {}, leave() {}, clearError() {},
    ...options.party };
  for (const method of ['create', 'join', 'resume', 'retry', 'sendChat', 'transferHost', 'notifySourceChange']) {
    party[method] = record(`party.${method}`, () => true);
  }
  class AnimatedValue { interpolate() { return 0; } }
  const native = { StyleSheet: { create: (styles) => styles, absoluteFill: {} }, Platform: { OS: 'android', Version: 36 },
    AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
    BackHandler: { addEventListener: () => ({ remove() {} }) }, useWindowDimensions: () => ({ width: 390, height: 844 }),
    Animated: { Value: AnimatedValue, View: 'AnimatedView', timing: () => ({ start() {}, stop() {} }) } };
  for (const name of ['View', 'Text', 'Pressable', 'ScrollView', 'TextInput', 'ActivityIndicator', 'KeyboardAvoidingView', 'Modal', 'RefreshControl']) native[name] = name;
  const player = { currentTime: 0, duration: 0, playing: false, playbackRate: 1, status: 'idle', availableAudioTracks: [], availableSubtitleTracks: [],
    listeners: new Map(), addListener(name, listener) {
      const listeners = this.listeners.get(name) ?? new Set(); listeners.add(listener); this.listeners.set(name, listeners);
      return { remove: () => listeners.delete(listener) };
    }, emit(name, value) { for (const listener of this.listeners.get(name) ?? []) listener(value); },
    play() { this.playing = true; this.emit('playingChange', { isPlaying: true }); },
    pause() { this.playing = false; this.emit('playingChange', { isPlaying: false }); },
    replaceAsync: record('player.replaceAsync', async (source) => { player.source = source; player.emit('sourceChange', { source }); }),
    ready(duration = 120) {
      this.duration = duration; this.status = 'readyToPlay';
      this.emit('sourceLoad', { videoSource: this.source, duration, availableAudioTracks: [], availableSubtitleTracks: [] });
      this.emit('statusChange', { status: this.status });
    }, end(position = this.duration) { this.currentTime = position; this.emit('playToEnd'); },
  };
  const nav = {};
  for (const action of ['navigate', 'replace', 'goBack']) nav[action] = (name, params) => navigation.push({ action, name, params });
  nav.canGoBack = () => true;
  const jsx = (type, props, key) => ({ type, props: props ?? {}, key });
  const stubs = {
    'react': react, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' }, 'react-native': native,
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 24, bottom: 24, left: 0, right: 0 }) },
    '@react-navigation/native': { useNavigation: () => nav, useRoute: () => ({ params: options.route ?? tvParams }),
      useFocusEffect: (effect) => react.useEffect(effect, [effect]) },
    '@supabase/supabase-js': { createClient: () => ({ auth: {}, from() { throw new Error('Unexpected legacy public query'); } }) },
    '@react-native-async-storage/async-storage': asyncStorage,
    'expo-status-bar': { StatusBar: 'StatusBar' }, 'react-native-webview': { WebView: 'WebView' },
    'expo-screen-orientation': { OrientationLock: { DEFAULT: 0, LANDSCAPE: 1 } },
    'expo-video': { VideoView: 'VideoView', isPictureInPictureSupported: () => false,
      useVideoPlayer: () => player },
  };
  const local = {
    'src/lib/supabase.ts': supabaseModule,
    'src/components/ui.tsx': Object.fromEntries(['Button', 'Screen', 'Loading', 'EmptyState'].map((name) => [name, name])),
    'src/components/Row.tsx': { Row: 'Row' }, 'src/components/SubscriptionStatus.tsx': { SubscriptionStatus: 'SubscriptionStatus' },
    'src/ads/AdMobProvider.tsx': { AdMobPrivacyChoices: 'AdMobPrivacyChoices' },
    'src/player/orientation.ts': { acquireOrientation: () => () => {} },
    'src/player/VastAdBreak.tsx': { default: 'NativeVastAd' },
    'src/lib/guest.ts': { getGuestResume: async () => null, recordGuestWatch: record('guest.record', async () => {}),
      updateGuestPosition: async () => {}, readGuestEntries: async () => options.guestEntries ?? [] },
    'src/watch-party/useWatchPartySession.ts': { useWatchPartySession: () => party },
    ...(options.catalog ? { 'src/lib/catalog-bridge.ts': { getTitleDetails: record('catalog.getTitleDetails', options.catalog) } } : {}),
    'admob.config.js': { resolveAdMobConfig: () => ({}) },
  };
  function load(path) {
    let filename = resolve(ROOT, path);
    if (!existsSync(filename)) filename = [filename + '.tsx', filename + '.ts', filename + '.js'].find(existsSync);
    assert.ok(filename, `Missing test module: ${path}`);
    const relative = filename.slice(ROOT.length + 1).replaceAll('\\', '/');
    if (local[relative]) return local[relative];
    if (modules.has(filename)) return modules.get(filename).exports;
    const module = { exports: {} }; modules.set(filename, module);
    if (!compiled.has(filename)) {
      const result = ts.transpileModule(readFileSync(filename, 'utf8'), { fileName: filename, reportDiagnostics: true,
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } });
      assert.equal(result.diagnostics?.filter((item) => item.category === ts.DiagnosticCategory.Error).length ?? 0, 0);
      compiled.set(filename, result.outputText);
    }
    vm.runInNewContext(compiled.get(filename), { module, exports: module.exports, console, URL, URLSearchParams,
      AbortController, Response, TextEncoder, TextDecoder, queueMicrotask, process: { env: options.env ?? {} },
      fetch: record('fetch', options.fetch ?? (async () => { throw new Error('Unexpected network request'); })),
      setTimeout: (callback) => { const id = ++timerId; timers.set(id, callback); return id; }, clearTimeout: (id) => timers.delete(id),
      require: (name) => stubs[name] ?? (name.startsWith('.') ? load(resolve(dirname(filename), name)) : (() => { throw new Error(`Unexpected dependency: ${name}`); })()),
    }, { filename });
    if (relative === 'src/lib/api.ts') for (const [name, implementation] of Object.entries(options.api ?? {})) module.exports[name] = record(name, implementation);
    return module.exports;
  }
  function mount(component, props = {}) {
    const root = { component, props, slots: [], cursor: 0, alive: true, dirty: true, lateWrites: 0,
      render() {
        this.cursor = 0; this.dirty = false; owner = this;
        try { this.tree = this.component(this.props); } finally { owner = undefined; }
        for (const state of this.slots) if (state.kind === 'effect' && state.pending) {
          state.pending = false; state.cleanup?.(); state.cleanup = state.effect();
        }
        return this.tree;
      }, unmount() { if (!this.alive) return; this.alive = false; for (const state of this.slots) state.cleanup?.(); } };
    roots.push(root); root.render(); return root;
  }
  return { load, mount, calls, navigation, nav, player, storage, supabaseModule,
    async flush() { for (let i = 0; i < 40; i++) { await Promise.resolve(); for (const root of roots) if (root.alive && root.dirty) root.render(); } },
    dispose() { for (const root of roots) root.unmount(); timers.clear(); } };
}

function control(tree, label) {
  const node = nodes(tree).find((item) => item.props.label === label || item.props.accessibilityLabel === label);
  assert.ok(node, `Missing control: ${label}`); return node;
}
function autoControl(tree) { return nodes(tree).find((item) => item.props.label?.startsWith('Auto Next:')); }
async function fillAuth(h, root) {
  control(root.tree, 'Email address').props.onChangeText(' viewer@example.com ');
  control(root.tree, 'Password').props.onChangeText('test-password'); await h.flush();
}
const playbackApi = (sources = [direct], extra = {}) => ({
  resolvePlaybackDetails: async () => ({ sources, episodeNavigationUrl: episodeUrl }),
  getPlaybackContext: async () => ({ viewerKey: 'guest', resume: null }), fetchEpisodeNavigation: async () => neighbors, ...extra,
});

test('auth configuration getter reads the independent Supabase flag, not public web availability', async () => {
  const h = harness({ env: { EXPO_PUBLIC_WEB_URL: 'not-a-url' } }); const api = h.load('src/lib/api.ts');
  assert.equal(api.isAuthConfigured(), false); h.supabaseModule.supabaseConfigured = true;
  assert.equal(api.isAuthConfigured(), true); assert.equal(h.calls.length, 0); h.dispose();
});

test('unconfigured auth returns unavailable before either Supabase authentication call', async () => {
  const h = harness(); const api = h.load('src/lib/api.ts');
  assert.equal((await api.signUp('viewer@example.com', 'test-password')).status, 'unavailable');
  assert.equal((await api.signIn('viewer@example.com', 'test-password')).ok, false);
  assert.equal(h.calls.filter((item) => item.name.startsWith('auth.')).length, 0); h.dispose();
});

test('signup requires a real session and distinguishes verification, errors, and signed-in outcomes', async () => {
  for (const [response, expected] of [
    [{ data: { session: null, user: { id: 'pending-user' } }, error: null }, 'verificationRequired'],
    [{ data: { session: null, user: null }, error: null }, 'verificationRequired'],
    [{ data: { session: { access_token: 'test-only-session' } }, error: null }, 'signedIn'],
    [{ data: { session: { access_token: 'test-only-session' } }, error: { message: 'Rejected' } }, 'error'],
  ]) {
    const h = harness({ authConfigured: true, signUp: response });
    const result = await h.load('src/lib/api.ts').signUp(' viewer@example.com ', 'test-password');
    assert.equal(result.status, expected); assert.equal(result.ok, undefined);
    assert.equal(h.calls[0].args[0].email, 'viewer@example.com');
    assert.equal(h.calls.filter((item) => item.name === 'auth.signUp').length, 1); h.dispose();
  }
});

test('a sessionless password sign-in never reports signed-in success', async () => {
  for (const session of [null, { access_token: 'test-only-session' }]) {
    const h = harness({ authConfigured: true, signIn: { data: { session }, error: null } });
    assert.equal((await h.load('src/lib/api.ts').signIn('viewer@example.com', 'test-password')).ok, Boolean(session)); h.dispose();
  }
});

test('a rejected signup transport returns unavailable rather than claiming verification or a session', async () => {
  const h = harness({ authConfigured: true, signUpReject: true });
  assert.equal((await h.load('src/lib/api.ts').signUp('viewer@example.com', 'test-password')).status, 'unavailable'); h.dispose();
});

test('unconfigured AuthScreen visibly disables fields and both submit paths without calls', async () => {
  const h = harness(); const root = h.mount(h.load('src/screens/AuthScreen.tsx').default, { navigation: h.nav });
  await fillAuth(h, root); assert.match(text(root.tree), /Account services are unavailable/);
  assert.equal(control(root.tree, 'Sign in').props.disabled, true);
  assert.equal(control(root.tree, 'Password').props.editable, false);
  await control(root.tree, 'Sign in').props.onPress(); await control(root.tree, 'Password').props.onSubmitEditing();
  control(root.tree, 'Switch to create account').props.onPress(); await h.flush();
  assert.equal(h.calls.length, 0); assert.equal(h.navigation.length, 0); h.dispose();
});

test('AuthScreen keeps verification-required signup on screen and navigates only with a session', async () => {
  for (const session of [null, { access_token: 'test-only-session' }]) {
    const h = harness({ authConfigured: true, signUp: { data: { session, user: { id: 'test-user' } }, error: null } });
    const root = h.mount(h.load('src/screens/AuthScreen.tsx').default, { navigation: h.nav });
    control(root.tree, 'Switch to create account').props.onPress(); await h.flush(); await fillAuth(h, root);
    assert.doesNotMatch(text(root.tree), /instant|straight away|no email confirmation/);
    await control(root.tree, 'Create account').props.onPress(); await h.flush();
    assert.equal(h.navigation.length, session ? 1 : 0);
    if (!session) { assert.match(text(root.tree), /not signed in yet/); assert.equal(h.calls.filter((item) => item.name === 'auth.signIn').length, 0); }
    h.dispose();
  }
});

test('guest Continue Watching copy does not promise transfer and does not read a private library', async () => {
  const h = harness({ guestEntries: [{ title: film }], api: { fetchContinueWatching: async () => { throw new Error('Private guest read'); } } });
  const root = h.mount(h.load('src/screens/AccountScreen.tsx').default); await h.flush();
  const row = named(root.tree, 'Row')[0]; assert.ok(row);
  assert.match(row.props.reason, /device only.*not transferred/);
  assert.equal(h.calls.filter((item) => item.name === 'fetchContinueWatching' || item.name.startsWith('auth.')).length, 0); h.dispose();
});

test('unconfigured, failed, and configured private identities remain distinct', async () => {
  for (const [options, expected] of [
    [{}, 'guest'], [{ authConfigured: true, sessionError: { message: 'Offline' } }, 'unavailable'],
    [{ authConfigured: true, sessionReject: true }, 'unavailable'],
    [{ authConfigured: true, session: { user: { id: 'native-user' } }, queries: { profiles: { data: null, error: null } } }, 'account:native-user'],
  ]) {
    const h = harness(options); const result = await h.load('src/lib/api.ts').getPlaybackContext('tmdb:movie:414906', 'movie');
    assert.equal(result.viewerKey, expected); h.dispose();
  }
});

test('Watch Party availability is an explicit default-off non-secret flag on the shared web origin', () => {
  for (const [env, expected] of [[{}, false], [{ EXPO_PUBLIC_WATCH_PARTY_AVAILABLE: 'false' }, false],
    [{ EXPO_PUBLIC_WATCH_PARTY_AVAILABLE: 'true' }, true],
    [{ EXPO_PUBLIC_WEB_URL: 'not-a-url', EXPO_PUBLIC_WATCH_PARTY_AVAILABLE: 'true' }, false]]) {
    const h = harness({ env }); const config = h.load('src/watch-party/config.ts');
    assert.equal(config.WATCH_PARTY_SERVICE_AVAILABLE, expected);
    assert.equal(config.WATCH_PARTY_CLOUDFLARE_BASE_URL, new URL(h.load('src/lib/runtime-config.ts').WEB_URL).origin); h.dispose();
  }
});

test('unavailable Watch Party disables create, join, resume, and keyboard submission before attempts', async () => {
  const h = harness({ party: { savedResume: { roomCode: 'ABCDEFGH23' } } });
  const root = h.mount(h.load('src/watch-party/WatchPartySheet.tsx').default, { open: true, onClose() {},
    session: h.load('src/watch-party/useWatchPartySession.ts').useWatchPartySession(), initialRoomCode: 'ABCDEFGH23' });
  assert.match(text(root.tree), /unavailable on the current service/);
  for (const label of ['Create party for this title', 'Join room', 'Resume ABCDEFGH23']) {
    const node = control(root.tree, label); assert.equal(node.props.disabled, true); node.props.onPress();
  }
  control(root.tree, 'Watch Party room code').props.onSubmitEditing(); await h.flush();
  assert.equal(h.calls.filter((item) => item.name.startsWith('party.')).length, 0); h.dispose();
});

test('unavailable Watch Party cannot display connected or synchronized claims from stale state', () => {
  const h = harness({ party: { state: { phase: 'connected', room: { roomCode: 'ABCDEFGH23' }, self: { role: 'host' },
    participants: [], error: null, rateLimitedUntilMs: null } } });
  const root = h.mount(h.load('src/watch-party/WatchPartySheet.tsx').default, { open: true, onClose() {},
    session: h.load('src/watch-party/useWatchPartySession.ts').useWatchPartySession() });
  assert.doesNotMatch(text(root.tree), /Connected|synchronization is active|Chat is ready/); h.dispose();
});

test('available Watch Party retains its existing real create and join controller paths', async () => {
  const h = harness({ env: { EXPO_PUBLIC_WATCH_PARTY_AVAILABLE: 'true' } });
  const root = h.mount(h.load('src/watch-party/WatchPartySheet.tsx').default, { open: true, onClose() {},
    session: h.load('src/watch-party/useWatchPartySession.ts').useWatchPartySession() });
  control(root.tree, 'Watch Party display name').props.onChangeText('Viewer');
  control(root.tree, 'Watch Party room code').props.onChangeText('ABCDEFGH23'); await h.flush();
  control(root.tree, 'Create party for this title').props.onPress(); control(root.tree, 'Join room').props.onPress();
  assert.equal(h.calls.filter((item) => item.name === 'party.create').length, 1);
  assert.equal(h.calls.filter((item) => item.name === 'party.join').length, 1); h.dispose();
});

test('public HTTPS and lumora scheme links resolve through the credential-free catalog with auth disabled', async () => {
  for (const url of ['https://hulkofyt.eu.org/watch/tv/example-1399?season=2&episode=3&party=ABCDEFGH23',
    'lumora://watch/tv/example-1399?season=2&episode=3&party=ABCDEFGH23']) {
    const path = url.replace(/^(?:https:\/\/hulkofyt\.eu\.org\/|lumora:\/\/)/, '');
    const state = getStateFromPath(path, { screens: { WatchPartyLink: { path: 'watch/:type/:slug', parse: { season: Number, episode: Number, party: String } } } });
    const h = harness({ route: state.routes[0].params, fetch: async () => new Response(JSON.stringify({
      title: { ...film, ...tvParams, id: tvParams.titleId }, cast: [], seasons: [{ id: 'season2', seasonNumber: 2,
        episodes: [{ id: 'episode3', seasonNumber: 2, episodeNumber: 3, name: 'Third episode' }] }],
    }), { status: 200 }) });
    const root = h.mount(h.load('src/watch-party/WatchPartyDeepLinkScreen.tsx').default); await h.flush();
    assert.equal(h.navigation[0]?.action, 'replace'); assert.equal(h.navigation[0]?.name, 'Player');
    const params = h.navigation[0].params;
    assert.equal(params.episodeId, 'episode3'); assert.equal(params.episodeName, 'Third episode'); assert.equal(params.party, 'ABCDEFGH23');
    assert.equal(params.nextEpisode, undefined);
    assert.equal(h.calls.filter((item) => item.name.startsWith('auth.') || item.name === 'private.from').length, 0);
    const request = h.calls.find((item) => item.name === 'fetch');
    assert.match(request.args[0], /^https:\/\/hulkofyt\.eu\.org\/api\/catalog\?/);
    assert.equal(request.args[1].credentials, 'omit'); assert.equal(request.args[1].redirect, 'error');
    assert.equal(request.args[1].headers, undefined); assert.doesNotMatch(text(root.tree), /verified app.?links/i); h.dispose();
  }
});

test('a late deep-link catalog completion cannot navigate after unmount', async () => {
  const pending = deferred(); const h = harness({ route: { type: 'movie', slug: film.slug },
    catalog: () => pending.promise });
  const root = h.mount(h.load('src/watch-party/WatchPartyDeepLinkScreen.tsx').default);
  assert.equal(h.calls.filter((item) => item.name === 'catalog.getTitleDetails').length, 1);
  root.unmount(); pending.resolve({ title: film, seasons: [], cast: [] }); await h.flush();
  assert.equal(h.navigation.length, 0); assert.equal(root.lateWrites, 0); h.dispose();
});

test('app-link manifest host configuration matches WEB_URL without claiming OS verification', () => {
  for (const env of [{}, { EXPO_PUBLIC_WEB_URL: '   ' }, { EXPO_PUBLIC_WEB_URL: 'https://lumora.adhyanagrawal777.workers.dev' }]) {
    const h = harness({ env }); const output = h.load('app.config.js')({ config: {} });
    assert.equal(output.android.intentFilters[0].data[0].host, new URL(h.load('src/lib/runtime-config.ts').WEB_URL).hostname); h.dispose();
  }
});

test('AutoNext stays visibly unavailable with no verified next episode, loading, or failed metadata', async () => {
  for (const [episodeOptions, reason] of [[{ next: null }, /No verified next/], [{ loading: true }, /Loading verified episodes/],
    [{ next: null, notice: 'Episode information is unavailable. Retry without reloading the video.' }, /Episode information is unavailable/]]) {
    const changes = []; const h = harness();
    const episodes = { previous: null, next: { label: 'S2 E4', onPress() {} }, autoNext: true, blocked: false, loading: false,
      onAutoNextChange: (value) => changes.push(value), ...episodeOptions };
    const root = h.mount(h.load('src/player/NativePlayer.tsx').default, { source: direct, initial: { positionSeconds: 0, playing: true }, episodes, onCheckpoint() {} });
    h.player.ready(); await h.flush(); const node = autoControl(root.tree);
    assert.equal(node.props.label, 'Auto Next: Unavailable'); assert.equal(node.props.disabled, true); assert.equal(node.props.selected, false);
    const accessible = h.mount(node.type, node.props).tree;
    assert.equal(accessible.props.accessibilityRole, 'switch'); assert.equal(accessible.props.accessibilityState.checked, false);
    node.props.onPress(); h.player.end(); await h.flush();
    assert.equal(changes.length, 0); assert.equal(episodes.autoNext, true); assert.match(text(root.tree), reason);
    assert.match(text(root.tree), /saved Auto Next preference is unchanged/); h.dispose();
  }
});

test('AutoNext waits for native readiness and is disabled again after a playback error', async () => {
  const changes = []; const h = harness(); const root = h.mount(h.load('src/player/NativePlayer.tsx').default, {
    source: direct, initial: { positionSeconds: 0, playing: true }, onCheckpoint() {},
    episodes: { previous: null, next: { label: 'S2 E4', onPress() {} }, autoNext: true, blocked: false, loading: false, onAutoNextChange: (value) => changes.push(value) },
  });
  assert.equal(autoControl(root.tree).props.disabled, true); autoControl(root.tree).props.onPress(); assert.equal(changes.length, 0);
  h.player.ready(); await h.flush(); assert.equal(autoControl(root.tree).props.label, 'Auto Next: On');
  assert.equal(autoControl(root.tree).props.disabled, false);
  autoControl(root.tree).props.onPress(); assert.deepEqual(changes, [false]);
  h.player.status = 'error'; h.player.emit('statusChange', { status: 'error' }); await h.flush();
  assert.equal(autoControl(root.tree).props.label, 'Auto Next: Unavailable'); assert.equal(autoControl(root.tree).props.disabled, true); h.dispose();
});

test('manual Previous/Next and the real content-ended AutoNext gate remain operational and deduplicated', async () => {
  const actions = []; const h = harness(); const root = h.mount(h.load('src/player/NativePlayer.tsx').default, {
    source: direct, initial: { positionSeconds: 0, playing: true }, onCheckpoint() {}, episodes: {
      previous: { label: 'S2 E2', onPress: () => actions.push('previous') }, next: { label: 'S2 E4', onPress: () => actions.push('next') },
      autoNext: true, blocked: false, loading: false, onAutoNextChange() {},
    },
  });
  h.player.ready(); await h.flush(); control(root.tree, 'Previous').props.onPress(); control(root.tree, 'Next').props.onPress();
  assert.deepEqual(actions, ['previous', 'next']); h.player.end(119); assert.equal(actions.length, 2);
  h.player.end(120); h.player.end(120); assert.deepEqual(actions, ['previous', 'next', 'next']); h.dispose();
});

test('WebView playback never requests unused episode navigation; native switching fetches verified controls once', async () => {
  const h = harness({ api: playbackApi([external, direct]) });
  const root = h.mount(h.load('src/screens/PlayerScreen.tsx').default); await h.flush();
  assert.equal(named(root.tree, 'WebView').length, 1); assert.equal(h.calls.filter((item) => item.name === 'fetchEpisodeNavigation').length, 0);
  assert.match(text(root.tree), /Watch Party unavailable/);
  control(root.tree, 'Source: Direct').props.onPress(); await h.flush();
  assert.equal(h.calls.filter((item) => item.name === 'fetchEpisodeNavigation').length, 1);
  const nativePlayer = named(root.tree, 'NativePlayer')[0]; assert.ok(nativePlayer.props.episodes.previous); assert.ok(nativePlayer.props.episodes.next);
  const footer = nativePlayer.props.footer; control(footer, 'Source: External').props.onPress(); await h.flush();
  assert.equal(named(root.tree, 'WebView').length, 1); assert.equal(h.calls.filter((item) => item.name === 'fetchEpisodeNavigation').length, 1); h.dispose();
});

test('native episode lookup is deferred until consent and stale completion after WebView switching is ignored', async () => {
  const pending = deferred(); const h = harness({ api: playbackApi([{ ...direct, consentRequired: true }, external], { fetchEpisodeNavigation: () => pending.promise }) });
  const root = h.mount(h.load('src/screens/PlayerScreen.tsx').default); await h.flush();
  assert.equal(h.calls.filter((item) => item.name === 'fetchEpisodeNavigation').length, 0);
  control(root.tree, 'Load player').props.onPress(); await h.flush();
  assert.equal(h.calls.filter((item) => item.name === 'fetchEpisodeNavigation').length, 1);
  control(named(root.tree, 'NativePlayer')[0].props.footer, 'Source: External').props.onPress(); await h.flush();
  pending.resolve(neighbors); await h.flush(); assert.equal(named(root.tree, 'WebView').length, 1); assert.equal(h.navigation.length, 0); h.dispose();
});

test('persisted AutoNext preference is retained while unavailable and does not write storage when guarded', async () => {
  const h = harness({ storage: { 'lumora:player:auto-next:v1': 'true' }, api: playbackApi([direct], { fetchEpisodeNavigation: async () => ({ previous: null, next: null }) }) });
  const root = h.mount(h.load('src/screens/PlayerScreen.tsx').default); await h.flush();
  const episodes = named(root.tree, 'NativePlayer')[0].props.episodes;
  assert.equal(episodes.autoNext, true); assert.equal(episodes.next, null); episodes.onAutoNextChange(false); await h.flush();
  assert.equal(h.storage.get('lumora:player:auto-next:v1'), 'true');
  assert.equal(h.calls.filter((item) => item.name === 'storage.setItem' && item.args[0] === 'lumora:player:auto-next:v1').length, 0); h.dispose();
});

test('episode retry recovers verified controls without restarting playback and only then permits preference writes', async () => {
  let attempts = 0;
  const h = harness({ api: playbackApi([direct], { fetchEpisodeNavigation: async () => {
    if (++attempts === 1) throw new Error('metadata unavailable'); return neighbors;
  } }) });
  const root = h.mount(h.load('src/screens/PlayerScreen.tsx').default); await h.flush();
  const failed = named(root.tree, 'NativePlayer')[0].props.episodes;
  assert.equal(failed.next, null); assert.match(failed.notice, /Episode information is unavailable/);
  failed.onAutoNextChange(true); await h.flush(); assert.equal(h.storage.get('lumora:player:auto-next:v1'), undefined);
  failed.onRetry(); await h.flush(); const ready = named(root.tree, 'NativePlayer')[0].props.episodes;
  assert.ok(ready.next); ready.onAutoNextChange(true); await h.flush();
  assert.equal(h.storage.get('lumora:player:auto-next:v1'), 'true');
  assert.equal(h.calls.filter((item) => item.name === 'resolvePlaybackDetails').length, 1);
  assert.equal(h.calls.filter((item) => item.name === 'fetchEpisodeNavigation').length, 2); h.dispose();
});

test('actual production-mode local configuration is summarized without credentials or network calls', (t) => {
  const { parseProjectEnv } = require('@expo/env');
  const env = { ...parseProjectEnv(ROOT, { mode: 'production', silent: true }).env, ...process.env };
  const h = harness({ env }); const runtime = h.load('src/lib/runtime-config.ts');
  h.supabaseModule.supabaseConfigured = runtime.resolveSupabaseRuntimeConfig(env.EXPO_PUBLIC_SUPABASE_URL, env.EXPO_PUBLIC_SUPABASE_ANON_KEY).configured;
  const flags = { authConfigured: h.load('src/lib/api.ts').isAuthConfigured(),
    watchPartyAvailable: h.load('src/watch-party/config.ts').WATCH_PARTY_SERVICE_AVAILABLE, webConfigSource: runtime.webRuntimeConfig.source };
  assert.equal(typeof flags.authConfigured, 'boolean'); assert.equal(typeof flags.watchPartyAvailable, 'boolean');
  assert.equal(h.calls.length, 0); t.diagnostic(JSON.stringify(flags)); h.dispose();
});

const mirrorArgument = process.argv.indexOf('--verify-mirror');
if (mirrorArgument >= 0) test('only owned release-gate files are byte-identical in the existing mirror', () => {
  const mirror = process.argv[mirrorArgument + 1]; assert.ok(mirror, 'Expected mirror directory');
  for (const file of ['app.config.js', 'src/lib/api.ts', 'src/screens/AuthScreen.tsx', 'src/screens/AccountScreen.tsx',
    'src/screens/PlayerScreen.tsx', 'src/player/NativePlayer.tsx', 'src/watch-party/config.ts',
    'src/watch-party/WatchPartySheet.tsx', 'src/watch-party/WatchPartyDeepLinkScreen.tsx',
    'src/watch-party/__tests__/watch-party.test.mjs', 'src/watch-party/__tests__/release-gates.test.mjs']) {
    assert.ok(readFileSync(resolve(ROOT, file)).equals(readFileSync(resolve(mirror, file))), file);
  }
});
