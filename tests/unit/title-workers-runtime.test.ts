import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { Miniflare, Response as FixtureResponse } from 'miniflare';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const fixture: Record<string, unknown> = {
  id: 1, title: 'Fixture film', name: 'Fixture series', overview: 'Synthetic TMDB acceptance data.',
  release_date: '2026-01-01', first_air_date: '2026-01-01', runtime: null, episode_run_time: [],
  original_language: null, poster_path: null, backdrop_path: null, vote_average: null,
  genres: [], credits: { cast: [] }, videos: { results: [] }, seasons: [],
};

// Only framework adapters and unrelated client controls are stubbed. The page,
// detail component, queries, cache, normalization and Supabase factories are real.
// SectionReveal remains real, behind a separate client SSR React dispatcher.
const stubs: Record<string, string> = {
  'server-only': '',
  '@/lib/env': `
    export const features = {supabaseConfigured:false,tmdbConfigured:true};
    export const publicEnv = {NEXT_PUBLIC_APP_URL:'https://fixture.test',NEXT_PUBLIC_APP_NAME:'Lumora'};
    export const serverEnv = () => ({TMDB_API_KEY:'synthetic-test-only',TMDB_API_BASE_URL:'https://tmdb.fixture/3'});
  `,
  'next/navigation': `export function notFound(){throw new Error('NEXT_HTTP_ERROR_FALLBACK;404')}`,
  'next/headers': `export async function cookies(){throw new Error('Unexpected personal request')}`,
  'next/link': `import {createElement} from 'react'; export default function Link(p){return createElement('a',{href:p.href},p.children)}`,
  'next/image': `import {createElement} from 'react'; export default function Image(p){return createElement('img',{src:p.src,alt:p.alt})}`,
  '@/lib/providers/registry': `export async function resolvePlayback(){return {source:null}}`,
  '@/features/ads/AdSlot': `export function AdSlot(){return null}`,
  '@/features/ads/ConsentGate': `export function ConsentGate(){return null}`,
  '@/components/ui/SectionReveal': `
    export const SectionReveal = {$$typeof:Symbol.for('react.client.reference'),$$id:'SectionReveal'};
  `,
};
for (const name of ['WatchlistButton', 'TrailerButton', 'ShareButton', 'RatingControl', 'ResumePlayButton', 'MediaRow', 'SeasonEpisodeList']) {
  stubs[`./${name}`] = `export function ${name}(){return null}`;
}

const clientEntry = `
  import {createElement} from 'react';
  import {renderToStaticMarkup} from 'react-dom/server.edge';
  import {SectionReveal} from '@/components/ui/SectionReveal';
  export function renderClient(id,props){
    if(id!=='SectionReveal') throw new Error('Unknown client reference');
    let rendered;
    function ClientSSR(){rendered=SectionReveal(props);return null}
    // Capture the real initial hook render without mounting refs or effects.
    // Server-owned children are then expanded by the request's RSC renderer.
    renderToStaticMarkup(createElement(ClientSSR));
    return rendered;
  }
`;

const entry = `
  import * as React from 'react';
  import {AsyncLocalStorage} from 'node:async_hooks';
  import {renderClient} from './client-ssr.js';
  import TitlePage, {generateMetadata} from '@/app/title/[type]/[slug]/page';
  import {clearTmdbPublicDataCache, getTmdbTitle} from '@/features/catalog/tmdb-catalog';
  const storage = new AsyncLocalStorage();
  React.__SERVER_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.A = {
    getCacheForType(factory){
      const roots = storage.getStore().roots;
      if(!roots.has(factory)) roots.set(factory,factory());
      return roots.get(factory);
    }
  };
  Object.defineProperty(globalThis,Symbol.for('__cloudflare-context__'),{get(){return storage.getStore()}});
  const escape = value => String(value).replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]));
  async function render(node){
    if(node==null || typeof node==='boolean') return '';
    if(Array.isArray(node)) return (await Promise.all(node.map(render))).join('');
    if(typeof node!=='object') return escape(node);
    if(node.type?.$$typeof===Symbol.for('react.client.reference')) return render(renderClient(node.type.$$id,node.props));
    if(typeof node.type==='function') return render(await node.type(node.props));
    if(typeof node.type!=='string') return render(node.props.children);
    const attrs = Object.entries(node.props).filter(([key,value])=>['id','role','aria-labelledby','aria-label'].includes(key)&&typeof value==='string')
      .map(([key,value])=>' '+key+'="'+escape(value)+'"').join('');
    return '<'+node.type+attrs+'>'+(await render(node.props.children))+'</'+node.type+'>';
  }
  export default {
    fetch(request,env,ctx){return storage.run({roots:new Map(),env,ctx},async()=>{
      const url = new URL(request.url);
      if(url.pathname==='/clear'){clearTmdbPublicDataCache();return new Response('cleared')}
      if(url.pathname==='/client-ssr'){
        const revealed=renderClient('SectionReveal',{id:'fixture-reveal',children:React.createElement('h2',null,'Server child')});
        return Response.json({html:await render(revealed),ref:revealed.props.ref.current,
          className:revealed.props.className,serverHasClientHooks:'useRef' in React});
      }
      const [,kind,type,slug] = url.pathname.split('/');
      if(kind==='abandon'){
        void getTmdbTitle(type,slug).catch(()=>{});
        return new Response('early');
      }
      try{
        const params = Promise.resolve({type,slug});
        const [metadata,page] = await Promise.all([generateMetadata({params}),TitlePage({params})]);
        const detail = page.props.children.find(child=>typeof child?.type==='function');
        const html = '<!doctype html><html><head><title>'+escape(metadata.title)+'</title></head><body><main>'+(await render(detail))+'</main></body></html>';
        return new Response(html,{headers:{'content-type':'text/html;charset=utf-8'}});
      }catch(error){
        return new Response(error.message,{status:error.message.includes(';404')?404:500});
      }
    })}
  };
`;

let worker: Miniflare;
let payload: Record<string, unknown>;
let status: number;
let delay: number;
let calls: string[];

beforeAll(async () => {
  const client = await build({
    stdin: { contents: clientEntry, resolveDir: root, loader: 'ts' },
    absWorkingDir: root, tsconfig: `${root}/tsconfig.json`, bundle: true, write: false,
    format: 'esm', platform: 'browser', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  const bundled = await build({
    stdin: { contents: entry, resolveDir: root, loader: 'ts' },
    absWorkingDir: root, tsconfig: `${root}/tsconfig.json`, bundle: true, write: false,
    format: 'esm', platform: 'node', conditions: ['react-server'],
    external: ['./client-ssr.js'],
    jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{
      name: 'title-runtime-fixtures',
      setup(builder) {
        builder.onResolve({ filter: /.*/ }, (args) => args.path in stubs ? { path: args.path, namespace: 'title-fixture' } : undefined);
        builder.onLoad({ filter: /.*/, namespace: 'title-fixture' }, (args) => ({ contents: stubs[args.path]!, loader: 'js', resolveDir: root }));
      },
    }],
  });
  worker = new Miniflare({
    cf: false, enableDevRegistry: false, telemetry: { enabled: false },
    workers: [{
      config: {
        name: 'title-runtime-fixture', compatibilityDate: '2026-10-30',
        compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public', 'enable_request_signal'],
        manifest: { mainModule: 'fixture.js', modules: {
          'fixture.js': { type: 'esm', contents: bundled.outputFiles[0]!.text },
          'client-ssr.js': { type: 'esm', contents: client.outputFiles[0]!.text },
        } },
      },
      dev: {
        outboundService: {
          type: 'fetcher',
          async handler(request) {
            const url = new URL(request.url);
            if (url.hostname !== 'tmdb.fixture') throw new Error('Real upstream I/O is forbidden in title acceptance');
            calls.push(url.pathname);
            if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
            if (url.pathname.includes('/genre/')) return FixtureResponse.json({ genres: [] });
            if (url.pathname.includes('/trending/')) return FixtureResponse.json({ results: [], total_results: 0 });
            return FixtureResponse.json({ ...payload, id: Number(url.pathname.split('/').pop()) }, { status });
          },
        },
      },
    }],
  });
  await worker.ready;
}, 30_000);

beforeEach(async () => {
  payload = { ...fixture };
  status = 200;
  delay = 0;
  calls = [];
  await worker.dispatchFetch('http://fixture.test/clear');
});
afterAll(async () => { if (worker) await worker.dispose(); });

describe('title acceptance in the real Workers runtime with synthetic TMDB', () => {
  it('renders the real client reveal with SSR hooks, null refs, and intact server children without browser effects', async () => {
    const response = await worker.dispatchFetch('http://fixture.test/client-ssr');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      html: '<div id="fixture-reveal"><h2>Server child</h2></div>',
      ref: null, className: 'section-reveal', serverHasClientHooks: false,
    });
    expect(calls).toEqual([]);
  });

  it('renders metadata and main movie content without Supabase and shares the detail lookup', async () => {
    const response = await worker.dispatchFetch('http://fixture.test/title/movie/fixture-1');
    const html = await response.text();
    expect(response.status, html).toBe(200);
    expect(html).toContain('<title>Fixture film</title>');
    expect(html).toContain('<h1 id="title-heading">Fixture film</h1>');
    expect(html).toContain('Synthetic TMDB acceptance data.');
    expect(html).toContain('Playback currently unavailable');
    expect(calls.filter((path) => path === '/3/movie/1')).toHaveLength(1);
  });

  it('keeps TV and movie lookups separate even when their TMDB IDs match', async () => {
    const movie = await worker.dispatchFetch('http://fixture.test/title/movie/fixture-1');
    const tv = await worker.dispatchFetch('http://fixture.test/title/tv/fixture-1');
    expect(await movie.text()).toContain('Fixture film');
    expect(await tv.text()).toContain('Fixture series');
    expect(calls).toContain('/3/movie/1');
    expect(calls).toContain('/3/tv/1');
  });

  it('shares only settled public data across requests, not pending I/O', async () => {
    delay = 40;
    const responses = await Promise.all([
      worker.dispatchFetch('http://fixture.test/title/movie/fixture-1'),
      worker.dispatchFetch('http://fixture.test/title/movie/fixture-1'),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    await Promise.all(responses.map((response) => response.text()));
    expect(calls.filter((path) => path === '/3/movie/1')).toHaveLength(2);
    const repeat = await worker.dispatchFetch('http://fixture.test/title/movie/fixture-1');
    expect(repeat.status, await repeat.text()).toBe(200);
    expect(calls.filter((path) => path === '/3/movie/1')).toHaveLength(2);
  });

  it('renders unknown optional data without inventing runtime, score, cast, or countries', async () => {
    payload = { ...fixture, genres: null, credits: null, videos: null, release_dates: null, production_countries: null };
    const response = await worker.dispatchFetch('http://fixture.test/title/movie/fixture-1');
    const html = await response.text();
    expect(response.status, html).toBe(200);
    expect(html).toContain('Fixture film');
    expect(html).toContain('No cast information yet');
    expect(html).not.toContain('% score');
    expect(html).not.toContain('Runtime');
  });

  it('allows overlapping request contexts to finish without sharing request-owned I/O', async () => {
    delay = 40;
    const responses = await Promise.all(Array.from({ length: 12 }, (_, index) => worker.dispatchFetch(`http://fixture.test/title/movie/fixture-${index + 1}`)));
    const html = await Promise.all(responses.map((response) => response.text()));
    expect(responses.map((response) => response.status), html.join('\n')).toEqual(Array(12).fill(200));
    expect(html.every((body) => body.includes('id="title-heading"'))).toBe(true);
  });

  it('does not let a completed request own a later request\'s pending title lookup', async () => {
    delay = 50;
    await worker.dispatchFetch('http://fixture.test/abandon/movie/fixture-1');
    const response = await worker.dispatchFetch('http://fixture.test/title/movie/fixture-1');
    const html = await response.text();
    expect(response.status, html).toBe(200);
    expect(html).toContain('id="title-heading"');
  }, 15_000);

  it('does not label a TMDB service error as a nonexistent title', async () => {
    status = 503;
    const response = await worker.dispatchFetch('http://fixture.test/title/movie/fixture-1');
    expect(response.status, await response.text()).toBe(500);
  });

  it('retries an upstream error rather than caching an empty or not-found title', async () => {
    status = 503;
    await worker.dispatchFetch('http://fixture.test/title/movie/fixture-1');
    status = 200;
    const retry = await worker.dispatchFetch('http://fixture.test/title/movie/fixture-1');
    expect(retry.status, await retry.text()).toBe(200);
    expect(calls.filter((path) => path === '/3/movie/1')).toHaveLength(2);
  });
});
