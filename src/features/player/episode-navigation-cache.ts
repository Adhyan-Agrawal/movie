import 'server-only';

import { episodeNavigationPath, parseEpisodeNavigation, type EpisodeNavigation, type EpisodeNavigationRequest } from './episode-navigation';

const SOURCE_TTL_SECONDS = 300;
const BROWSER_TTL_SECONDS = 60;
const MAX_ENTRIES = 128;
type Entry = { navigation: EpisodeNavigation; expiresAt: number };
// Settled public DTOs only: no request, response, cookie, or pending I/O owner.
const entries = new Map<string, Entry>();

function key(input: EpisodeNavigationRequest): string | undefined {
  const path = episodeNavigationPath(input);
  return path ? `${new Date().toISOString().slice(0, 10)}:${path}` : undefined;
}

function result(entry: Entry): { navigation: EpisodeNavigation; cacheControl: string } | null {
  const remaining = Math.floor((entry.expiresAt - Date.now()) / 1000);
  if (remaining <= 0) return null;
  return {
    navigation: {
      previous: entry.navigation.previous ? { ...entry.navigation.previous } : null,
      next: entry.navigation.next ? { ...entry.navigation.next } : null,
    },
    cacheControl: `public, max-age=${Math.min(BROWSER_TTL_SECONDS, remaining)}, s-maxage=${remaining}, must-revalidate`,
  };
}

export function readEpisodeNavigationCache(input: EpisodeNavigationRequest) {
  const cacheKey = key(input);
  if (!cacheKey) return null;
  const entry = entries.get(cacheKey);
  if (!entry) return null;
  const cached = result(entry);
  if (!cached) entries.delete(cacheKey);
  return cached;
}

/** Call only after the current episode and both boundaries are verified. */
export function cacheEpisodeNavigation(input: EpisodeNavigationRequest, value: EpisodeNavigation, origin: string) {
  const cacheKey = key(input);
  const navigation = parseEpisodeNavigation(value, origin);
  if (!cacheKey || !navigation || (!navigation.previous && !navigation.next)
    || [navigation.previous, navigation.next].some((target) => target && !target.href.split('?', 1)[0]?.endsWith(`-${input.tmdbId}`))) return null;
  const current = input.season * 1000 + input.episode;
  if ((navigation.previous && navigation.previous.seasonNumber * 1000 + navigation.previous.episodeNumber >= current)
    || (navigation.next && navigation.next.seasonNumber * 1000 + navigation.next.episodeNumber <= current)) return null;
  const now = Date.now();
  const tomorrow = new Date(now);
  tomorrow.setUTCHours(24, 0, 0, 0);
  const entry = { navigation, expiresAt: Math.min(now + SOURCE_TTL_SECONDS * 1000, tomorrow.getTime()) };
  const cached = result(entry);
  if (!cached) return null;
  for (const [expiredKey, expired] of entries) if (expired.expiresAt <= now) entries.delete(expiredKey);
  entries.delete(cacheKey);
  if (entries.size >= MAX_ENTRIES) entries.delete(entries.keys().next().value!);
  entries.set(cacheKey, entry);
  return cached;
}

export function clearEpisodeNavigationCache(): void {
  entries.clear();
}
