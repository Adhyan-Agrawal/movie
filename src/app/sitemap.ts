import type { MetadataRoute } from 'next';
import { publicEnv } from '@/lib/env';
import { listTitles } from '@/features/catalog/queries';

/**
 * Sitemap for published, public content (Section 16). Static routes plus one
 * entry per catalog title. Reads through the catalog query layer so it tracks
 * the real data source once Supabase is wired.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = publicEnv.NEXT_PUBLIC_APP_URL;

  const staticRoutes: MetadataRoute.Sitemap = [
    '',
    '/browse',
    '/movies',
    '/tv',
    '/search',
    '/legal/privacy',
    '/legal/terms',
    '/legal/cookies',
  ].map((path) => ({
    url: `${base}${path}`,
    changeFrequency: 'daily',
    priority: path === '' ? 1 : 0.6,
  }));

  const titles = await listTitles();
  const titleRoutes: MetadataRoute.Sitemap = titles.map((t) => ({
    url: `${base}/title/${t.type}/${t.slug}`,
    changeFrequency: 'weekly',
    priority: 0.7,
  }));

  return [...staticRoutes, ...titleRoutes];
}
