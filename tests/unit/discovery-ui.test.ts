import { createElement, type AnchorHTMLAttributes, type ImgHTMLAttributes, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HomeData } from '@/features/catalog/data';
import type { DiscoveryCollection, Title } from '@/features/catalog/types';

const mocks = vi.hoisted(() => ({ home: vi.fn(), query: 'originalLanguage=hi&country=IN&sort=score&page=3' }));
vi.mock('@/features/catalog/data', () => ({ getHomeData: mocks.home }));
vi.mock('next/link', async () => {
  const { createElement } = await import('react');
  return { default: ({ prefetch, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { prefetch?: boolean }) => createElement('a', { ...props, 'data-prefetch': prefetch === undefined ? undefined : String(prefetch) }) };
});
vi.mock('next/image', async () => {
  const { createElement } = await import('react');
  return { default: ({ priority, fill: _fill, ...props }: ImgHTMLAttributes<HTMLImageElement> & { priority?: boolean; fill?: boolean }) => createElement('img', { ...props, 'data-priority': String(priority ?? false) }) };
});
vi.mock('next/navigation', () => ({
  usePathname: () => '/movies', useRouter: () => ({ replace: vi.fn() }), useSearchParams: () => new URLSearchParams(mocks.query),
}));
vi.mock('@/features/catalog/components/GuestContinueWatchingRow', async () => {
  const { createElement } = await import('react');
  return { GuestContinueWatchingRow: () => createElement('aside', { 'data-guest-history': true }, 'Guest history') };
});
vi.mock('@/features/ads/AdSlot', async () => {
  const { createElement } = await import('react');
  return { AdSlot: () => createElement('aside', { 'data-ad-slot': true }) };
});
vi.mock('@/features/ads/ConsentGate', () => ({ ConsentGate: ({ children }: { children: ReactNode }) => children }));

import HomePage from '@/app/page';
import { DiscoveryNav } from '@/features/catalog/components/DiscoveryNav';
import { DiscoveryFilters } from '@/features/catalog/components/DiscoveryFilters';
import { Hero } from '@/features/catalog/components/Hero';
import { HeroCarousel } from '@/features/catalog/components/HeroCarousel';
import { MediaCard } from '@/features/catalog/components/MediaCard';
import { ContinueWatchingRow, MediaRow } from '@/features/catalog/components/MediaRow';

const title: Title = {
  id: 'tmdb:movie:1', type: 'movie', slug: 'fixture-1', name: 'Fixture title', synopsis: 'A real metadata fixture.',
  releaseYear: 2024, maturity: 'PG', genres: ['Comedy'], originalLanguage: 'hi', score: 82,
  backdropUrl: 'https://image.tmdb.org/t/p/w1280/fixture.jpg',
};
const hindi: DiscoveryCollection = { id: 'hindi-cinema', label: 'Hindi cinema', href: '/browse?type=movie&originalLanguage=hi&sort=trending', filters: { type: 'movie', originalLanguage: 'hi', sort: 'trending' } };
const emptyHome: HomeData = { hero: null, heroTitles: [], rows: [], collections: [], continueWatching: [], signedIn: false, forYou: null, degraded: false };
beforeEach(() => mocks.home.mockReset().mockResolvedValue(emptyHome));

describe('discovery navigation', () => {
  it('omits navigation when no real collections are returned', () => {
    expect(renderToStaticMarkup(createElement(DiscoveryNav, { collections: [] }))).toBe('');
  });

  it('uses the DTO listing link and avoids eager category prefetches', () => {
    const markup = renderToStaticMarkup(createElement(DiscoveryNav, { collections: [hindi] }));
    expect(markup).toContain('href="/browse?type=movie&amp;originalLanguage=hi&amp;sort=trending"');
    expect(markup).toContain('data-prefetch="false"');
    expect(markup).toContain('Explore genres and world cinema');
  });

  it('preserves language, country and sort on a locked movie listing', () => {
    const collection = { ...hindi, filters: { ...hindi.filters, country: 'IN', sort: 'score' as const } };
    const markup = renderToStaticMarkup(createElement(DiscoveryNav, { collections: [collection], type: 'movie' }));
    expect(markup).toContain('href="/movies?type=movie&amp;originalLanguage=hi&amp;sort=score&amp;country=IN"');
    expect(renderToStaticMarkup(createElement(DiscoveryNav, { collections: [collection], type: 'tv' }))).toBe('');
  });

  it('does not treat Action & Adventure as a Sci-Fi genre alias', () => {
    const collections: DiscoveryCollection[] = [
      { id: 'action', label: 'Action', href: '/browse?genre=Action', filters: { genre: 'Action' } },
      { id: 'scifi', label: 'Sci-Fi', href: '/browse?genre=Science+Fiction', filters: { genre: 'Science Fiction' } },
    ];
    const markup = renderToStaticMarkup(createElement(DiscoveryNav, { collections, type: 'tv', genres: ['Action & Adventure'] }));
    expect(markup).toContain('>Action</a>');
    expect(markup).not.toContain('>Sci-Fi</a>');
  });

  it('shows URL-controlled original-language/country values with visible labels', () => {
    const markup = renderToStaticMarkup(createElement(DiscoveryFilters));
    expect(markup).toContain('Original language');
    expect(markup).toContain('Country of origin');
    expect(markup).toMatch(/value="hi" selected=""/);
    expect(markup).toMatch(/value="IN" selected=""/);
    expect(markup).toContain('role="status"');
    expect(markup).toContain('Language is not nationality');
  });
});

describe('real shelves and spotlight', () => {
  it('omits empty shelves and keeps optional view-all links backward compatible', () => {
    expect(renderToStaticMarkup(createElement(MediaRow, { row: { id: 'empty', heading: 'Empty', titles: [], href: '/browse' } }))).toBe('');
    const markup = renderToStaticMarkup(createElement(MediaRow, { row: { id: 'legacy', heading: 'Movies', titles: [title] } }));
    expect(markup).toContain('Fixture title');
    expect(markup).not.toContain('View all');
  });

  it('links a shelf to its full filter collection and retains the honest reason', () => {
    const markup = renderToStaticMarkup(createElement(MediaRow, { row: { id: hindi.id, collectionId: hindi.id, heading: hindi.label, titles: [title], href: hindi.href, filters: hindi.filters, reason: 'Bollywood and other Hindi-language films' } }));
    expect(markup).toContain('aria-label="View all Hindi cinema"');
    expect(markup).toContain('href="/browse?type=movie&amp;originalLanguage=hi&amp;sort=trending"');
    expect(markup).toContain('Bollywood and other Hindi-language films');
  });

  it('shows a provider rating, never a fabricated personal match', () => {
    const hero = renderToStaticMarkup(createElement(Hero, { title }));
    const card = renderToStaticMarkup(createElement(MediaCard, { title }));
    expect(hero).toContain('8.2/10 rating');
    expect(card).toContain('8.2/10');
    expect(hero).not.toContain('% match');
    expect(hero).not.toContain('<video');
  });

  it('gives spotlight slides unique headings and prioritizes only the first image', () => {
    const markup = renderToStaticMarkup(createElement('div', null,
      createElement(Hero, { title, priority: true }),
      createElement(Hero, { title: { ...title, id: 'tmdb:tv:2', type: 'tv' }, priority: false }),
    ));
    expect(markup).toContain('id="hero-title-tmdb-movie-1"');
    expect(markup).toContain('id="hero-title-tmdb-tv-2"');
    expect(markup.match(/data-priority="true"/g)).toHaveLength(1);
  });

  it('makes inactive slides inert and keeps controls within responsive side insets', () => {
    const children = Array.from({ length: 6 }, (_, index) => createElement(Hero, { key: index, title: { ...title, id: String(index) }, priority: index === 0 }));
    const markup = renderToStaticMarkup(createElement(HeroCarousel, null, children));
    expect(markup.match(/inert=""/g)).toHaveLength(5);
    expect(markup).toContain('aria-label="Previous trending title"');
    expect(markup).toContain('aria-label="Next trending title"');
    expect(markup).toContain('absolute inset-x-4 bottom-6');
    expect(markup).toContain('motion-reduce:transition-none');
  });

  it('does not invent a watched percentage when continue-watching has no telemetry', () => {
    const markup = renderToStaticMarkup(createElement(ContinueWatchingRow, { entries: [{ title }] }));
    expect(markup).toContain('position unknown');
    expect(markup).not.toContain('% watched');
    expect(markup).not.toMatch(/style="width:/);
  });
});

describe('home history isolation and empty states', () => {
  it('preserves signed-in continue-watching even if the public catalog is empty', async () => {
    mocks.home.mockResolvedValue({ ...emptyHome, signedIn: true, continueWatching: [{ title }] });
    const markup = renderToStaticMarkup(await HomePage());
    expect(markup).toContain('Continue watching');
    expect(markup).toContain('The catalog is empty');
    expect(markup).not.toContain('data-guest-history');
    expect(markup).not.toContain('discovery-hero');
  });

  it('keeps guest history separate and does not fabricate empty discovery rows', async () => {
    const markup = renderToStaticMarkup(await HomePage());
    expect(markup).toContain('data-guest-history');
    expect(markup).toContain('No titles are available from the catalog right now');
    expect(markup).not.toContain('discovery-shelf');
  });

  it('retains For You, watchlist access and real collection shelves', async () => {
    const row = { id: hindi.id, heading: hindi.label, titles: [title], href: hindi.href, filters: hindi.filters };
    mocks.home.mockResolvedValue({ ...emptyHome, hero: title, heroTitles: [title], collections: [hindi], rows: [row], forYou: { id: 'for-you', heading: 'For You', titles: [title] } });
    const markup = renderToStaticMarkup(await HomePage());
    expect(markup).toContain('For You');
    expect(markup).toContain('href="/account/watchlist"');
    expect(markup).toContain('aria-label="View all Hindi cinema"');
  });
});
