import { createElement, type AnchorHTMLAttributes, type ImgHTMLAttributes } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('next/link', () => ({ default: ({ prefetch: _prefetch, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { prefetch?: boolean }) => createElement('a', props) }));
vi.mock('next/image', () => ({ default: ({ fill: _fill, priority: _priority, unoptimized: _unoptimized, ...props }: ImgHTMLAttributes<HTMLImageElement> & { fill?: boolean; priority?: boolean; unoptimized?: boolean }) => createElement('img', props) }));
vi.mock('@/lib/env', () => ({ features: { supabaseConfigured: false }, publicEnv: { NEXT_PUBLIC_APP_URL: 'https://qa.invalid', NEXT_PUBLIC_APP_NAME: 'Synthetic QA' } }));
vi.mock('@/features/catalog/queries', () => ({ getSimilarTitles: vi.fn(async () => []), listCastForTitle: vi.fn(async () => []), listSeasonsForTitle: vi.fn(async () => []) }));
vi.mock('@/features/catalog/ratings-queries', () => ({ getRatingSummary: vi.fn(), getMyRating: vi.fn() }));
vi.mock('@/features/playback/progress-queries', () => ({ getResumablePlayback: vi.fn(), isSignedIn: vi.fn() }));
vi.mock('@/features/catalog/components/WatchlistButton', () => ({ WatchlistButton: () => null }));
vi.mock('@/features/catalog/components/RatingControl', () => ({ RatingControl: () => null }));
vi.mock('@/features/catalog/components/ResumePlayButton', () => ({ ResumePlayButton: () => null }));
vi.mock('@/features/catalog/components/ShareButton', () => ({ ShareButton: () => null }));

import { TrailerPreview } from '@/features/catalog/components/TrailerPreview';
import { TrailerButton } from '@/features/catalog/components/TrailerButton';
import { MediaCard } from '@/features/catalog/components/MediaCard';
import { TitleDetail } from '@/features/catalog/components/TitleDetail';
import type { Title } from '@/features/catalog/types';

const title: Title = { id: 'tmdb:movie:900001', tmdbId: '900001', imdbId: 'tt9000001', type: 'movie', slug: 'synthetic-qa-900001', name: 'Synthetic QA', synopsis: 'Invented QA metadata.', releaseYear: 2026, maturity: 'PG', genres: [] };
afterEach(() => { vi.unstubAllGlobals(); });

describe('SSR trailer integration without eager network or media', () => {
  it('renders hover preview as non-interactive decoration with no SSR video or metadata fetch', () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const markup = renderToStaticMarkup(createElement(TrailerPreview, { imdbId: title.imdbId }));
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).not.toContain('<video'); expect(markup).not.toContain('<iframe');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves the media-card title link and leaves playback absent on SSR', () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const markup = renderToStaticMarkup(createElement(MediaCard, { title }));
    expect(markup).toContain('href="/title/movie/synthetic-qa-900001"');
    expect(markup).not.toContain('<video'); expect(markup).not.toContain('<iframe');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('shows an explicit trailer action without an eager native dialog, MP4, or YouTube embed', () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const markup = renderToStaticMarkup(createElement(TrailerButton, { titleName: title.name, imdbId: title.imdbId, trailerUrl: 'https://www.youtube.com/watch?v=qaFixture01' }));
    expect(markup).toContain('Trailer'); expect(markup).toContain('type="button"');
    expect(markup).not.toContain('<dialog'); expect(markup).not.toContain('<video'); expect(markup).not.toContain('<iframe');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('exposes the Bingr action on a detail page without a stored YouTube URL or Supabase', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const markup = renderToStaticMarkup(await TitleDetail({ title }));
    expect(markup).toContain('Trailer');
    expect(markup).not.toContain('<video'); expect(markup).not.toContain('<iframe');
    expect(fetch).not.toHaveBeenCalled();
  });
});
