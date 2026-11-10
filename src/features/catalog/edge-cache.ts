import 'server-only';

const MAX_BODY_BYTES = 512 * 1024;
const CACHE_MARKER = 'X-Lumora-Public-Catalog';
const CACHE_UNTIL = 'X-Lumora-Catalog-Until';
const PARAMS = new Set(['view', 'type', 'slug', 'sort', 'originalLanguage', 'country', 'limit', 'page', 'genre', 'query']);

/** Completed public responses only. No shared promise ever owns another request's I/O. */
export async function withPublicCatalogCache(request: Request, load: () => Promise<Response>): Promise<Response> {
  const storage = globalThis.caches as (CacheStorage & { default?: Cache }) | undefined;
  const cache = storage?.default;
  const url = new URL(request.url);
  let key: Request | undefined;
  try {
    const origin = new URL(process.env.NEXT_PUBLIC_APP_URL ?? '').origin;
    const entries = [...url.searchParams];
    if (cache && request.method === 'GET' && url.origin === origin && request.url.length <= 2048
      && request.cache !== 'no-store' && request.cache !== 'reload'
      && !request.headers.has('authorization') && !request.headers.has('cookie') && !request.headers.has('range')
      && !/no-cache|no-store/i.test(request.headers.get('cache-control') ?? '')
      && entries.every(([name]) => PARAMS.has(name)) && new Set(entries.map(([name]) => name)).size === entries.length) {
      const normalized = new URL('/__lumora_public_catalog/v1', origin);
      normalized.search = url.search;
      normalized.searchParams.sort();
      key = new Request(normalized, { method: 'GET' });
    }
  } catch { /* Local builds and unconfigured environments do not have an edge cache. */ }

  if (cache && key) {
    try {
      const found = await cache.match(key);
      if (found?.status === 200 && found.headers.get(CACHE_MARKER) === '1' && !found.headers.has('set-cookie')
        && Number(found.headers.get(CACHE_UNTIL)) > Date.now()
        && /^application\/json(?:;|$)/i.test(found.headers.get('content-type') ?? '')
        && /\bpublic\b/.test(found.headers.get('cache-control') ?? '')) {
        const response = new Response(found.body, found);
        response.headers.delete(CACHE_MARKER);
        response.headers.delete(CACHE_UNTIL);
        response.headers.set('X-Lumora-Data-Cache', 'HIT');
        return response;
      }
    } catch { /* Cache failure must not become an application failure. */ }
  }

  const response = await load();
  response.headers.set('X-Lumora-Data-Cache', key ? 'MISS' : 'BYPASS');
  if (response.headers.has('set-cookie')) {
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  }
  if (!cache || !key || response.status !== 200
    || !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '')
    || !/\bpublic\b/.test(response.headers.get('cache-control') ?? '')
    || /private|no-store/i.test(response.headers.get('cache-control') ?? '')) return response;

  const now = Date.now();
  const day = new Date(now);
  const ttl = Math.min(60, Math.floor((Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() + 1) - now) / 1000));
  if (ttl < 1) return response;
  const reader = response.clone().body?.getReader();
  if (!reader) return response;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        void reader.cancel().catch(() => {});
        response.headers.set('Cache-Control', 'private, no-store');
        return response;
      }
      chunks.push(value);
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    const headers = new Headers(response.headers);
    headers.delete('content-encoding');
    headers.set('Content-Length', String(size));
    headers.set('Cache-Control', `public, max-age=${ttl}`);
    headers.set(CACHE_MARKER, '1');
    headers.set(CACHE_UNTIL, String(now + ttl * 1000));
    await cache.put(key, new Response(body, { status: 200, headers }));
  } catch { /* The origin response is already safe to return uncached. */ }
  finally { reader.releaseLock(); }
  return response;
}
