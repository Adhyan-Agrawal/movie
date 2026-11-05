import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Title } from '@/features/catalog/types';

const mocks = vi.hoisted(() => ({
  features: { supabaseConfigured: false, tmdbConfigured: true },
  title: vi.fn(),
  cookies: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/env', () => ({
  features: mocks.features,
  publicEnv: { NEXT_PUBLIC_APP_URL: 'https://catalog.example', NEXT_PUBLIC_APP_NAME: 'Lumora' },
  serverEnv: () => ({}),
}));
vi.mock('next/headers', () => ({ cookies: mocks.cookies }));
vi.mock('@/features/catalog/queries', () => ({
  getTitleBySlug: mocks.title,
  getTitleById: vi.fn(),
  getSimilarTitles: vi.fn(async () => []),
  listCastForTitle: vi.fn(async () => []),
  listSeasonsForTitle: vi.fn(async () => []),
}));
vi.mock('@/lib/providers/registry', () => ({ resolvePlayback: vi.fn(async () => ({ source: null })) }));
vi.mock('@/features/ads/AdSlot', () => ({ AdSlot: () => null }));
vi.mock('@/features/ads/ConsentGate', () => ({ ConsentGate: () => null }));

const title: Title = {
  id: 'tmdb:movie:1283515', type: 'movie', slug: 'verity-1283515', name: 'Verity',
  synopsis: 'A supplied catalog synopsis.', releaseYear: 2026, maturity: 'PG-13', genres: [],
  tmdbId: '1283515',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.features.supabaseConfigured = false;
  mocks.title.mockResolvedValue(title);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('title rendering without optional Supabase configuration', () => {
  it('renders the title page after metadata succeeds without reading an unavailable watchlist', async () => {
    // Isolated cold import passes (~1s); parallel suite transforms can exceed
    // Vitest's default 5s. Bound only this fixture, not application deadlines.
    const { default: TitlePage, generateMetadata } = await import('@/app/title/[type]/[slug]/page');
    const params = Promise.resolve({ type: 'movie', slug: title.slug });
    await expect(generateMetadata({ params })).resolves.toMatchObject({ title: 'Verity' });
    await expect(TitlePage({ params })).resolves.toBeTruthy();
    expect(mocks.cookies).not.toHaveBeenCalled();
  }, 15_000);

  it('renders title details without attempting unavailable sign-in, rating, or resume reads', async () => {
    const { TitleDetail } = await import('@/features/catalog/components/TitleDetail');
    await expect(TitleDetail({ title, availability: 'unavailable' })).resolves.toBeTruthy();
    expect(mocks.cookies).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });
});
