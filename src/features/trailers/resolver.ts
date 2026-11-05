import { publicTrailerUrl, trailerMediaExpiry, validImdbId, type TrailerInfo } from './types';
import { readTrailerJson } from './payload';

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
const CACHE_TTL = 60 * 60 * 1000;
const MAX_ENTRIES = 128;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function variant(value: unknown): { url: string; quality: string } | null {
  if (!record(value) || (typeof value.mime === 'string' && !/^(?:MP4|video\/mp4)$/i.test(value.mime))) return null;
  const url = publicTrailerUrl(value.url);
  return url ? { url, quality: typeof value.quality === 'string' ? value.quality.toLowerCase() : '' } : null;
}

export function normalizeBingrTrailer(value: unknown, now = Date.now()): TrailerInfo | null {
  if (!record(value) || value.provider !== 'imdb' || value.contentType !== 'Trailer'
    || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 200
    || /[\u0000-\u001f\u007f]/.test(value.name)
    || (value.all !== undefined && (!Array.isArray(value.all) || value.all.length > 16))) return null;
  const candidates = Array.isArray(value.all) ? value.all.flatMap((item) => variant(item) ?? []) : [];
  const best = variant(value.mp4) ?? variant(value.best) ?? candidates[0];
  if (!best) return null;
  const preview = candidates.find((item) => item.quality === '480p')
    ?? candidates.find((item) => item.quality === '360p') ?? best;
  let expiresAt = now + CACHE_TTL;
  for (const item of [best, preview]) {
    const expiry = trailerMediaExpiry(item.url);
    if (expiry === null) return null;
    expiresAt = Math.min(expiresAt, expiry === Infinity ? now + 5 * 60 * 1000 : expiry - 30_000);
  }
  if (expiresAt <= now) return null;
  return { url: best.url, previewUrl: preview.url, mime: 'video/mp4', name: value.name.trim(), expiresAt };
}

export function createTrailerResolver(options: { fetchImpl?: FetchLike; now?: () => number } = {}) {
  const cache = new Map<string, { value: TrailerInfo | null; expiresAt: number }>();
  const now = options.now ?? (() => Date.now());
  const fetchImpl: FetchLike = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  return async (imdbId: string, parentSignal?: AbortSignal): Promise<TrailerInfo | null> => {
    if (!validImdbId(imdbId) || parentSignal?.aborted) return null;
    const time = now();
    for (const [key, item] of cache) if (item.expiresAt <= time) cache.delete(key);
    const cached = cache.get(imdbId);
    if (cached) return cached.value;
    const controller = new AbortController();
    const abort = () => controller.abort();
    parentSignal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, 4500);
    try {
      const response = await fetchImpl(`https://bingr.one/api/trailer/imdb/${imdbId}?prefer=oldest`, {
        headers: { Accept: 'application/json' }, credentials: 'omit', redirect: 'manual',
        cache: 'no-store', signal: controller.signal,
      });
      if (!response.ok || response.status !== 200) {
        await response.body?.cancel();
        if (response.status === 404) {
          if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value!);
          cache.set(imdbId, { value: null, expiresAt: now() + 60_000 });
        }
        return null;
      }
      const trailer = normalizeBingrTrailer(await readTrailerJson(response, controller.signal), now());
      if (trailer && !controller.signal.aborted) {
        if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value!);
        cache.set(imdbId, { value: trailer, expiresAt: trailer.expiresAt });
      }
      return controller.signal.aborted ? null : trailer;
    } catch { return null; }
    finally {
      clearTimeout(timeout);
      parentSignal?.removeEventListener('abort', abort);
    }
  };
}

export const resolveTrailer = createTrailerResolver();
