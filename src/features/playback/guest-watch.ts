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
    const parsed = JSON.parse(raw) as GuestWatchEntry[];
    if (!Array.isArray(parsed)) return [];
    const cutoff = Date.now() - MAX_AGE_MS;
    return parsed.filter((e) => e && typeof e.slug === 'string' && e.updatedAt >= cutoff);
  } catch {
    return [];
  }
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

/** Record (or refresh) that this browser watched a title — cap 20, dedupe by slug. */
export function recordGuestWatch(entry: Omit<GuestWatchEntry, 'updatedAt'>): void {
  const rest = readRaw().filter((e) => e.slug !== entry.slug);
  write([{ ...entry, updatedAt: Date.now() }, ...rest]);
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
  const entries = readRaw();
  const idx = entries.findIndex((e) => e.slug === slug);
  const entry = idx >= 0 ? entries[idx] : undefined;
  if (!entry) return;
  const progress =
    durationSeconds && durationSeconds > 0 ? Math.min(1, Math.max(0, positionSeconds / durationSeconds)) : undefined;
  entries[idx] = {
    ...entry,
    positionSeconds,
    progress,
    ...(episode ? { ...episode } : {}),
    updatedAt: Date.now(),
  };
  write(entries.sort((a, b) => b.updatedAt - a.updatedAt));
}

/** Remove one entry (used when a guest finishes or clears a title). */
export function removeGuestEntry(slug: string): void {
  write(readRaw().filter((e) => e.slug !== slug));
}
