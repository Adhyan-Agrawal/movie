import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ContinueEntry, Title, TitleType } from './types';

/**
 * Guest (signed-out) continue-watching store for the native app.
 *
 * Mirrors the web's localStorage store: entries live on THIS device only, so a
 * guest never sees another account's history. Signed-in viewers use the
 * server-side watch_progress rows instead (RLS-scoped).
 */
const STORAGE_KEY = 'lumora:guest-continue-watching';
const MAX_ENTRIES = 20;
const MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000;
let mutationQueue: Promise<void> = Promise.resolve();

function mutate(run: () => Promise<void>): Promise<void> {
  mutationQueue = mutationQueue.then(run).catch(() => {});
  return mutationQueue;
}

interface GuestEntry {
  slug: string;
  type: TitleType;
  name: string;
  posterUrl?: string;
  backdropUrl?: string;
  /**
   * Provider ids. Required for playback: the bridge returns no sources without
   * a TMDB or IMDb id, so a guest entry without them can't be played at all.
   */
  tmdbId?: string;
  imdbId?: string;
  /** Catalog id (uuid) — enables native sources + real progress keys. */
  catalogId?: string;
  progress?: number;
  positionSeconds?: number;
  seasonNumber?: number;
  episodeNumber?: number;
  updatedAt: number;
}

async function readRaw(): Promise<GuestEntry[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as GuestEntry[];
    if (!Array.isArray(parsed)) return [];
    const cutoff = Date.now() - MAX_AGE_MS;
    return parsed.filter((e) => e && typeof e.slug === 'string' && e.updatedAt >= cutoff);
  } catch {
    return [];
  }
}

async function write(entries: GuestEntry[]): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
  } catch {
    // Best effort — guest history is a convenience, never critical.
  }
}

export async function readGuestEntries(): Promise<ContinueEntry[]> {
  await mutationQueue;
  const entries = (await readRaw()).sort((a, b) => b.updatedAt - a.updatedAt);
  return entries.map((e) => {
    // Rebuild a Title for the card; ids are carried through so the player can
    // actually resolve a source for this entry.
    const title: Title = {
      id: e.catalogId ?? e.slug,
      type: e.type,
      slug: e.slug,
      name: e.name,
      synopsis: '',
      releaseYear: 0,
      maturity: 'PG-13',
      genres: [],
      ...(e.posterUrl ? { posterUrl: e.posterUrl } : {}),
      ...(e.backdropUrl ? { backdropUrl: e.backdropUrl } : {}),
      ...(e.tmdbId ? { tmdbId: e.tmdbId } : {}),
      ...(e.imdbId ? { imdbId: e.imdbId } : {}),
    };
    return {
      title,
      ...(e.progress !== undefined ? { progress: e.progress } : {}),
      ...(e.positionSeconds !== undefined ? { positionSeconds: e.positionSeconds } : {}),
      ...(e.seasonNumber !== undefined ? { seasonNumber: e.seasonNumber } : {}),
      ...(e.episodeNumber !== undefined ? { episodeNumber: e.episodeNumber } : {}),
    };
  });
}

/** Record (or refresh) that this device watched a title. */
export async function recordGuestWatch(entry: Omit<GuestEntry, 'updatedAt'>): Promise<void> {
  if (entry.type === 'tv' && (entry.seasonNumber === undefined || entry.episodeNumber === undefined)) return;
  return mutate(async () => {
    const entries = await readRaw();
    const same = (e: GuestEntry) => e.slug === entry.slug && e.type === entry.type
      && e.seasonNumber === entry.seasonNumber && e.episodeNumber === entry.episodeNumber;
    const previous = entries.find(same);
    await write([{ ...previous, ...entry, updatedAt: Date.now() }, ...entries.filter((e) => !same(e))]);
  });
}

/** Update the saved position/episode for a guest entry. */
export async function updateGuestPosition(
  slug: string,
  positionSeconds: number,
  durationSeconds: number | undefined,
  episode?: { seasonNumber?: number; episodeNumber?: number },
  titleType?: TitleType,
): Promise<void> {
  if (!Number.isFinite(positionSeconds) || positionSeconds < 0) return;
  return mutate(async () => {
    const entries = await readRaw();
    const idx = entries.findIndex((e) => e.slug === slug && (!titleType || e.type === titleType)
      && e.seasonNumber === episode?.seasonNumber && e.episodeNumber === episode?.episodeNumber);
    const entry = idx >= 0 ? entries[idx] : undefined;
    if (!entry || (entry.type === 'tv' && !episode)) return;
    const progress = durationSeconds && durationSeconds > 0
      ? Math.min(1, Math.max(0, positionSeconds / durationSeconds)) : entry.progress;
    entries[idx] = { ...entry, positionSeconds, progress, updatedAt: Date.now() };
    await write(entries.sort((a, b) => b.updatedAt - a.updatedAt));
  });
}

export async function getGuestResume(slug: string, type: TitleType, season?: number, episode?: number): Promise<{ positionSeconds: number; updatedAt: number } | null> {
  if (type === 'tv' && (season === undefined || episode === undefined)) return null;
  await mutationQueue;
  const entry = (await readRaw()).find((e) => e.slug === slug && e.type === type
    && e.seasonNumber === season && e.episodeNumber === episode);
  return entry && Number.isFinite(entry.positionSeconds) && entry.positionSeconds! >= 0
    ? { positionSeconds: entry.positionSeconds!, updatedAt: entry.updatedAt } : null;
}
