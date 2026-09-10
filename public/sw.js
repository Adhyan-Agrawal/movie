/*
 * Lumora service worker (PWA).
 *
 * Deliberately conservative: it makes the app INSTALLABLE and gives a usable
 * offline shell, without ever caching anything that could go stale or leak —
 * provider embeds, TMDB images, Supabase/auth calls, ad frames, and every
 * /api/* request pass straight through to the network.
 *
 * Cached:
 *   - the /offline shell (install-time precache)
 *   - immutable hashed build assets under /_next/static/ and our icons/logo
 *     (cache-first, revalidated in the background)
 * Navigations are network-first with the offline shell as the fallback.
 */

const VERSION = 'lumora-v1';
const CACHE = `${VERSION}-static`;
const OFFLINE_URL = '/offline';

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll([OFFLINE_URL, '/icons/icon-192.png', '/icons/icon-512.png']).catch(() => {});
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

/** Only hashed build output and our own static art is safe to serve from cache. */
function isCacheableAsset(url) {
  return (
    url.pathname.startsWith('/_next/static/') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname === '/logo.png'
  );
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Same-origin only. Everything cross-origin (providers, TMDB, Supabase, ads)
  // is left entirely alone.
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  // Navigations: prefer the network (fresh auth/state), fall back to offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          return await fetch(request);
        } catch {
          const cache = await caches.open(CACHE);
          const offline = await cache.match(OFFLINE_URL);
          return offline ?? Response.error();
        }
      })(),
    );
    return;
  }

  // Immutable assets: cache-first, refreshed in the background.
  if (isCacheableAsset(url)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const cached = await cache.match(request);
        const network = fetch(request)
          .then((response) => {
            if (response.ok) cache.put(request, response.clone());
            return response;
          })
          .catch(() => cached);
        return cached ?? network;
      })(),
    );
  }
});
