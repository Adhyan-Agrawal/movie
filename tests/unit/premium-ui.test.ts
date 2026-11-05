import { readFileSync } from 'node:fs';
import { createElement, type AnchorHTMLAttributes, type ImgHTMLAttributes } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import postcss from 'postcss';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Title } from '@/features/catalog/types';

const mocks = vi.hoisted(() => ({
  pathname: '/', captureEffects: false,
  effects: [] as (() => void | (() => void))[], refs: [] as { current: unknown }[],
  similar: vi.fn().mockResolvedValue([]), seasons: vi.fn().mockResolvedValue([]), cast: vi.fn().mockResolvedValue([]),
}));
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return {
    ...actual,
    useRef: (initial: unknown) => { const ref = actual.useRef(initial); if (mocks.captureEffects) mocks.refs.push(ref); return ref; },
    useEffect: (effect: () => void | (() => void), deps?: unknown[]) => { if (mocks.captureEffects) mocks.effects.push(effect); else actual.useEffect(effect, deps); },
  };
});
vi.mock('next/link', () => ({ default: ({ prefetch, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { prefetch?: boolean }) => createElement('a', { ...props, 'data-prefetch': prefetch === false ? 'false' : undefined }) }));
vi.mock('next/image', () => ({ default: ({ fill: _fill, priority, unoptimized, ...props }: ImgHTMLAttributes<HTMLImageElement> & { fill?: boolean; priority?: boolean; unoptimized?: boolean }) => createElement('img', { ...props, 'data-priority': String(priority ?? false), 'data-unoptimized': String(unoptimized ?? false) }) }));
vi.mock('next/navigation', () => ({ usePathname: () => mocks.pathname, useRouter: () => ({ replace: vi.fn() }), useSearchParams: () => new URLSearchParams('genre=Drama&originalLanguage=hi&country=IN') }));
vi.mock('@/lib/env', () => ({ features: { supabaseConfigured: false }, publicEnv: { NEXT_PUBLIC_APP_NAME: 'Lumora', NEXT_PUBLIC_APP_URL: 'https://lumora.example' } }));
vi.mock('@/features/catalog/queries', () => ({ getSimilarTitles: mocks.similar, listSeasonsForTitle: mocks.seasons, listCastForTitle: mocks.cast }));
vi.mock('@/features/catalog/ratings-queries', () => ({ getRatingSummary: vi.fn(), getMyRating: vi.fn() }));
vi.mock('@/features/playback/progress-queries', () => ({ getResumablePlayback: vi.fn(), isSignedIn: vi.fn() }));
vi.mock('@/features/catalog/components/TrailerButton', () => ({ TrailerButton: (props: { trailerUrl?: string; imdbId?: string; tmdbId?: string; type?: string }) => createElement('button', { type: 'button', 'data-trailer-props': JSON.stringify(props) }, 'Trailer') }));
vi.mock('@/features/catalog/components/TrailerPreview', () => ({ TrailerPreview: (props: unknown) => createElement('span', { 'data-preview-props': JSON.stringify(props) }) }));
vi.mock('@/features/catalog/components/WatchlistButton', () => ({ WatchlistButton: () => createElement('button', { type: 'button' }, 'Watchlist') }));
vi.mock('@/features/catalog/components/ShareButton', () => ({ ShareButton: () => createElement('button', { type: 'button' }, 'Share') }));
vi.mock('@/features/catalog/components/RatingControl', () => ({ RatingControl: () => createElement('div', null, 'No community ratings yet') }));
vi.mock('@/features/catalog/components/ResumePlayButton', () => ({ ResumePlayButton: ({ baseHref, playable }: { baseHref: string; playable: boolean }) => playable ? createElement('a', { href: baseHref }, 'Play') : createElement('button', { disabled: true }, 'Unavailable') }));

import { Logo } from '@/components/ui/Logo';
import { SectionReveal } from '@/components/ui/SectionReveal';
import { TopBar } from '@/components/shell/TopBar';
import { MobileNav } from '@/components/shell/MobileNav';
import { Hero } from '@/features/catalog/components/Hero';
import { MediaCard } from '@/features/catalog/components/MediaCard';
import { MediaRow, ContinueWatchingRow } from '@/features/catalog/components/MediaRow';
import { TitleDetail } from '@/features/catalog/components/TitleDetail';
import { FilterBar } from '@/features/catalog/components/FilterBar';

const title: Title = {
  id: 'tmdb:movie:1', type: 'movie', slug: 'test-film', name: 'A Film', synopsis: 'The real provider synopsis.',
  releaseYear: 2024, maturity: 'PG', genres: ['Drama'], runtimeMinutes: 128, score: 84,
  tmdbId: '1', imdbId: 'tt1234567', trailerUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
  posterUrl: 'https://image.tmdb.org/t/p/w500/poster.jpg', backdropUrl: 'https://image.tmdb.org/t/p/w1280/backdrop.jpg',
};
const css = readFileSync(new URL('../../src/styles/globals.css', import.meta.url), 'utf8');

beforeEach(() => {
  mocks.pathname = '/'; mocks.captureEffects = false; mocks.effects.length = 0; mocks.refs.length = 0;
  mocks.similar.mockClear(); mocks.seasons.mockClear(); mocks.cast.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe('cohesive accessible presentation', () => {
  it('renders the wordmark as intrinsic vector geometry without an image request', () => {
    const markup = renderToStaticMarkup(createElement(Logo, { size: 28, priority: true }));
    expect(markup).toContain('<svg width="28" height="28"');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).not.toContain('<img');
  });

  it('keeps desktop navigation, search and signed-out account access explicit', () => {
    const markup = renderToStaticMarkup(createElement(TopBar));
    for (const href of ['/', '/browse', '/movies', '/tv', '/search', '/signin', '/account']) expect(markup).toContain(`href="${href}"`);
    expect(markup).toContain('aria-label="Search"');
    expect(markup.match(/aria-current="page"/g)).toHaveLength(1);
  });

  it('marks only the most specific mobile destination active', () => {
    mocks.pathname = '/account/watchlist';
    const markup = renderToStaticMarkup(createElement(MobileNav));
    expect(markup.match(/aria-current="page"/g)).toHaveLength(1);
    expect(markup).toMatch(/href="\/account\/watchlist"[^>]*aria-current="page"/);
    expect(markup).toContain('My list');
  });

  it('preserves real spotlight metadata, play navigation and all trailer identifiers', () => {
    const markup = renderToStaticMarkup(createElement(Hero, { title }));
    expect(markup).toContain('2h 8m');
    expect(markup).toContain('8.4/10 rating');
    expect(markup).toContain('href="/watch/movie/test-film"');
    expect(markup).toContain('href="/title/movie/test-film"');
    expect(markup).toContain('data-trailer-props=');
    expect(markup).toContain('tt1234567');
    expect(markup).toContain('abcdefghijk');
    expect(markup).not.toMatch(/% match|\bHDR\b|\b4K\b|<video|<iframe/);
  });

  it('uses direct TMDB backdrop artwork for landscape cards and preserves hover-preview props', () => {
    const markup = renderToStaticMarkup(createElement(MediaCard, { title, variant: 'landscape' }));
    expect(markup).toContain('src="https://image.tmdb.org/t/p/w1280/backdrop.jpg"');
    expect(markup).toContain('data-unoptimized="true"');
    expect(markup).toContain('media-card-landscape');
    expect(markup).toContain('data-preview-props=');
    expect(markup).toContain('tt1234567');
    expect(markup).not.toContain('/_next/image');
  });

  it('uses an uncropped poster when no actual backdrop exists', () => {
    const markup = renderToStaticMarkup(createElement(MediaCard, { title: { ...title, backdropUrl: undefined }, variant: 'landscape' }));
    expect(markup).toContain('src="https://image.tmdb.org/t/p/w500/poster.jpg"');
    expect(markup).toContain('media-card-poster-fallback');
  });

  it('does not expose a fabricated certification or release year in browser-local history', () => {
    const markup = renderToStaticMarkup(createElement(MediaCard, { title: { ...title, releaseYear: 0, score: undefined }, showMaturity: false }));
    expect(markup).not.toContain('PG');
    expect(markup).not.toContain('8.4/10');
    expect(markup).toContain('aria-label="A Film"');
  });

  it('preserves collection links and provides actual collection numbering without inventing shelves', () => {
    const row = { id: 'drama', heading: 'Drama', titles: [title], href: '/browse?genre=Drama' };
    const markup = renderToStaticMarkup(createElement(MediaRow, { row, variant: 'landscape', number: 2 }));
    expect(markup).toContain('Collection 02');
    expect(markup).toContain('aria-label="View all Drama"');
    expect(markup).toContain('href="/browse?genre=Drama"');
    expect(renderToStaticMarkup(createElement(MediaRow, { row: { ...row, titles: [] } }))).toBe('');
  });

  it('retains exact episode resume links and never invents progress for external playback', () => {
    const entry = { title: { ...title, type: 'tv' as const }, episode: { episodeId: 'e', seasonNumber: 2, episodeNumber: 7, name: 'Episode seven' } };
    const markup = renderToStaticMarkup(createElement(ContinueWatchingRow, { entries: [entry] }));
    expect(markup).toContain('href="/watch/tv/test-film?season=2&amp;episode=7"');
    expect(markup).toContain('position unknown');
    expect(markup).not.toContain('media-card-progress');
  });

  it('keeps filter controls visibly labelled and URL-controlled', () => {
    const markup = renderToStaticMarkup(createElement(FilterBar, { genres: ['Drama', 'Comedy'] }));
    for (const label of ['Type', 'Genre', 'Decade', 'Maturity', 'Sort']) expect(markup).toContain(`>${label}</span>`);
    expect(markup).toContain('value="Drama" selected=""');
    expect(markup).toContain('aria-label="Remove Drama filter"');
    expect(markup).toContain('catalog-filter-select');
  });
});

describe('detail state preservation', () => {
  it.each(['available', 'unavailable', 'consent-required'] as const)('retains the %s playback state without changing SSR queries', async (availability) => {
    const markup = renderToStaticMarkup(await TitleDetail({ title, availability }));
    expect(mocks.similar).toHaveBeenCalledWith(title);
    expect(mocks.cast).toHaveBeenCalledWith(title.id);
    expect(mocks.seasons).not.toHaveBeenCalled();
    expect(markup).toContain('title-heading');
    expect(markup).toContain('tt1234567');
    expect(markup).toContain('2h 8m');
    if (availability === 'available') expect(markup).toContain('href="/watch/movie/test-film"');
    else expect(markup).toContain('disabled=""');
    if (availability === 'consent-required') expect(markup).toContain('Review and accept provider consent');
    if (availability === 'unavailable') expect(markup).toContain('Playback currently unavailable');
  });
});

describe('progressive, once-only motion', () => {
  function mountReveal({ reduced = false, top = 1200, cardTops = [] as number[] } = {}) {
    mocks.captureEffects = true;
    const cards = cardTops.map((cardTop) => ({ dataset: {} as Record<string, string>, getBoundingClientRect: () => ({ top: cardTop }) }));
    const node = { dataset: {} as Record<string, string>, getBoundingClientRect: () => ({ top }), querySelectorAll: () => cards, addEventListener: vi.fn(), removeEventListener: vi.fn() };
    const preference = { matches: reduced, addEventListener: vi.fn(), removeEventListener: vi.fn() };
    const observe = vi.fn(); const unobserve = vi.fn(); const disconnect = vi.fn();
    let intersect: (entries: { isIntersecting: boolean; target: typeof cards[number] }[]) => void = () => {};
    vi.stubGlobal('window', { innerHeight: 900, matchMedia: () => preference });
    vi.stubGlobal('IntersectionObserver', class { constructor(callback: typeof intersect) { intersect = callback; } observe = observe; unobserve = unobserve; disconnect = disconnect; });
    const markup = renderToStaticMarkup(createElement(SectionReveal, null, createElement('h2', null, 'Real content')));
    mocks.refs[0]!.current = node;
    const cleanup = mocks.effects[0]!();
    return { node, cards, preference, observe, unobserve, disconnect, intersect: (visible: boolean, target: typeof cards[number] = node) => intersect([{ isIntersecting: visible, target }]), markup, cleanup };
  }

  it('keeps SSR and above-the-fold content immediately visible', () => {
    const reveal = mountReveal({ top: 100 });
    expect(reveal.markup).not.toMatch(/hidden|pending|opacity-0/);
    expect(reveal.node.dataset.revealState).toBeUndefined();
    expect(reveal.observe).not.toHaveBeenCalled();
  });

  it('reveals a below-the-fold section once and disconnects its observer', () => {
    const reveal = mountReveal();
    expect(reveal.node.dataset.revealState).toBe('pending');
    reveal.intersect(false);
    expect(reveal.node.dataset.revealState).toBe('pending');
    reveal.intersect(true);
    expect(reveal.node.dataset.revealState).toBe('visible');
    expect(reveal.unobserve).toHaveBeenCalledWith(reveal.node);
    expect(reveal.disconnect).toHaveBeenCalledTimes(1);
    reveal.cleanup?.();
    expect(reveal.node.removeEventListener).toHaveBeenCalledWith('focusin', expect.any(Function));
  });

  it('does not install a reveal for reduced-motion users', () => {
    const reveal = mountReveal({ reduced: true, cardTops: [1300] });
    expect(reveal.node.dataset.revealState).toBeUndefined();
    expect(reveal.cards[0]!.dataset.revealState).toBeUndefined();
    expect(reveal.observe).not.toHaveBeenCalled();
  });

  it('bypasses every pending stagger immediately on keyboard focus', () => {
    const reveal = mountReveal({ cardTops: [1300, 1600] });
    const focus = reveal.node.addEventListener.mock.calls[0]![1] as () => void;
    focus();
    expect(reveal.node.dataset.revealState).toBe('complete');
    expect(reveal.cards.map((card) => card.dataset.revealState)).toEqual(['complete', 'complete']);
    expect(reveal.preference.addEventListener).toHaveBeenCalledWith('change', expect.any(Function), { once: true });
  });

  it('observes offscreen cards individually even when the section is already visible', () => {
    const reveal = mountReveal({ top: 100, cardTops: [200, 1100, 1400] });
    expect(reveal.node.dataset.revealState).toBeUndefined();
    expect(reveal.cards[0]!.dataset.revealState).toBeUndefined();
    expect(reveal.observe).toHaveBeenCalledTimes(2);
    reveal.intersect(true, reveal.cards[1]!);
    expect(reveal.cards[1]!.dataset.revealState).toBe('visible');
    expect(reveal.cards[2]!.dataset.revealState).toBe('pending');
    expect(reveal.disconnect).not.toHaveBeenCalled();
    reveal.intersect(true, reveal.cards[2]!);
    expect(reveal.unobserve).toHaveBeenCalledTimes(2);
    expect(reveal.disconnect).toHaveBeenCalledTimes(1);
  });

  it('finishes motion when reduced motion is enabled mid-scroll and cleans up state', () => {
    const reveal = mountReveal({ cardTops: [1300] });
    const change = reveal.preference.addEventListener.mock.calls[0]![1] as () => void;
    reveal.preference.matches = true;
    change();
    expect(reveal.node.dataset.revealState).toBe('complete');
    expect(reveal.cards[0]!.dataset.revealState).toBe('complete');
    reveal.cleanup?.();
    expect(reveal.node.dataset.revealState).toBeUndefined();
    expect(reveal.cards[0]!.dataset.revealState).toBeUndefined();
    expect(reveal.preference.removeEventListener).toHaveBeenCalledWith('change', change);
  });

  it('keeps content visible if motion-preference detection is unavailable', () => {
    mocks.captureEffects = true;
    vi.stubGlobal('window', { innerHeight: 900 });
    renderToStaticMarkup(createElement(SectionReveal, null, 'Visible'));
    const node = { dataset: {} as Record<string, string> };
    mocks.refs[0]!.current = node;
    expect(() => mocks.effects[0]!()).not.toThrow();
    expect(node.dataset.revealState).toBeUndefined();
  });

  it('falls back to visible content when IntersectionObserver is unavailable', () => {
    mocks.captureEffects = true;
    vi.stubGlobal('window', { innerHeight: 900, matchMedia: () => ({ matches: false }) });
    vi.stubGlobal('IntersectionObserver', undefined);
    renderToStaticMarkup(createElement(SectionReveal, null, 'Visible'));
    const node = { dataset: {} as Record<string, string>, getBoundingClientRect: () => ({ top: 1200 }) };
    mocks.refs[0]!.current = node;
    mocks.effects[0]!();
    expect(node.dataset.revealState).toBeUndefined();
  });
});

describe('visual contract and metadata guards', () => {
  it('reserves image ratios, 44px controls and native horizontal scrolling', () => {
    expect(css).toMatch(/\.media-card-artwork\s*\{[^}]*aspect-ratio: 2 \/ 3/);
    expect(css).toMatch(/\.media-card-landscape \.media-card-artwork\s*\{[^}]*aspect-ratio: 16 \/ 9/);
    expect(css).toMatch(/\.shelf-track\s*\{[^}]*overflow-x: auto[^}]*scroll-snap-type: x proximity[^}]*scroll-behavior: smooth/);
    expect(css).toMatch(/\.hero-pagination-button\s*\{[^}]*width: 44px[^}]*height: 44px/);
    expect(css).toContain('.title-detail button { min-height: 44px; }');
    expect(css).toContain(".title-detail [role='group'][aria-label='Rate this title out of 10'] button { min-width: 44px; }");
    expect(css).toContain(".section-reveal[data-reveal-state='pending'] { transform: translateY(14px); }");
    expect(css).not.toContain('animation-timeline: view()');
  });

  it('limits new entrances to finite compositor motion and users who permit motion', () => {
    const stylesheet = postcss.parse(css);
    const animations: string[] = [];
    stylesheet.walkDecls('animation', (declaration) => {
      if (!/lumora-(content-enter|artwork-settle|menu-enter)/.test(declaration.value)) return;
      animations.push(declaration.value);
      expect(declaration.value).not.toContain('infinite');
      expect(declaration.parent?.parent).toMatchObject({ name: 'media', params: '(prefers-reduced-motion: no-preference)' });
    });
    expect(animations).toHaveLength(4);
    expect(css).toContain('.hero-artwork, .title-hero > img {');
    expect(css).toContain('.hero-slide[inert] :is(.hero-content > *, .hero-artwork) { animation: none; }');
    stylesheet.walkAtRules('keyframes', (rule) => {
      if (!/^lumora-(content-enter|artwork-settle|menu-enter)$/.test(rule.params)) return;
      rule.walkDecls((declaration) => {
        expect(['transform', 'opacity']).toContain(declaration.prop);
        if (declaration.prop === 'opacity') expect(Number(declaration.value)).toBeGreaterThan(0);
      });
    });
    expect(css).toContain('--motion-delay: 300ms');
    expect(css).toContain(".section-reveal[data-reveal-state='complete']");
  });

  it('meets AA text contrast across the actual site surfaces', () => {
    const rgb = (name: string) => css.match(new RegExp(`--color-${name}: (\\d+) (\\d+) (\\d+)`))!.slice(1).map(Number);
    const luminance = (channels: number[]) => channels.map((channel) => { const value = channel / 255; return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4; }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index]!, 0);
    for (const surface of ['base', 'surface', 'surface-raised', 'surface-overlay']) for (const text of ['content', 'content-muted', 'content-subtle', 'primary-content', 'primary-content-hover']) {
      expect((luminance(rgb(text)) + 0.05) / (luminance(rgb(surface)) + 0.05), `${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
    }
    for (const background of ['primary', 'primary-hover']) {
      expect((luminance(rgb('primary-contrast')) + 0.05) / (luminance(rgb(background)) + 0.05), `button text on ${background}`).toBeGreaterThanOrEqual(4.5);
    }
    expect(css).toContain('.text-primary { color: rgb(var(--color-primary-content)); }');
  });

  it('preserves both clckd verification values and the existing Inter font dependency', () => {
    const layout = readFileSync(new URL('../../src/app/layout.tsx', import.meta.url), 'utf8');
    expect(layout).toContain('f3b2e6ec440a7d2aa713ff4c24e8538c');
    expect(layout).toContain('640e7381f91f7a3f72795b14d6027572');
    expect(layout).toContain("import { Inter } from 'next/font/google'");
    expect(layout).not.toContain('next/font/local');
  });
});
