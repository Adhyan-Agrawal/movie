import { parseTrailerInfo, trailerLookupPath, type TrailerInfo, type TrailerLookup } from './types';
import { readTrailerJson } from './payload';

const cache = new Map<string, { value: TrailerInfo | null; expiresAt: number }>();
export async function loadTrailer(input: TrailerLookup, signal: AbortSignal): Promise<TrailerInfo | null> {
  const path = trailerLookupPath(input);
  if (!path || signal.aborted) return null;
  const now = Date.now();
  for (const [key, entry] of cache) if (entry.expiresAt <= now) cache.delete(key);
  const existing = cache.get(path);
  if (existing) return existing.value;
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, 6500);
  try {
    const response = await fetch(path, { credentials: 'omit', redirect: 'manual', signal: controller.signal });
    if (!response.ok) { await response.body?.cancel(); return null; }
    const body = await readTrailerJson(response, controller.signal);
    if (controller.signal.aborted || !body || typeof body !== 'object' || Array.isArray(body)) return null;
    const raw = (body as { trailer?: unknown }).trailer;
    const value = parseTrailerInfo(raw);
    if (value || raw === null) {
      if (cache.size >= 32) cache.delete(cache.keys().next().value!);
      cache.set(path, { value, expiresAt: value?.expiresAt ?? Date.now() + 15_000 });
    }
    return value;
  } catch { return null; }
  finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
  }
}
