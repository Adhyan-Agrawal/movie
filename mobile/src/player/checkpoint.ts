import AsyncStorage from '@react-native-async-storage/async-storage';

export interface Checkpoint { positionSeconds: number; durationSeconds?: number; playing: boolean; updatedAt: number; pendingSync?: boolean }
const PREFIX = 'lumora:mobile-checkpoint:v1:';
const MAX_AGE = 60 * 24 * 60 * 60 * 1000;
const memory = new Map<string, Checkpoint>();
const writes = new Map<string, Promise<void>>();

export function mediaKey(input: { titleId: string; type: 'movie' | 'tv'; season?: number; episode?: number; episodeId?: string }): string {
  if (!input.titleId) return '';
  if (input.type === 'movie') return `movie:${input.titleId}`;
  // Coordinates stay stable when optional catalog metadata supplies/loses an episode UUID.
  if (Number.isInteger(input.season) && input.season! >= 0 && Number.isInteger(input.episode) && input.episode! > 0) {
    return `tv:${input.titleId}:s${input.season}:e${input.episode}`;
  }
  return input.episodeId ? `tv:${input.titleId}:episode:${input.episodeId}` : '';
}

function storageKey(viewer: string, media: string): string | null {
  return media && (viewer === 'guest' || /^account:[^:]+(?::profile:[^:]+)?$/.test(viewer))
    ? `${PREFIX}${encodeURIComponent(viewer)}:${encodeURIComponent(media)}` : null;
}

export function validCheckpoint(value: unknown, now = Date.now()): value is Checkpoint {
  if (!value || typeof value !== 'object') return false;
  const c = value as Checkpoint;
  return Number.isFinite(c.positionSeconds) && c.positionSeconds >= 0 && c.positionSeconds <= 2147483647
    && Number.isFinite(c.updatedAt) && c.updatedAt <= now + 60000 && c.updatedAt >= now - MAX_AGE
    && (c.durationSeconds === undefined || (Number.isFinite(c.durationSeconds) && c.durationSeconds > 0))
    && (c.pendingSync === undefined || typeof c.pendingSync === 'boolean')
    && typeof c.playing === 'boolean';
}

export function selectResume(viewer: string, local: Checkpoint | null, history: { positionSeconds: number; updatedAt: number } | null) {
  return local && (viewer === 'guest' || local.pendingSync || !history || local.updatedAt >= history.updatedAt) ? local : history;
}

export async function readCheckpoint(viewer: string, media: string): Promise<Checkpoint | null> {
  const key = storageKey(viewer, media);
  if (!key) return null;
  const cached = memory.get(key);
  if (cached && validCheckpoint(cached)) return cached;
  try {
    const raw = await AsyncStorage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    // A seek may arrive while the disk read is pending. Never replace it with stale disk data.
    const latest = memory.get(key);
    if (latest && validCheckpoint(latest)) return latest;
    if (!validCheckpoint(parsed)) return null;
    memory.set(key, parsed);
    return parsed;
  } catch { return null; }
}

/** Updates memory synchronously, then serializes disk writes (including backward seeks and zero). */
export function writeCheckpoint(viewer: string, media: string, positionSeconds: number, durationSeconds: number | undefined, playing: boolean, pendingSync = false): Promise<Checkpoint | null> {
  const key = storageKey(viewer, media);
  const checkpoint: Checkpoint = { positionSeconds, playing, pendingSync, updatedAt: Date.now(),
    ...(durationSeconds && durationSeconds > 0 ? { durationSeconds } : {}) };
  if (!key || !validCheckpoint(checkpoint)) return Promise.resolve(null);
  memory.set(key, checkpoint);
  if (memory.size > 100) memory.delete(memory.keys().next().value!);
  const next = (writes.get(key) ?? Promise.resolve()).then(() => AsyncStorage.setItem(key, JSON.stringify(checkpoint))).catch(() => {});
  writes.set(key, next);
  void next.then(() => { if (writes.get(key) === next) writes.delete(key); });
  return next.then(() => checkpoint);
}

export function markCheckpointSynced(viewer: string, media: string, expected: Checkpoint): Promise<void> {
  const key = storageKey(viewer, media);
  // Object identity also distinguishes two identical seek samples captured within the same millisecond.
  if (!key || memory.get(key) !== expected) return Promise.resolve();
  const synced = { ...expected, pendingSync: false };
  memory.set(key, synced);
  const next = (writes.get(key) ?? Promise.resolve()).then(() => AsyncStorage.setItem(key, JSON.stringify(synced))).catch(() => {});
  writes.set(key, next);
  void next.then(() => { if (writes.get(key) === next) writes.delete(key); });
  return next;
}
