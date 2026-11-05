import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHarness, film, flattenStyle, named, source } from './browse-harness.mjs';

// Optional browser-layout proof using an already installed Playwright. This is
// not React Native Web, Android, Yoga, or a real-account/catalog acceptance test.
const output = process.argv[2] ?? 'C:/Users/ADHYAN~1/AppData/Local/Temp/kilo';
const webRoot = process.argv[3] ?? 'D:/movie platform';
assert.ok(existsSync(output), 'Proof output parent must already exist');
const { chromium } = await import(pathToFileURL(resolve(webRoot, 'node_modules/playwright/index.mjs')).href);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 900 }, reducedMotion: 'reduce' });

const tenet = { ...film, id: 'tmdb:movie:577922', name: 'Tenet', slug: 'tenet-577922', tmdbId: '577922', imdbId: 'tt6723592', releaseYear: 2020, runtimeMinutes: 150, genres: ['Action', 'Science Fiction'], synopsis: 'An operative journeys through a twilight world of international espionage on a mission that unfolds beyond real time.', posterUrl: 'https://image.tmdb.org/t/p/w500/k68nPLbIST6NP96JmTxmZijEvCA.jpg', backdropUrl: 'https://image.tmdb.org/t/p/w1280/wzJRB4MKi3yK138bJyuL9nx47y6.jpg' };
const interstellar = { ...film, id: 'tmdb:movie:157336', name: 'Interstellar', slug: 'interstellar-157336', tmdbId: '157336', releaseYear: 2014, runtimeMinutes: 169, genres: ['Adventure', 'Drama', 'Science Fiction'], posterUrl: 'https://image.tmdb.org/t/p/w500/gEU2QniE6E77NI6lCU6MxlNBvIx.jpg' };
const dune = { ...film, id: 'tmdb:movie:438631', name: 'Dune', slug: 'dune-438631', tmdbId: '438631', releaseYear: 2021, runtimeMinutes: 155, genres: ['Adventure', 'Science Fiction'], posterUrl: 'https://image.tmdb.org/t/p/w500/d5NXSklXo0qyIYkgV94XAgMIckC.jpg' };
const matrix = { ...film, id: 'tmdb:movie:603', name: 'The Matrix', slug: 'the-matrix-603', tmdbId: '603', releaseYear: 1999, runtimeMinutes: 136, maturity: 'R', genres: ['Action', 'Science Fiction'], posterUrl: 'https://image.tmdb.org/t/p/w500/f89U3ADr1oiB1s9GkdPOEpXUk5H.jpg' };
const titles = [film, tenet, interstellar, dune, matrix];
const series = { ...film, id: 'tmdb:tv:1399', name: 'Game of Thrones', type: 'tv', slug: 'game-of-thrones-1399', tmdbId: '1399', imdbId: 'tt0944947', releaseYear: 2011, runtimeMinutes: undefined, maturity: 'TV-MA', genres: ['Drama', 'Fantasy'], synopsis: 'Seven noble families fight for control of the mythical land of Westeros. Political and sexual intrigue is pervasive.', posterUrl: 'https://image.tmdb.org/t/p/w500/1XS1oqL89opfnbLl8WnZY1O1uJx.jpg', backdropUrl: 'https://image.tmdb.org/t/p/w1280/suopoADq0k8YZr4dQXcU6pToj6s.jpg' };
const longTitle = { ...film, id: 'tmdb:movie:4512', name: 'The Assassination of Jesse James by the Coward Robert Ford', slug: 'the-assassination-of-jesse-james-by-the-coward-robert-ford-4512', tmdbId: '4512', imdbId: 'tt0443680', releaseYear: 2007, runtimeMinutes: 160, genres: ['Drama', 'Western'], posterUrl: null, backdropUrl: null, synopsis: 'In 1880s Missouri, a young Robert Ford joins the gang of his idol, outlaw Jesse James. Admiration gradually gives way to resentment as their uneasy relationship changes. The film follows the people around James and the events that lead to Ford\'s decision to betray him.' };
const episodes = [
  { id: 'fixture-1399-1-1', seasonNumber: 1, episodeNumber: 1, name: 'Winter Is Coming', runtimeMinutes: 62, airDate: '2011-04-17', stillUrl: null, overview: 'Lord Eddard Stark is summoned to serve as Hand of the King.' },
  { id: 'fixture-1399-1-2', seasonNumber: 1, episodeNumber: 2, name: 'The Kingsroad', runtimeMinutes: 56, airDate: '2011-04-24', stillUrl: null, overview: 'The journey south begins as Jon Snow heads north to the Wall.' },
];

const unitless = new Set(['opacity', 'flex', 'flexGrow', 'flexShrink', 'zIndex', 'fontWeight', 'aspectRatio', 'order']);
const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
function css(value, fontScale) {
  const style = flattenStyle(value), entries = [];
  const add = (key, item) => {
    if (item == null) return;
    if (key === 'fontSize' || key === 'lineHeight') item *= fontScale;
    if (typeof item === 'object' && 'value' in item) item = item.value;
    const property = key.replace(/[A-Z]/g, (char) => '-' + char.toLowerCase());
    entries.push(`${property}:${typeof item === 'number' && !unitless.has(key) ? `${item}px` : item}`);
  };
  for (const [key, item] of Object.entries(style)) {
    if (key === 'transform') { add(key, item.map((part) => Object.entries(part).map(([name, amount]) => `${name}(${typeof amount === 'number' && name.startsWith('translate') ? amount + 'px' : amount})`).join(' ')).join(' ')); continue; }
    if (key === 'fontVariant') { add('fontVariantNumeric', item.join(' ')); continue; }
    if (/^(padding|margin)(Horizontal|Vertical)$/.test(key)) {
      const base = key.replace(/Horizontal|Vertical/, '');
      for (const side of key.endsWith('Horizontal') ? ['Left', 'Right'] : ['Top', 'Bottom']) add(base + side, item);
      continue;
    }
    if (key === 'elevation' || key.startsWith('shadow')) continue;
    add(key, item);
  }
  return entries.join(';');
}

function html(tree, h, inText = false) {
  if (tree == null || tree === false) return '';
  if (Array.isArray(tree)) return tree.map((item) => html(item, h, inText)).join('');
  if (typeof tree !== 'object') return escape(tree);
  if (typeof tree.type === 'function') return html(h.mount(tree.type, tree.props).tree, h, inText);
  const props = tree.props;
  if (tree.type === 'Fragment') return html(props.children, h, inText);
  if (tree.type === 'RefreshControl') return '';
  let style = css(typeof props.style === 'function' ? props.style({ pressed: false }) : props.style, h.dimensions.fontScale);
  if (tree.type === 'SafeAreaView') style += ';' + css({ paddingLeft: props.edges.includes('left') ? h.insets.left : 0, paddingRight: props.edges.includes('right') ? h.insets.right : 0 }, h.dimensions.fontScale);
  const label = props.accessibilityLabel ? ` aria-label="${escape(props.accessibilityLabel)}"` : '';
  if (tree.type === 'Image') return `<img alt="" src="${escape(props.source.uri)}" style="${style};object-fit:cover" onerror="this.remove()">`;
  if (tree.type === 'TextInput') return `<input aria-label="${escape(props.accessibilityLabel ?? 'Search')}" value="${escape(props.value)}" placeholder="${escape(props.placeholder)}" style="${style}">`;
  if (tree.type === 'ActivityIndicator') return `<span class="spinner" aria-hidden="true"></span>`;
  if (tree.type === 'ScrollView' || tree.type === 'FlatList') {
    let content = props.children;
    let contentStyle = css(props.contentContainerStyle, h.dimensions.fontScale);
    if (tree.type === 'FlatList') {
      content = props.data?.length ? props.data.map((item, index) => props.renderItem({ item, index })) : props.ListEmptyComponent;
      if (props.numColumns) contentStyle += `;flex-direction:row;flex-wrap:wrap;column-gap:${flattenStyle(props.columnWrapperStyle).gap ?? 12}px`;
    }
    if (props.horizontal) contentStyle += ';flex-direction:row;align-items:stretch';
    return `<div class="view scroller" style="${style};${props.horizontal ? 'overflow-x:auto' : 'overflow-x:clip'}"><div class="view" style="${contentStyle}">${html(content, h)}</div></div>`;
  }
  const tag = tree.type === 'Pressable' ? 'button' : tree.type === 'Text' && inText ? 'span' : 'div';
  const className = tree.type === 'Text' ? 'text' : 'view';
  const disabled = props.disabled ? ' disabled' : '';
  const clamp = tree.type === 'Text' && props.numberOfLines ? `;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:${props.numberOfLines};overflow:hidden` : '';
  return `<${tag} class="${className}"${label}${disabled} style="${style}${clamp}">${html(props.children, h, tree.type === 'Text')}</${tag}>`;
}

async function render(name, width, fontScale = 1, state = 'ready', height = 900) {
  const selectedTitle = name === 'Series' ? series : name === 'LongTitle' ? longTitle : film;
  const screenName = name === 'Series' || name === 'LongTitle' ? 'Title' : name;
  const h = createHarness({ width, height, fontScale, insets: height < width ? { left: 44, right: 44, top: 0, bottom: 21 } : undefined, route: { params: screenName === 'Person' ? { id: 'fixture-person' } : { type: selectedTitle.type, slug: selectedTitle.slug } }, api: {
    currentUser: async () => name === 'MyList' ? { id: 'layout-fixture' } : null,
    listWatchlist: async () => titles,
    listAllGenres: async () => ['Crime', 'Drama', 'Science Fiction', 'Adventure', 'Mystery'],
    fetchHome: async () => { if (state === 'error') throw new Error('fixture connection'); if (state === 'loading') return new Promise(() => {}); return { hero: [film, tenet], collections: [{ id: 'scifi', label: 'Science Fiction', filters: { genre: 'Science Fiction', type: 'movie' } }, { id: 'crime', label: 'Crime stories', filters: { genre: 'Crime' } }], rows: [{ id: 'films', heading: 'Films to explore', titles }, { id: 'scifi', heading: 'Science fiction', titles: [interstellar, dune, matrix, tenet], filters: { genre: 'Science Fiction' } }] }; },
    readGuestEntries: async () => [{ title: tenet, progress: 0.34 }],
    getTitleDetails: async () => ({ title: selectedTitle, seasons: name === 'Series' ? [{ id: 'fixture-season-1', seasonNumber: 1, name: 'Season 1', episodes }] : [], cast: name === 'LongTitle' ? [] : [{ personId: 'fixture-person', name: name === 'Series' ? 'Emilia Clarke' : 'Robert Pattinson', character: name === 'Series' ? 'Daenerys Targaryen' : 'Bruce Wayne / Batman', profileUrl: null }] }),
    searchTitles: async (query) => titles.filter((title) => title.name.toLowerCase().includes(query.toLowerCase())),
    searchPeople: async () => [],
    getPerson: async () => ({ id: 'fixture-person', name: 'Robert Pattinson', knownFor: 'Acting', profileUrl: null }),
    getPersonCredits: async () => [{ title: film, creditType: 'cast', character: 'Bruce Wayne / Batman' }, { title: tenet, creditType: 'cast', character: 'Neil' }],
  } });
  let root;
  if (name === 'Labels') {
    const { Screen, SectionTitle, FilterChip, Badge } = h.load('src/components/ui.tsx');
    const label = 'An intentionally long collection label used only to verify native text layout';
    root = h.mount(() => ({ type: Screen, props: { safeSides: true, children: [
      { type: SectionTitle, props: { children: 'Long-label fixture' } },
      { type: 'View', props: { style: { paddingHorizontal: 20, gap: 16, alignItems: 'flex-start' }, children: [{ type: FilterChip, props: { label, active: true, onPress() {} } }, { type: Badge, props: { label } }] } },
    ] } }));
  } else root = h.mount(h.load(`src/screens/${screenName}Screen.tsx`).default);
  await h.flush();
  if (name === 'Search') { named(root.tree, 'TextInput')[0].props.onChangeText('the'); await h.flush(); h.advance(250); await h.flush(); }
  const markup = html(root.tree, h); h.dispose();
  const palette = h.load('src/theme.ts').colors;
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
    *{box-sizing:border-box}html,body{margin:0;padding:0;background:${palette.base};color:${palette.content};font-family:Arial,sans-serif}body{display:flex;flex-direction:column;min-height:100vh}button,input{font:inherit;color:inherit;background:transparent;border:0;margin:0;padding:0;text-align:left}button{cursor:pointer}button:disabled{cursor:default}.view{position:relative;display:flex;flex-direction:column;min-width:0;flex-shrink:0;border:0 solid transparent}.text{position:relative;font-size:${14 * fontScale}px;line-height:${20 * fontScale}px;white-space:pre-wrap;overflow-wrap:anywhere;border:0 solid transparent}.text span{display:inline}.scroller::-webkit-scrollbar{display:none}.proof{padding:8px 12px;border-bottom:1px solid ${palette.border};font:10px/14px Arial;color:${palette.contentMuted};background:${palette.surface}}.spinner{width:16px;height:16px;border:2px solid ${palette.borderStrong};border-top-color:${palette.primary};border-radius:50%;display:block}
    </style></head><body><aside class="proof">BROWSER LAYOUT SURROGATE | ${screenName} | ${width}x${height}px | font ${fontScale}x<br>Layout fixtures, not a live account. Not Android/Yoga/device proof.</aside>${markup}</body></html>`;
}

const cases = [
  ['Home', 360], ['Home', 390], ['Home', 430], ['Home', 768], ['Title', 390], ['Title', 768], ['Series', 390], ['Search', 390], ['Person', 390], ['MyList', 390],
  ['Home', 390, 1.5], ['Title', 390, 1.8], ['Search', 390, 1.8], ['Home', 390, 1, 'loading'], ['Home', 390, 1, 'error'],
  ['Home', 375], ['Home', 844, 1, 'ready', 390], ['Title', 844, 1, 'ready', 390], ['Search', 844, 1, 'ready', 390], ['Person', 844, 1, 'ready', 390], ['MyList', 844, 1, 'ready', 390],
  ['Labels', 375, 2], ['LongTitle', 375, 2], ['LongTitle', 1024],
];
const results = [];
try {
  for (const [name, width, fontScale = 1, state = 'ready', height = 900] of cases) {
    const id = `${name.toLowerCase()}-${width}${height < width ? '-landscape' : ''}${fontScale === 1 ? '' : `-font${fontScale}`}${state === 'ready' ? '' : `-${state}`}`;
    const markup = await render(name, width, fontScale, state, height);
    writeFileSync(resolve(output, `lumora-native-${id}.html`), markup);
    await page.setViewportSize({ width, height });
    await page.setContent(markup, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => [...document.images].every((image) => image.complete), undefined, { timeout: 15000 }).catch(() => {});
    const result = await page.evaluate(() => ({ overflow: Math.max(0, document.documentElement.scrollWidth - innerWidth), controls: [...document.querySelectorAll('button')].map((button) => ({ label: button.getAttribute('aria-label') ?? button.textContent.trim(), width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height })), images: [...document.images].filter((image) => image.naturalWidth > 0).length, escapedImages: [...document.images].filter((image) => { const art = image.getBoundingClientRect(), frame = image.parentElement.getBoundingClientRect(); return art.left < frame.left - 2 || art.top < frame.top - 2 || art.right > frame.right + 2 || art.bottom > frame.bottom + 2; }).length }));
    assert.ok(result.overflow <= 1, `${id}: horizontal overflow ${result.overflow}`);
    assert.equal(result.escapedImages, 0, `${id}: artwork escaped its native-style relative frame`);
    if (name === 'Labels') assert.equal(await page.locator('.text').evaluateAll((labels) => labels.filter((label) => label.scrollWidth > label.clientWidth + 1 || label.scrollHeight > label.clientHeight + 1).length), 0, 'Long values were clipped');
    for (const control of result.controls) assert.ok(control.width >= 47.5 && control.height >= 47.5, `${id}: small control ${JSON.stringify(control)}`);
    await page.screenshot({ path: resolve(output, `lumora-native-${id}.png`), fullPage: false });
    if (name === 'Series') { await page.locator('button[aria-label^="Play season"]').first().scrollIntoViewIfNeeded(); await page.screenshot({ path: resolve(output, 'lumora-native-episodes-390.png') }); }
    results.push({ id, ...result, screenshot: `lumora-native-${id}.png` });
    console.log(`${id}: overflow=${result.overflow}, controls=${result.controls.length}, loadedImages=${result.images}`);
  }
  const fingerprint = createHash('sha256').update(['src/theme.ts', ...['Home', 'Title', 'Search', 'Person', 'MyList'].map((name) => `src/screens/${name}Screen.tsx`), ...['ui', 'Hero', 'MediaCard', 'Row', 'Artwork', 'Skeletons', 'Icon'].map((name) => `src/components/${name}.tsx`), 'src/components/layout.ts', 'src/components/motion.ts'].map(source).join('\n')).digest('hex');
  writeFileSync(resolve(output, 'lumora-native-visual-proof.json'), JSON.stringify({ kind: 'browser-layout-surrogate', nativeDeviceVerified: false, fingerprint, results }, null, 2));
  console.log(`PASS ${results.length} browser-layout cases; source ${fingerprint}. Android/Yoga/TalkBack/device acceptance remains unverified.`);
} finally { await page.close(); await browser.close(); }
