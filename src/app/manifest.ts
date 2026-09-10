import type { MetadataRoute } from 'next';
import { publicEnv } from '@/lib/env';

/**
 * Web app manifest (PWA, Spec Section 3 — Lumora as an installable app).
 *
 * Next serves this at /manifest.webmanifest and injects the <link rel="manifest">
 * tag automatically. `display: 'standalone'` makes an installed Lumora open
 * full-screen with no browser chrome, so it behaves like a native app on both
 * Android and iOS home screens.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: `${publicEnv.NEXT_PUBLIC_APP_NAME} — Cinematic streaming`,
    short_name: publicEnv.NEXT_PUBLIC_APP_NAME,
    description: 'A calm, premium place to discover and watch movies and television.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#08090c',
    theme_color: '#08090c',
    categories: ['entertainment', 'video'],
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
