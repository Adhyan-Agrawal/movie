/**
 * Guest (signed-out) continue-watching store (Spec Sections 4, 8).
 *
 * Signed-in viewers get continue watching from `watch_progress` under RLS.
 * Guests get the same feature locally: entries live in THIS browser's
 * localStorage, so a guest only ever sees their own history — different
 * devices/browsers (and every other user) see nothing of it. On sign-in the
 * server-side history takes over (the home page shows one or the other, never
 * both).
 *
 * Client-side only: safe to import from any client component; never in
 * server code (no SSR — entries render after mount to avoid hydration
 * mismatches).
 */

import { playbackMediaKey } from './playback-checkpoint';

const STORAGE_KEY = 'lumora:guest-continue-watching';
const MAX_ENTRIES = 20;
/** Drop entries not touched for 60 days. */
const MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000;

export interface GuestWatchEntry {
  /** Title slug + type identify the title without a DB round-trip. */
  slug: string;
  type: 'movie' | 'tv';
  name: string;
  posterUrl?: string;
  /** 0..1 when the native player reported a position; undefined for embeds. */
  progress?: number;
  positionSeconds?: number;
  /** TV only: which episode the guest was on, so the row links and labels it. */
  episodeId?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  updatedAt: number;
}

function readRaw(): GuestWatchEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    if (raw.length > 256_000) return [];
    const parsed = JSON.parse(raw) as GuestWatchEntry[];
    if (!Array.isArray(parsed)) return [];
    const cutoff = Date.now() - MAX_AGE_MS;
    return parsed.filter((e) => validEntry(e) && Number.isFinite(e.updatedAt) &&
      e.updatedAt >= cutoff && e.updatedAt <= Date.now())
      .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_ENTRIES);
  } catch {
    return [];
  }
}

function validEntry(entry: Omit<GuestWatchEntry, 'updatedAt'>): boolean {
  return Boolean(entry) && typeof entry.slug === 'string' && entry.slug.trim().length > 0 &&
    entry.slug.length <= 200 && (entry.type === 'movie' || entry.type === 'tv') &&
    typeof entry.name === 'string' && entry.name.length <= 2_000 &&
    (entry.posterUrl === undefined || (typeof entry.posterUrl === 'string' && entry.posterUrl.length <= 8_000)) &&
    (entry.positionSeconds === undefined || (Number.isFinite(entry.positionSeconds) && entry.positionSeconds >= 0)) &&
    (entry.progress === undefined || (Number.isFinite(entry.progress) && entry.progress >= 0 && entry.progress <= 1)) &&
    (entry.seasonNumber === undefined || (Number.isSafeInteger(entry.seasonNumber) && entry.seasonNumber >= 0)) &&
    (entry.episodeNumber === undefined || (Number.isSafeInteger(entry.episodeNumber) && entry.episodeNumber >= 1)) &&
    Boolean(playbackMediaKey(entry.slug, entry.episodeId, entry.seasonNumber, entry.episodeNumber)) &&
    (entry.type === 'tv' || (entry.episodeId === undefined && entry.seasonNumber === undefined && entry.episodeNumber === undefined));
}

function mediaKey(entry: Omit<GuestWatchEntry, 'updatedAt'>): string {
  return playbackMediaKey(entry.slug, entry.episodeId, entry.seasonNumber, entry.episodeNumber);
}

function write(entries: GuestWatchEntry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
  } catch {
    // Private mode / quota — guest history is best-effort by design.
  }
}

/** All guest entries, newest first. */
export function readGuestEntries(): GuestWatchEntry[] {
  return readRaw().sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Refresh metadata without dropping a resume point for the SAME title/episode. */
export function recordGuestWatch(entry: Omit<GuestWatchEntry, 'updatedAt'>): void {
  if (!validEntry(entry)) return;
  const entries = readRaw();
  const previous = entries.find((e) => e.slug === entry.slug && e.type === entry.type);
  const sameCoordinates = previous?.type === 'tv' && entry.type === 'tv'
    && entry.seasonNumber !== undefined && entry.episodeNumber !== undefined
    && previous.seasonNumber === entry.seasonNumber && previous.episodeNumber === entry.episodeNumber;
  const sameMedia = previous && (mediaKey(previous) === mediaKey(entry) || sameCoordinates);
  const rest = entries.filter((e) => e.slug !== entry.slug || e.type !== entry.type);
  write([{
    ...entry,
    ...(sameMedia && entry.positionSeconds === undefined && previous.positionSeconds !== undefined
      ? { positionSeconds: previous.positionSeconds } : {}),
    ...(sameMedia && entry.positionSeconds === undefined && entry.progress === undefined && previous.progress !== undefined
      ? { progress: previous.progress } : {}),
    updatedAt: Date.now(),
  }, ...rest]);
}

/**
 * Update a guest entry's position (native player telemetry while signed out).
 * For TV, the caller also passes the current episode so the entry points back
 * at the exact spot the guest left off.
 */
export function updateGuestPosition(
  slug: string,
  positionSeconds: number,
  durationSeconds: number | undefined,
  episode?: { episodeId?: string; seasonNumber?: number; episodeNumber?: number },
): void {
  if (!Number.isFinite(positionSeconds) || positionSeconds < 0 ||
      (durationSeconds !== undefined && (!Number.isFinite(durationSeconds) || durationSeconds < 0))) return;
  const entries = readRaw();
  const hasEpisode = episode?.episodeId !== undefined || episode?.seasonNumber !== undefined || episode?.episodeNumber !== undefined;
  const key = playbackMediaKey(slug, episode?.episodeId, episode?.seasonNumber, episode?.episodeNumber);
  if (!key) return;
  const matches = entries.filter((e) => e.slug === slug && mediaKey(e) === key && (!hasEpisode || e.type === 'tv'));
  // Ambiguous title-only updates must not transfer progress between movie/TV entries.
  if (matches.length !== 1) return;
  const idx = entries.indexOf(matches[0]!);
  const entry = idx >= 0 ? entries[idx] : undefined;
  if (!entry) return;
  const progress =
    durationSeconds && durationSeconds > 0 ? Math.min(1, Math.max(0, positionSeconds / durationSeconds)) : undefined;
  entries[idx] = {
    ...entry,
    positionSeconds,
    progress,
    ...(episode?.episodeId !== undefined ? { episodeId: episode.episodeId } : {}),
    ...(episode?.seasonNumber !== undefined ? { seasonNumber: episode.seasonNumber } : {}),
    ...(episode?.episodeNumber !== undefined ? { episodeNumber: episode.episodeNumber } : {}),
    updatedAt: Date.now(),
  };
  write(entries.sort((a, b) => b.updatedAt - a.updatedAt));
}

/** Remove one entry (used when a guest finishes or clears a title). */
export function removeGuestEntry(slug: string): void {
  write(readRaw().filter((e) => e.slug !== slug));
}
