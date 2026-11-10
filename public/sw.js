/*
 * Lumora service worker (PWA).
 *
 * Deliberately conservative: it makes the app INSTALLABLE and gives a usable
 * offline shell, without ever caching anything that could go stale or leak:
 * provider embeds, TMDB images, Supabase/auth calls, ad frames, and every
 * /api/* request pass straight through to the network.
 *
 * Cached:
 *   - the /offline shell (install-time precache)
 *   - immutable build assets under /_next/static/ (cache-first, no revalidation)
 *   - versioned icons/logo (cache-first, revalidated in the background)
 * Navigations are network-first with the offline shell as the fallback.
 */

const VERSION = 'lumora-v2';
const CACHE = `${VERSION}-static`;
const OFFLINE_URL = '/offline';
const PINNED_URLS = [OFFLINE_URL, '/icons/icon-192.png', '/icons/icon-512.png'];
const MAX_STATIC_ENTRIES = 128;

function isPublicResponse(response) {
  return response.status === 200 && !response.redirected
    && response.type !== 'opaque' && response.type !== 'opaqueredirect'
    && !response.headers.has('set-cookie')
    && !/(?:^|,)\s*(?:private|no-store)\b/i.test(response.headers.get('cache-control') ?? '')
    && !/(?:^|,)\s*(?:cookie|authorization|\*)\s*(?:,|$)/i.test(response.headers.get('vary') ?? '')
    && !/^(?:audio\/|video\/|application\/(?:vnd\.apple\.mpegurl|x-mpegurl|dash\+xml))/i.test(response.headers.get('content-type') ?? '');
}

async function putBounded(cache, request, response) {
  if (!isPublicResponse(response)) return;
  const url = new URL(typeof request === 'string' ? request : request.url, self.location.origin);
  if (url.pathname !== OFFLINE_URL && /^(?:text\/html|application\/json)/i.test(response.headers.get('content-type') ?? '')) return;
  await cache.put(request, response.clone());
  const keys = await cache.keys();
  let excess = keys.length - MAX_STATIC_ENTRIES;
  for (const key of keys) {
    if (excess <= 0) break;
    const url = new URL(key.url);
    if (!url.search && PINNED_URLS.includes(url.pathname)) continue;
    await cache.delete(key);
    excess--;
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await Promise.all(PINNED_URLS.map(async (url) => {
        try {
          const response = await fetch(url, { credentials: 'omit' });
          await putBounded(cache, url, response);
        } catch { /* Installation still works when the offline precache is unavailable. */ }
      }));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => /^lumora-v\d+-static$/.test(k) && k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

/** Only hashed build output and our own static art is safe to serve from cache. */
function isCacheableAsset(url) {
  return (
    (url.pathname.startsWith('/_next/static/') && /\.(?:js|css|woff2?|ttf|otf|png|jpe?g|svg|webp|avif|ico)$/i.test(url.pathname)) ||
    /^\/icons\/icon-(?:192|512|maskable-512)\.png$/.test(url.pathname) ||
    url.pathname === '/logo.png'
  );
}

function isImmutableAsset(url) {
  return url.pathname.startsWith('/_next/static/') && (
    /(?:^|[-./])[a-f0-9]{8,}(?:[-./]|$)/i.test(url.pathname)
    || /^\/_next\/static\/(?!development\/)[^/]+\/_(?:build|ssg)Manifest\.js$/.test(url.pathname)
  );
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || request.cache === 'no-store') return;

  const url = new URL(request.url);
  // Same-origin only. Everything cross-origin (providers, TMDB, Supabase, ads)
  // is left entirely alone.
  if (url.origin !== self.location.origin) return;
  if (/^\/(?:api|auth|account|admin|media|ticket|tickets|party|watch-party)(?:\/|$)/.test(url.pathname)
    || request.headers.has('authorization') || request.headers.has('cookie') || request.headers.has('range')
    || [...url.searchParams.keys()].some((key) => !['v', 'dpl'].includes(key))) return;

  // Navigations: prefer the network (fresh auth/state), fall back to offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          return await fetch(request);
        } catch {
          try {
            const cache = await caches.open(CACHE);
            const offline = await cache.match(OFFLINE_URL);
            return offline ?? Response.error();
          } catch { return Response.error(); }
        }
      })(),
    );
    return;
  }

  // Build URLs identify their contents. A hit must not even start a network request.
  if (isCacheableAsset(url)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const cached = await cache.match(request);
        if (cached && isImmutableAsset(url)) return cached;
        const network = fetch(new Request(request, { credentials: 'omit' }))
          .then(async (response) => {
            await putBounded(cache, request, response).catch(() => {});
            return response;
          })
          .catch(() => cached ?? Response.error());
        if (cached) event.waitUntil(network.then(() => {}));
        return cached ?? await network;
      })(),
    );
  }
});
