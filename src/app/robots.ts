import type { MetadataRoute } from 'next';
import { publicEnv } from '@/lib/env';

/**
 * Robots policy (Section 16). Public catalog is indexable; account, admin, and
 * player surfaces are disallowed from indexing.
 */
export default function robots(): MetadataRoute.Robots {
  const base = publicEnv.NEXT_PUBLIC_APP_URL;
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/account', '/admin', '/watch', '/api'],
      },
    ],
    sitemap: `${base}/sitemap.xml`,
    host: base,
  };
}
