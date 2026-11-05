import assert from 'node:assert/strict';
import test from 'node:test';
import { createHarness, deferred, film, flattenStyle, named, nodes, source, text } from './browse-harness.mjs';

const screen = (harness, name) => harness.mount(harness.load(`src/screens/${name}Screen.tsx`).default);
const press = (tree, label) => {
  const control = nodes(tree).find((node) => node.props.label === label || node.props.accessibilityLabel === label);
  assert.ok(control, `Missing control: ${label}`);
  return control.props.onPress();
};

test('theme preserves all player exports and matches the warm web token contract', () => {
  const h = createHarness();
  const { colors, radius, spacing, type } = h.load('src/theme.ts');
  assert.deepEqual(Object.keys(colors), ['base', 'surface', 'surfaceRaised', 'surfaceOverlay', 'border', 'borderStrong', 'content', 'contentMuted', 'contentSubtle', 'primary', 'primaryContrast', 'success', 'warning', 'danger', 'info']);
  assert.equal(colors.base, '#0d0e0f'); assert.equal(colors.content, '#f5f1e8'); assert.equal(colors.primary, '#e11d48'); assert.equal(colors.primaryContrast, '#ffffff');
  assert.equal(spacing(3), 12); assert.ok(radius.lg >= 16); assert.ok(type.body.fontSize >= 16);
  const luminance = (hex) => hex.slice(1).match(/../g).map((part) => parseInt(part, 16) / 255).map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4).reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0);
  for (const background of ['base', 'surface', 'surfaceRaised']) for (const foreground of ['content', 'contentMuted', 'contentSubtle']) {
    const ratio = (luminance(colors[foreground]) + 0.05) / (luminance(colors[background]) + 0.05);
    assert.ok(ratio >= 4.5, `${foreground} on ${background}: ${ratio}`);
  }
  assert.ok((luminance(colors.primaryContrast) + 0.05) / (luminance(colors.primary) + 0.05) >= 4.5);
  assert.ok((luminance(colors.primary) + 0.05) / (luminance(colors.surfaceRaised) + 0.05) >= 3);
});

test('poster grids fit 360-430 phones, tablets, side insets, and large font scales', () => {
  const { browseLayout } = createHarness().load('src/components/layout.ts');
  for (const width of [360, 375, 390, 430, 768, 844, 1024, 1440]) for (const fontScale of [1, 1.5, 2]) for (const insets of [0, 24]) {
    const layout = browseLayout(width, fontScale, insets);
    assert.ok(layout.columns * layout.cardWidth + (layout.columns - 1) * 12 + layout.gutter * 2 <= Math.min(width - insets, 1180));
    assert.ok(layout.cardWidth > 0);
    if (width <= 430 && fontScale > 1.3) assert.equal(layout.columns, 2);
    if (width === 768 && fontScale === 1) assert.equal(layout.columns, 4);
  }
});

test('all shared action sizes are at least 48px and busy buttons keep their readable label', () => {
  const h = createHarness();
  const { Button, IconButton, FilterChip } = h.load('src/components/ui.tsx');
  for (const size of ['sm', 'md', 'lg']) for (const variant of ['primary', 'secondary', 'ghost', 'light']) {
    const root = h.mount(Button, { label: 'A readable action', size, variant, loading: true });
    const control = root.tree;
    const style = flattenStyle(control.props.style({ pressed: false }));
    assert.ok(style.minHeight >= 48); assert.ok(style.minWidth >= 48); assert.equal(style.height, undefined);
    assert.equal(control.props.disabled, true); assert.equal(control.props.accessibilityState.busy, true);
    assert.match(text(control), /A readable action/);
  }
  for (const [component, props] of [[IconButton, { icon: 'close', label: 'Close', onPress() {} }], [FilterChip, { label: 'Films', active: true, onPress() {} }]]) {
    const root = h.mount(component, props);
    assert.ok(flattenStyle(root.tree.props.style({ pressed: false })).minHeight >= 48);
  }
  h.dispose();
});

test('small selected labels use ivory, not the lower-contrast rose accent', () => {
  const h = createHarness();
  const { FilterChip, Badge } = h.load('src/components/ui.tsx');
  const colors = h.load('src/theme.ts').colors;
  const chip = h.mount(FilterChip, { label: 'Films', active: true, onPress() {} });
  assert.equal(flattenStyle(named(chip.tree, 'Text')[0].props.style).color, colors.content);
  assert.equal(flattenStyle(named(chip.tree, 'Text')[0].props.style).textDecorationLine, 'underline');
  const badge = h.mount(Badge, { label: 'Selected', tone: 'primary' });
  assert.equal(flattenStyle(named(badge.tree, 'Text')[0].props.style).color, colors.content); h.dispose();
});

test('long chips and badges preserve full values, native text scaling, and bounded widths', () => {
  const label = 'An intentionally long collection label used only to verify native text layout';
  for (const width of [360, 375, 390, 430, 768, 844]) for (const fontScale of [1, 2, 3]) {
    const h = createHarness({ width, fontScale, insets: { left: 16, right: 16 } });
    const { FilterChip, Badge } = h.load('src/components/ui.tsx');
    const chip = h.mount(FilterChip, { label, active: true, onPress() {} });
    const bounds = flattenStyle(chip.tree.props.style({ pressed: false }));
    assert.ok(bounds.maxWidth <= width - 32 - (width - 32 >= 700 ? 64 : 40));
    assert.ok(bounds.minHeight >= 48); assert.equal(bounds.height, undefined);
    assert.equal(chip.tree.props.accessibilityLabel, label);
    const chipText = named(chip.tree, 'Text')[0];
    assert.equal(chipText.props.children, label); assert.equal(chipText.props.numberOfLines, undefined); assert.notEqual(chipText.props.allowFontScaling, false);
    assert.equal(flattenStyle(chipText.props.style).flexShrink, 1);
    const badge = h.mount(Badge, { label });
    assert.equal(flattenStyle(badge.tree.props.style).maxWidth, '100%');
    assert.equal(named(badge.tree, 'Text')[0].props.children, label); h.dispose();
  }
});

test('native press feedback changes opacity without shifting targets or overlapping hit areas', () => {
  const h = createHarness(); const { Button, IconButton, FilterChip, SectionTitle } = h.load('src/components/ui.tsx');
  for (const [component, props] of [[Button, { label: '1', onPress() {} }], [IconButton, { icon: 'close', label: 'Clear', onPress() {} }], [FilterChip, { label: '1', onPress() {} }]]) {
    const root = h.mount(component, props);
    const normal = flattenStyle(root.tree.props.style({ pressed: false }));
    const pressed = flattenStyle(root.tree.props.style({ pressed: true }));
    assert.ok(normal.minWidth >= 48); assert.ok(normal.minHeight >= 48);
    assert.ok(pressed.opacity < normal.opacity); delete normal.opacity; delete pressed.opacity;
    assert.deepEqual(pressed, normal); assert.equal(root.tree.props.hitSlop, undefined);
  }
  const section = h.mount(SectionTitle, { children: 'Films', actionLabel: '1', onAction() {} });
  assert.ok(flattenStyle(named(section.tree, 'Pressable')[0].props.style({ pressed: false })).minWidth >= 48);
  h.dispose();
});

test('long native titles remain complete and tablet prose has a readable measure', async () => {
  const title = { ...film, name: 'The Assassination of Jesse James by the Coward Robert Ford', synopsis: 'A long-form synopsis used only for layout verification. '.repeat(20) };
  const h = createHarness({ width: 1024, fontScale: 2, route: { params: { type: 'movie', slug: title.slug } }, api: { getTitleDetails: async () => ({ title, seasons: [], cast: [] }) } });
  const root = screen(h, 'Title'); await h.flush();
  const titleText = named(root.tree, 'Text').find((node) => node.props.children === title.name);
  assert.ok(titleText); assert.equal(titleText.props.numberOfLines, undefined);
  const synopsis = named(root.tree, 'Text').find((node) => node.props.children === title.synopsis);
  assert.equal(flattenStyle(synopsis.props.style).maxWidth, 600); assert.equal(synopsis.props.numberOfLines, undefined); h.dispose();
});

test('motion defaults off, rejects a stale preference query, and removes both listeners', async () => {
  const h = createHarness();
  const { useMotionEnabled } = h.load('src/components/motion.ts');
  const root = h.mount(useMotionEnabled);
  assert.equal(root.tree, false);
  h.changeMotion(true); h.resolveMotion(false); await h.flush();
  assert.equal(root.tree, false);
  root.unmount();
  assert.equal(h.removedListeners, 2);
  h.changeMotion(false); h.changeAppState('active'); await h.flush();
  assert.equal(root.lateWrites, 0);
});

test('late preference completion cannot update an unmounted hook', async () => {
  const h = createHarness();
  const root = h.mount(h.load('src/components/motion.ts').useMotionEnabled);
  root.unmount(); h.resolveMotion(false); await h.flush();
  assert.equal(root.lateWrites, 0);
});

test('skeleton opacity uses the native driver, stops in background, and cancels on unmount', async () => {
  const h = createHarness();
  const root = h.mount(h.load('src/components/Skeletons.tsx').Skeletons);
  assert.equal(h.loops.length, 0);
  h.resolveMotion(false); await h.flush();
  assert.equal(h.loops.length, 1); assert.equal(h.loops[0].starts, 1);
  for (const timing of h.timings) { assert.equal(timing.config.useNativeDriver, true); assert.equal(timing.config.isInteraction, false); assert.ok(timing.config.toValue >= 0.5); }
  assert.deepEqual(Object.keys(named(root.tree, 'AnimatedView')[0].props.style), ['opacity']);
  h.changeAppState('background'); await h.flush(); assert.equal(h.loops[0].stops, 1);
  h.changeAppState('active'); await h.flush(); assert.equal(h.loops.length, 2);
  root.unmount(); assert.equal(h.loops[1].stops, 1); assert.equal(h.removedListeners, 2);
  assert.equal(root.lateWrites, 0);
});

test('reduced-motion skeletons remain static and accessible', async () => {
  const h = createHarness();
  const root = h.mount(h.load('src/components/Skeletons.tsx').Skeletons, { label: 'Loading My List' });
  h.resolveMotion(true); await h.flush();
  assert.equal(h.loops.length, 0); assert.equal(root.tree.props.accessibilityRole, 'progressbar');
  assert.equal(root.tree.props.accessibilityLabel, 'Loading My List'); h.dispose();
});

test('artwork keeps direct TMDB URLs, falls back on error, and rejects obsolete callbacks', async () => {
  const h = createHarness();
  const root = h.mount(h.load('src/components/Artwork.tsx').Artwork, { uri: film.posterUrl, label: film.name });
  const original = named(root.tree, 'Image')[0]; assert.equal(original.props.source.uri, film.posterUrl);
  original.props.onError(); await h.flush(); assert.equal(named(root.tree, 'Image').length, 0); assert.match(text(root.tree), /The Batman/);
  root.props = { uri: film.backdropUrl, label: film.name }; root.render();
  original.props.onError(); await h.flush(); assert.equal(named(root.tree, 'Image')[0].props.source.uri, film.backdropUrl);
  const current = named(root.tree, 'Image')[0]; root.unmount(); current.props.onLoad(); current.props.onError();
  assert.equal(root.lateWrites, 0);
});

test('landscape progress is clamped, never NaN, and titles remain readable at large scale', () => {
  const h = createHarness({ fontScale: 2 });
  const component = h.load('src/components/MediaCard.tsx').MediaCard;
  const root = h.mount(component, { title: film, progress: 1.8, variant: 'landscape', caption: 'Resume S2 E5', onPress() {} });
  assert.match(root.tree.props.accessibilityLabel, /100 percent watched/);
  assert.equal(named(root.tree, 'Artwork')[0].props.uri, film.backdropUrl);
  assert.equal(named(root.tree, 'Text')[0].props.numberOfLines, undefined);
  const unknown = h.mount(component, { title: film, progress: NaN, onPress() {} });
  assert.doesNotMatch(unknown.tree.props.accessibilityLabel, /percent|NaN/); h.dispose();
});

test('hero is manual, all featured titles survive reduced motion, and details are labeled honestly', async () => {
  const h = createHarness();
  const selected = [];
  const root = h.mount(h.load('src/components/Hero.tsx').Hero, { titles: [film, { ...film, id: 'second', name: 'Second title' }], onPressTitle: (title) => selected.push(title) });
  const list = named(root.tree, 'FlatList')[0]; const scrolls = [];
  list.props.ref.current = { scrollToIndex: (value) => scrolls.push(value), scrollToOffset: (value) => scrolls.push(value) };
  h.resolveMotion(true); await h.flush(); press(root.tree, 'Next featured title');
  assert.equal(scrolls.at(-1).animated, false); assert.equal(list.props.data.length, 2); assert.equal(h.intervals, 0);
  const slide = list.props.renderItem({ item: film }); press(slide, 'View title'); assert.equal(selected[0], film);
  assert.doesNotMatch(text(slide), /\bPlay\b/); h.dispose();
});

test('public title renders metadata without private account reads or invented ratings/capabilities', async () => {
  const h = createHarness({ route: { params: { type: 'movie', slug: film.slug } }, api: { getTitleDetails: async () => ({ title: film, seasons: [], cast: [] }) } });
  const root = screen(h, 'Title'); await h.flush();
  assert.match(text(root.tree), /The Batman/); assert.match(text(root.tree), /2h 56m/);
  assert.doesNotMatch(text(root.tree), /4K|%|PG-13|Account rating|Rate this title/);
  assert.equal(h.calls.filter((call) => ['getMyRating', 'isInWatchlist', 'getResumePosition', 'fetchContinueWatching'].includes(call.name)).length, 0);
  press(root.tree, 'Play'); assert.equal(h.navigation[0].params.tmdbId, film.tmdbId); h.dispose();
});

test('title distinguishes a connection error from a genuine missing title and retries the same query', async () => {
  let attempts = 0;
  const h = createHarness({ route: { params: { type: 'movie', slug: film.slug } }, api: { getTitleDetails: async () => { if (++attempts === 1) throw new Error('network'); return { title: film, seasons: [], cast: [] }; } } });
  const root = screen(h, 'Title'); await h.flush(); assert.match(text(root.tree), /This title didn't load/); assert.doesNotMatch(text(root.tree), /Title not found/);
  named(root.tree, 'EmptyState')[0].props.onAction(); await h.flush(); assert.match(text(root.tree), /The Batman/);
  assert.ok(h.calls.filter((call) => call.name === 'getTitleDetails').every((call) => call.args.join('|') === `movie|${film.slug}`)); h.dispose();
});

test('episode card forwards exact current-episode props rather than guessing adjacent numbers', async () => {
  const episode = { id: 'actual-episode', seasonNumber: 2, episodeNumber: 5, name: 'An actual episode', overview: 'Episode overview', airDate: '2022-01-01', runtimeMinutes: 51, stillUrl: null };
  const title = { ...film, id: 'tmdb:tv:1399', type: 'tv', slug: 'game-of-thrones-1399' };
  const h = createHarness({ route: { params: { type: 'tv', slug: title.slug } }, api: { getTitleDetails: async () => ({ title, seasons: [{ id: 'season2', seasonNumber: 2, name: 'Season 2', episodes: [episode] }], cast: [] }) } });
  const root = screen(h, 'Title'); await h.flush(); press(root.tree, 'Play season 2, episode 5, An actual episode');
  const params = h.navigation.at(-1).params;
  assert.equal(params.season, 2); assert.equal(params.episode, 5); assert.equal(params.episodeId, episode.id); assert.equal(params.episodeName, episode.name); h.dispose();
});

test('real account resume keeps the authoritative episode and selects its actual season', async () => {
  const episode = { id: 'saved-episode', seasonNumber: 3, episodeNumber: 7, name: 'Saved episode', overview: '', airDate: null, runtimeMinutes: null, stillUrl: null };
  const title = { ...film, id: 'account-title', type: 'tv' };
  const h = createHarness({ route: { params: { type: 'tv', slug: title.slug } }, api: {
    getTitleDetails: async () => ({ title, seasons: [{ id: 'season1', seasonNumber: 1, name: 'Season 1', episodes: [] }, { id: 'season3', seasonNumber: 3, name: 'Season 3', episodes: [episode] }], cast: [] }),
    fetchContinueWatching: async () => [{ title, episodeId: episode.id }], getResumePosition: async () => ({ positionSeconds: 120, progress: 0.1 }),
  } });
  const root = screen(h, 'Title'); await h.flush(); press(root.tree, 'Resume S3 E7');
  assert.equal(h.navigation.at(-1).params.episodeId, episode.id); assert.equal(h.navigation.at(-1).params.episode, 7);
  assert.equal(named(root.tree, 'FilterChip').find((chip) => chip.props.label === 'Season 3').props.active, true); h.dispose();
});

test('trailer uses only the existing URL and ignores a late failure after unmount', async () => {
  const failure = deferred();
  const url = 'https://www.youtube.com/watch?v=example';
  const h = createHarness({ route: { params: { type: 'movie', slug: film.slug } }, openURL: () => failure.promise, api: { getTitleDetails: async () => ({ title: { ...film, trailerUrl: url }, seasons: [], cast: [] }) } });
  const root = screen(h, 'Title'); await h.flush(); press(root.tree, 'Watch trailer');
  assert.equal(h.calls.find((call) => call.name === 'openURL').args[0], url);
  root.unmount(); failure.reject(new Error('closed')); await h.flush(); assert.equal(root.lateWrites, 0);
});

test('search invalidates old results immediately, including the next debounce window', async () => {
  const firstTitles = deferred(), firstPeople = deferred();
  const h = createHarness({ api: { searchTitles: (query) => query === 'first' ? firstTitles.promise : Promise.resolve([{ ...film, name: 'Second result' }]), searchPeople: (query) => query === 'first' ? firstPeople.promise : Promise.resolve([]) } });
  const root = screen(h, 'Search');
  named(root.tree, 'TextInput')[0].props.onChangeText('first'); await h.flush(); h.advance(250); await h.flush();
  named(root.tree, 'TextInput')[0].props.onChangeText('second'); await h.flush();
  firstTitles.resolve([{ ...film, name: 'Obsolete result' }]); firstPeople.resolve([]); await h.flush();
  assert.equal(named(root.tree, 'MediaCard').length, 0);
  h.advance(250); await h.flush(); assert.equal(named(root.tree, 'MediaCard')[0].props.title.name, 'Second result');
  assert.equal(h.calls.filter((call) => call.name === 'searchTitles').length, 2); h.dispose();
});

test('search filters are local, preserve both real query calls, and clear pending debounce on unmount', async () => {
  const h = createHarness({ api: { searchTitles: async () => [film, { ...film, id: 'tv-result', type: 'tv', name: 'A series' }] } });
  const root = screen(h, 'Search'); named(root.tree, 'TextInput')[0].props.onChangeText('batman'); await h.flush(); h.advance(250); await h.flush();
  const before = h.calls.length; press(root.tree, 'Series'); await h.flush();
  assert.equal(named(root.tree, 'MediaCard').length, 1); assert.equal(named(root.tree, 'MediaCard')[0].props.title.type, 'tv'); assert.equal(h.calls.length, before);
  press(root.tree, 'Clear search'); await h.flush(); named(root.tree, 'TextInput')[0].props.onChangeText('pending'); await h.flush();
  root.unmount(); h.advance(1000); await h.flush(); assert.equal(h.timerCount, 0); assert.equal(root.lateWrites, 0);
});

test('failed watchlist reads show connection recovery, not a misleading signed-out state', async () => {
  const h = createHarness({ api: { currentUser: async () => { throw new Error('connection'); } } });
  const root = screen(h, 'MyList'); await h.flush(); assert.match(text(root.tree), /Your list didn't load/); assert.doesNotMatch(text(root.tree), /Sign in to build/); h.dispose();
});

test('guest My List remains a real sign-in prompt, never a fabricated empty account', async () => {
  const h = createHarness(); const root = screen(h, 'MyList'); await h.flush();
  assert.match(text(root.tree), /Sign in to build your list/); assert.equal(h.calls.filter((call) => call.name === 'listWatchlist').length, 0);
  named(root.tree, 'EmptyState')[0].props.onAction(); assert.equal(h.navigation[0].name, 'Auth'); h.dispose();
});

test('watchlist filtering adds no queries and removals use the existing real write', async () => {
  const h = createHarness({ api: { currentUser: async () => ({ id: 'test-account' }), listWatchlist: async () => [film, { ...film, id: 'series', type: 'tv' }] } });
  const root = screen(h, 'MyList'); await h.flush(); const before = h.calls.length;
  press(root.tree, 'Series'); await h.flush(); assert.equal(named(root.tree, 'MediaCard').length, 1); assert.equal(h.calls.length, before);
  await press(root.tree, 'Remove'); await h.flush(); assert.equal(h.calls.find((call) => call.name === 'toggleWatchlist').args[0], 'series');
  assert.equal(named(root.tree, 'MediaCard').length, 0); h.dispose();
});

test('watchlist ignores a pending read after unmount', async () => {
  const waiting = deferred(); const h = createHarness({ api: { currentUser: () => waiting.promise } });
  const root = screen(h, 'MyList'); root.unmount(); waiting.resolve({ id: 'late' }); await h.flush();
  assert.equal(root.lateWrites, 0); assert.equal(h.calls.filter((call) => call.name === 'listWatchlist').length, 0);
});

test('person credits failure keeps the known profile and shows a retry state', async () => {
  const h = createHarness({ route: { params: { id: 'person' } }, api: { getPerson: async () => ({ id: 'person', name: 'Robert Pattinson', knownFor: 'Acting', profileUrl: null }), getPersonCredits: async () => { throw new Error('offline'); } } });
  const root = screen(h, 'Person'); await h.flush(); assert.match(text(root.tree), /Robert Pattinson/); assert.match(text(root.tree), /Their credits didn't load/); assert.doesNotMatch(text(root.tree), /Person not found/); h.dispose();
});

test('home integrates guest history and existing collection filters without fake content', async () => {
  const h = createHarness({ api: { fetchHome: async () => ({ hero: [film], rows: [], collections: [{ id: 'crime', label: 'Crime stories', filters: { genre: 'Crime', type: 'movie' } }] }), readGuestEntries: async () => [{ title: film, progress: 0.4, seasonNumber: 2, episodeNumber: 5, episodeId: 'guest-episode' }], listTitles: async () => [film] } });
  const root = screen(h, 'Home'); await h.flush();
  const row = named(root.tree, 'Row')[0]; assert.equal(row.props.variant, 'landscape'); assert.equal(row.props.captionById[film.id], 'Resume S2 E5'); row.props.onPressTitle(film);
  assert.equal(h.navigation[0].params.episode, 5); assert.equal(h.navigation[0].params.episodeId, 'guest-episode');
  press(root.tree, 'Crime stories'); await h.flush(); const request = h.calls.find((call) => call.name === 'listTitles');
  assert.equal(request.args[0].genre, 'Crime'); assert.equal(request.args[0].type, 'movie'); assert.equal(request.args[0].pageSize, 30); h.dispose();
});

test('home keeps already-loaded public films when a refresh fails and labels them honestly', async () => {
  let count = 0;
  const h = createHarness({ api: { fetchHome: async () => { if (++count > 1) throw new Error('offline'); return { hero: [film], rows: [] }; } } });
  const root = screen(h, 'Home'); await h.flush(); named(root.tree, 'ScrollView')[0].props.refreshControl.props.onRefresh(); await h.flush();
  assert.equal(named(root.tree, 'Hero')[0].props.titles[0].id, film.id); assert.match(text(root.tree), /last loaded titles/); h.dispose();
});

test('hero rotation and shrinking data clamp the current page without starting motion', async () => {
  const h = createHarness();
  const root = h.mount(h.load('src/components/Hero.tsx').Hero, { titles: [film, { ...film, id: 'two' }, { ...film, id: 'three' }], onPressTitle() {} });
  const list = named(root.tree, 'FlatList')[0]; const scrolls = [];
  list.props.ref.current = { scrollToIndex: (value) => scrolls.push(value), scrollToOffset: (value) => scrolls.push(value) };
  press(root.tree, 'Next featured title'); await h.flush(); press(root.tree, 'Next featured title'); await h.flush();
  root.props = { ...root.props, titles: [film] }; h.setDimensions({ width: 768 }); await h.flush();
  assert.equal(scrolls.at(-1).offset, 0); assert.equal(scrolls.at(-1).animated, false); assert.equal(named(root.tree, 'IconButton').length, 0); h.dispose();
});

test('home public and genre completions cannot write after the screen unmounts', async () => {
  const home = deferred(), genres = deferred();
  const h = createHarness({ api: { fetchHome: () => home.promise, listAllGenres: () => genres.promise } });
  const root = screen(h, 'Home'); root.unmount(); home.resolve({ hero: [film], rows: [] }); genres.resolve(['Crime']); await h.flush();
  assert.equal(root.lateWrites, 0);
});

test('a genre lookup finishing while Home is blurred does not leave a permanent skeleton', async () => {
  const genre = deferred();
  const h = createHarness({ api: { fetchHome: async () => ({ hero: [film], rows: [], collections: [{ id: 'crime', label: 'Crime stories', filters: { genre: 'Crime' } }] }), listTitles: () => genre.promise } });
  const root = screen(h, 'Home'); await h.flush(); press(root.tree, 'Crime stories'); await h.flush(); h.blur();
  genre.resolve([film]); await h.flush(); assert.equal(named(root.tree, 'MediaCard').length, 1); assert.equal(named(root.tree, 'Skeletons').length, 0); h.dispose();
});

test('failed list removal retains server-confirmed titles and reports the failure', async () => {
  const h = createHarness({ api: { currentUser: async () => ({ id: 'test-account' }), listWatchlist: async () => [film], toggleWatchlist: async () => ({ ok: false }) } });
  const root = screen(h, 'MyList'); await h.flush(); await press(root.tree, 'Remove'); await h.flush();
  assert.equal(named(root.tree, 'MediaCard')[0].props.title.id, film.id); assert.match(text(root.tree), /couldn't be removed/);
  assert.equal(h.calls.filter((call) => call.name === 'listWatchlist').length, 2); h.dispose();
});

test('obsolete title detail completion is discarded rather than replacing the next screen', async () => {
  const details = deferred();
  const h = createHarness({ route: { params: { type: 'movie', slug: film.slug } }, api: { getTitleDetails: () => details.promise } });
  const root = screen(h, 'Title'); root.unmount(); details.resolve({ title: film, seasons: [], cast: [] }); await h.flush(); assert.equal(root.lateWrites, 0);
});

test('owned presentation has no new dependencies, false quality badges, fixed window snapshots, or disabled font scaling', () => {
  const paths = ['Home', 'Title', 'Search', 'Person', 'MyList'].map((name) => `src/screens/${name}Screen.tsx`).concat(['src/components/Hero.tsx', 'src/components/MediaCard.tsx', 'src/components/ui.tsx', 'src/components/Skeletons.tsx', 'src/components/motion.ts']);
  for (const path of paths) {
    const code = source(path);
    assert.doesNotMatch(code, /allowFontScaling\s*=\s*\{false\}|Dimensions\.get|react-native-reanimated|setInterval\s*\(|\b4K\b|chromecast|cast-device/i, path);
  }
  assert.match(source('src/screens/HomeScreen.tsx'), /fetchContinueWatching\(12\)/);
  assert.match(source('src/screens/TitleScreen.tsx'), /getTitleDetails\(titleType, slug\)/);
  assert.match(source('src/screens/TitleScreen.tsx'), /fetchContinueWatching\(50\)/);
  assert.match(source('src/screens/PersonScreen.tsx'), /getPersonCredits\(id\)/);
  assert.match(source('src/screens/MyListScreen.tsx'), /toggleWatchlist\(title\.id\)/);
});
