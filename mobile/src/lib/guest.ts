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

interface GuestEntry {
  slug: string;
  type: TitleType;
  name: string;
  posterUrl?: string;
  backdropUrl?: string;
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
  const entries = (await readRaw()).sort((a, b) => b.updatedAt - a.updatedAt);
  return entries.map((e) => {
    // Rebuild a minimal Title for rendering the card; the real row is fetched
    // lazily by the screen if it needs full detail.
    const title: Title = {
      id: e.slug,
      type: e.type,
      slug: e.slug,
      name: e.name,
      synopsis: '',
      releaseYear: 0,
      maturity: 'PG-13',
      genres: [],
      ...(e.posterUrl ? { posterUrl: e.posterUrl } : {}),
      ...(e.backdropUrl ? { backdropUrl: e.backdropUrl } : {}),
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
  const rest = (await readRaw()).filter((e) => e.slug !== entry.slug);
  await write([{ ...entry, updatedAt: Date.now() }, ...rest]);
}

/** Update the saved position/episode for a guest entry. */
export async function updateGuestPosition(
  slug: string,
  positionSeconds: number,
  durationSeconds: number | undefined,
  episode?: { seasonNumber?: number; episodeNumber?: number },
): Promise<void> {
  const entries = await readRaw();
  const idx = entries.findIndex((e) => e.slug === slug);
  const entry = idx >= 0 ? entries[idx] : undefined;
  if (!entry) return;
  const progress =
    durationSeconds && durationSeconds > 0 ? Math.min(1, Math.max(0, positionSeconds / durationSeconds)) : undefined;
  entries[idx] = { ...entry, positionSeconds, progress, ...(episode ?? {}), updatedAt: Date.now() };
  await write(entries.sort((a, b) => b.updatedAt - a.updatedAt));
}
