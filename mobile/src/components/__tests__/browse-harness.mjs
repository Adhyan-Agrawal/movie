import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const source = (path) => readFileSync(resolve(ROOT, path), 'utf8');
export const deferred = () => {
  let resolvePromise, reject;
  const promise = new Promise((resolveValue, rejectValue) => { resolvePromise = resolveValue; reject = rejectValue; });
  return { promise, resolve: resolvePromise, reject };
};

// Deterministic hooks and native ports, not an Android/Yoga renderer.
export function createHarness(options = {}) {
  let context, now = 0, timerId = 0;
  const roots = [], modules = new Map(), timers = new Map(), calls = [], navigation = [], loops = [], timings = [];
  const preference = deferred();
  const motionListeners = new Set(), appListeners = new Set();
  const dimensions = { width: options.width ?? 390, height: options.height ?? 844, fontScale: options.fontScale ?? 1, scale: 1 };
  const insets = { top: 24, bottom: 24, left: 0, right: 0, ...options.insets };
  let removedListeners = 0, intervalCalls = 0;
  const depsEqual = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const slot = (kind, initial) => {
    if (!context) throw new Error('Hook called outside a test mount');
    const index = context.cursor++;
    return context.slots[index] ??= { kind, ...initial };
  };
  const react = {
    useState(initial) {
      const owner = context;
      const state = slot('state', { value: typeof initial === 'function' ? initial() : initial });
      return [state.value, (next) => {
        if (!owner.alive) { owner.lateWrites++; return; }
        const value = typeof next === 'function' ? next(state.value) : next;
        if (!Object.is(value, state.value)) { state.value = value; owner.dirty = true; }
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
  const jsx = (type, props, key) => ({ type, props: props ?? {}, key });
  class AnimatedValue {
    constructor(value) { this.value = value; this.stops = 0; }
    setValue(value) { this.value = value; }
    stopAnimation() { this.stops++; }
  }
  const native = {
    View: 'View', Text: 'Text', Pressable: 'Pressable', Image: 'Image', ScrollView: 'ScrollView', FlatList: 'FlatList', TextInput: 'TextInput', ActivityIndicator: 'ActivityIndicator', RefreshControl: 'RefreshControl',
    StyleSheet: { create: (styles) => styles },
    Platform: { OS: 'android', select: (value) => value.android ?? value.default },
    useWindowDimensions: () => dimensions,
    AccessibilityInfo: {
      isReduceMotionEnabled: () => preference.promise,
      addEventListener: (_, callback) => { motionListeners.add(callback); return { remove: () => { motionListeners.delete(callback); removedListeners++; } }; },
    },
    AppState: {
      currentState: 'active',
      addEventListener: (_, callback) => { appListeners.add(callback); return { remove: () => { appListeners.delete(callback); removedListeners++; } }; },
    },
    Animated: {
      Value: AnimatedValue, View: 'AnimatedView',
      timing: (value, config) => { const animation = { value, config }; timings.push(animation); return animation; },
      sequence: (children) => ({ children }),
      loop: (sequence) => { const loop = { sequence, starts: 0, stops: 0, start() { this.starts++; }, stop() { this.stops++; } }; loops.push(loop); return loop; },
    },
    Linking: { openURL: (url) => { calls.push({ name: 'openURL', args: [url] }); return options.openURL?.(url) ?? Promise.resolve(); } },
  };
  const defaults = {
    currentUser: () => Promise.resolve(null), fetchContinueWatching: () => Promise.resolve([]), listAllGenres: () => Promise.resolve([]),
    searchTitles: () => Promise.resolve([]), searchPeople: () => Promise.resolve([]), getPerson: () => Promise.resolve(null), getPersonCredits: () => Promise.resolve([]),
    isInWatchlist: () => Promise.resolve(false), getMyRating: () => Promise.resolve(null), getResumePosition: () => Promise.resolve(null),
    setRating: () => Promise.resolve({ ok: true }), toggleWatchlist: () => Promise.resolve({ ok: true, added: false }), listWatchlist: () => Promise.resolve([]),
    fetchHome: () => Promise.resolve({ hero: [], rows: [], collections: [] }), listTitles: () => Promise.resolve([]), getTitleBySlug: () => Promise.resolve(null),
    getTitleDetails: () => Promise.resolve({ title: null, seasons: [], cast: [] }), readGuestEntries: () => Promise.resolve([]),
    isAccountCatalogId: (id) => !id.startsWith('tmdb:'),
    ...options.api,
  };
  const api = new Proxy({}, { get: (_, name) => (...args) => {
    if (!(name in defaults)) throw new Error(`Unexpected API import: ${String(name)}`);
    calls.push({ name, args });
    return defaults[name](...args);
  } });
  const external = {
    react,
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    'react-native': native,
    'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView', useSafeAreaInsets: () => insets },
    '@react-navigation/native': {
      useNavigation: () => ({ navigate: (name, params) => navigation.push({ name, params }) }),
      useRoute: () => options.route ?? { params: {} },
      useFocusEffect: (effect) => { react.useEffect(effect, [effect]); context.slots[context.cursor - 1].focus = true; },
    },
  };
  function load(path) {
    let filename = resolve(ROOT, path);
    if (!existsSync(filename)) filename = [filename + '.tsx', filename + '.ts'].find(existsSync);
    if (!filename) throw new Error(`Missing test module ${path}`);
    if (/[/\\]lib[/\\](api|catalog-bridge|guest)\.ts$/.test(filename)) return api;
    if (/[/\\]ads[/\\]AdMobProvider\.tsx$/.test(filename)) return { HomeAdMobBanner: () => null };
    if (modules.has(filename)) return modules.get(filename).exports;
    const module = { exports: {} };
    modules.set(filename, module);
    const code = ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    const require = (name) => external[name] ?? (name.startsWith('.') ? load(resolve(dirname(filename), name)) : (() => { throw new Error(`Unexpected dependency ${name}`); })());
    vm.runInNewContext(code, {
      module, exports: module.exports, require, console, URL,
      setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, at: now + delay }); return id; },
      clearTimeout: (id) => timers.delete(id),
      setInterval: () => { intervalCalls++; throw new Error('Browsing must not auto-advance'); }, clearInterval: () => {},
    }, { filename });
    return module.exports;
  }
  function mount(component, props = {}) {
    const owner = {
      component, props, slots: [], cursor: 0, alive: true, dirty: true, lateWrites: 0,
      render() {
        if (!this.alive) return this.tree;
        this.cursor = 0; this.dirty = false; context = this;
        try { this.tree = this.component(this.props); } finally { context = undefined; }
        for (const state of this.slots) if (state.kind === 'effect' && state.pending) {
          state.pending = false; state.cleanup?.(); state.cleanup = state.effect();
        }
        return this.tree;
      },
      unmount() { if (!this.alive) return; this.alive = false; for (const state of this.slots) state.cleanup?.(); },
    };
    roots.push(owner); owner.render(); return owner;
  }
  async function flush() {
    for (let i = 0; i < 25; i++) { await Promise.resolve(); for (const root of roots) if (root.dirty) root.render(); }
  }
  return {
    load, mount, flush, calls, navigation, loops, timings, native, dimensions, insets,
    get removedListeners() { return removedListeners; }, get intervals() { return intervalCalls; }, get timerCount() { return timers.size; },
    resolveMotion: (value) => preference.resolve(value),
    changeMotion: (value) => { for (const callback of motionListeners) callback(value); },
    changeAppState: (value) => { native.AppState.currentState = value; for (const callback of appListeners) callback(value); },
    setDimensions: (value) => { Object.assign(dimensions, value); for (const root of roots) root.dirty = true; },
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); }
    },
    blur() { for (const root of roots) for (const state of root.slots) if (state.focus) { state.cleanup?.(); state.cleanup = undefined; } },
    focus() { for (const root of roots) for (const state of root.slots) if (state.focus) { state.pending = true; root.dirty = true; } },
    dispose() { for (const root of roots) root.unmount(); },
  };
}

export function flattenStyle(value) {
  return Array.isArray(value) ? Object.assign({}, ...value.filter(Boolean).map(flattenStyle)) : value ?? {};
}

export function nodes(tree) {
  if (tree == null || tree === false) return [];
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (typeof tree !== 'object') return [];
  const items = tree.type === 'FlatList' && tree.props.renderItem ? tree.props.data.map((item, index) => tree.props.renderItem({ item, index })) : [];
  return [tree, ...nodes(tree.props.children), ...nodes(items)];
}

export const named = (tree, name) => nodes(tree).filter((node) => node.type === name || node.type?.name === name);
export function text(tree) {
  if (tree == null || tree === false) return '';
  if (Array.isArray(tree)) return tree.map(text).join(' ');
  if (typeof tree !== 'object') return String(tree);
  const labels = ['title', 'description', 'label', 'heading', 'caption'].map((key) => tree.props[key]).filter((value) => typeof value === 'string').join(' ');
  const metadata = tree.type?.name === 'MetaLine' ? tree.props.parts.filter(Boolean).join(' ') : '';
  return `${labels} ${metadata} ${text(tree.props.children)}`;
}

// Public film metadata is test input, never an application fallback catalog.
export const film = {
  id: 'tmdb:movie:414906', type: 'movie', slug: 'the-batman-414906', name: 'The Batman', releaseYear: 2022,
  runtimeMinutes: 176, maturity: 'PG-13', genres: ['Crime', 'Mystery'], tmdbId: '414906', imdbId: 'tt1877830',
  synopsis: 'Batman ventures into Gotham City\'s underworld when a sadistic killer leaves behind a trail of cryptic clues.',
  posterUrl: 'https://image.tmdb.org/t/p/w500/74xTEgt7R36Fpooo50r9T25onhq.jpg',
  backdropUrl: 'https://image.tmdb.org/t/p/w1280/b0PlSFdDwbyK0cf5RxwDpaOJQvQ.jpg',
};
