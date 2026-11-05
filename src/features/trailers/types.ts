export interface TrailerLookup {
  imdbId?: string;
  tmdbId?: string;
  type?: 'movie' | 'tv';
}

export interface TrailerInfo {
  url: string;
  previewUrl: string;
  mime: 'video/mp4';
  name: string;
  expiresAt: number;
}

const IMDB_ID = /^tt\d{7,12}$/;
const TMDB_ID = /^[1-9]\d{0,9}$/;

export function trailerLookupPath(input: TrailerLookup): string | null {
  if (input.imdbId && IMDB_ID.test(input.imdbId)) {
    return `/api/trailer?${new URLSearchParams({ imdbId: input.imdbId })}`;
  }
  if (input.tmdbId && TMDB_ID.test(input.tmdbId) && (input.type === 'movie' || input.type === 'tv')) {
    return `/api/trailer?${new URLSearchParams({ tmdbId: input.tmdbId, type: input.type })}`;
  }
  return null;
}

export function publicTrailerUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 4096 || /[\r\n\0]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash
      || (url.hostname !== 'imdb-video.media-imdb.com' && !url.hostname.endsWith('.media-imdb.com'))
      || !/\.mp4$/i.test(url.pathname)) return null;
    return url.href;
  } catch { return null; }
}

export function parseTrailerInfo(value: unknown, now = Date.now()): TrailerInfo | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const url = publicTrailerUrl(row.url);
  const previewUrl = publicTrailerUrl(row.previewUrl);
  if (!url || !previewUrl || row.mime !== 'video/mp4' || typeof row.name !== 'string'
    || !row.name.trim() || row.name.length > 200 || /[\u0000-\u001f\u007f]/.test(row.name)
    || typeof row.expiresAt !== 'number' || !Number.isSafeInteger(row.expiresAt)
    || row.expiresAt <= now || row.expiresAt > now + 60 * 60 * 1000) return null;
  for (const mediaUrl of [url, previewUrl]) {
    const expiry = trailerMediaExpiry(mediaUrl);
    const limit = expiry === Infinity ? now + 5 * 60 * 1000 : expiry === null ? 0 : expiry - 30_000;
    if (row.expiresAt > limit || limit <= now) return null;
  }
  return { url, previewUrl, mime: 'video/mp4', name: row.name.trim(), expiresAt: row.expiresAt };
}

export function trailerMediaExpiry(url: string): number | null {
  const values = new URL(url).searchParams.getAll('Expires');
  if (!values.length) return Infinity;
  if (values.length !== 1 || !/^\d{10,11}$/.test(values[0]!)) return null;
  const expiresAt = Number(values[0]) * 1000;
  return Number.isSafeInteger(expiresAt) ? expiresAt : null;
}

export function validImdbId(value: unknown): value is string {
  return typeof value === 'string' && IMDB_ID.test(value);
}
