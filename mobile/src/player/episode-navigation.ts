export interface EpisodeNavigationTarget {
  seasonNumber: number;
  episodeNumber: number;
  name: string;
  href: string;
}

export interface EpisodeNavigation {
  previous: EpisodeNavigationTarget | null;
  next: EpisodeNavigationTarget | null;
}

export interface EpisodeNavigationRequest {
  type: 'tv';
  tmdbId: string;
  season: number;
  episode: number;
}

const TMDB_ID = /^[1-9]\d{0,9}$/;
const SEASON = /^(?:0|[1-9]\d{0,2})$/;
const EPISODE = /^[1-9]\d{0,2}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REQUEST_KEYS = ['type', 'tmdbId', 'season', 'episode'];
const TARGET_KEYS = ['seasonNumber', 'episodeNumber', 'name', 'href'];

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function index(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= 999;
}

export function episodeNavigationPath(input: {
  type?: string;
  tmdbId?: string;
  season?: number;
  episode?: number;
}): string | undefined {
  if (input.type !== 'tv' || typeof input.tmdbId !== 'string' || !TMDB_ID.test(input.tmdbId)
    || !index(input.season, 0) || !index(input.episode, 1)) return undefined;
  return `/api/episode-navigation?${new URLSearchParams({
    type: 'tv', tmdbId: input.tmdbId, season: String(input.season), episode: String(input.episode),
  })}`;
}

export function parseEpisodeNavigationRequest(params: URLSearchParams): EpisodeNavigationRequest | null {
  if ([...params.keys()].some((key) => !REQUEST_KEYS.includes(key))
    || REQUEST_KEYS.some((key) => params.getAll(key).length !== 1)) return null;
  const tmdbId = params.get('tmdbId')!;
  const season = params.get('season')!;
  const episode = params.get('episode')!;
  if (params.get('type') !== 'tv' || !TMDB_ID.test(tmdbId) || !SEASON.test(season) || !EPISODE.test(episode)) return null;
  return { type: 'tv', tmdbId, season: Number(season), episode: Number(episode) };
}

/** Accept only episode watch links; never carry provider fields or arbitrary URLs into controls. */
export function parseEpisodeNavigation(value: unknown, origin: string): EpisodeNavigation | null {
  if (!record(value) || !exactKeys(value, ['previous', 'next'])) return null;
  let base: URL;
  try {
    base = new URL(origin);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) return null;
  } catch { return null; }

  const parseTarget = (value: unknown): EpisodeNavigationTarget | null => {
    if (!record(value) || !exactKeys(value, TARGET_KEYS)
      || !index(value.seasonNumber, 0) || !index(value.episodeNumber, 1)
      || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 200
      || /[\u0000-\u001f\u007f]/.test(value.name)
      || typeof value.href !== 'string' || value.href.length > 512
      || /[\\%#\s\u0000-\u001f\u007f]/.test(value.href)
      || (!value.href.startsWith('/watch/tv/') && !/^https?:\/\//.test(value.href))) return null;
    try {
      const url = new URL(value.href, base.origin);
      const match = /^\/watch\/tv\/([^/]+)$/.exec(url.pathname);
      const slug = match?.[1];
      if (url.origin !== base.origin || url.username || url.password || url.hash
        || !slug || slug.length > 120 || !SLUG.test(slug)
        || [...url.searchParams.keys()].some((key) => key !== 'season' && key !== 'episode')
        || url.searchParams.getAll('season').length !== 1 || url.searchParams.getAll('episode').length !== 1
        || url.searchParams.get('season') !== String(value.seasonNumber)
        || url.searchParams.get('episode') !== String(value.episodeNumber)) return null;
      // Reject dot-segment normalization instead of accepting a different raw path.
      const rawPath = value.href.startsWith('/') ? value.href.split('?', 1)[0] : /^https?:\/\/[^/]+([^?]*)/.exec(value.href)?.[1];
      if (rawPath !== url.pathname) return null;
      return {
        seasonNumber: value.seasonNumber, episodeNumber: value.episodeNumber, name: value.name.trim(),
        href: `${url.pathname}?${new URLSearchParams({ season: String(value.seasonNumber), episode: String(value.episodeNumber) })}`,
      };
    } catch { return null; }
  };

  const previous = value.previous === null ? null : parseTarget(value.previous);
  const next = value.next === null ? null : parseTarget(value.next);
  if ((value.previous !== null && !previous) || (value.next !== null && !next)) return null;
  if (previous && next && previous.href.split('?', 1)[0] !== next.href.split('?', 1)[0]) return null;
  return { previous, next };
}
