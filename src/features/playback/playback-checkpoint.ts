/** Synchronous, browser-local resume points. Never an authorization source. */
const STORAGE_KEY = 'lumora:playback-checkpoints:v1';
const MAX_ENTRIES = 100;
const MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000;
const MAX_STORAGE_LENGTH = 256_000;

export interface PlaybackCheckpoint {
  positionSeconds: number;
  durationSeconds?: number;
  /** Epoch milliseconds, comparable with server ResumePosition.updatedAt. */
  updatedAt: number;
  /** An older in-flight report may get a newer server write timestamp. */
  pendingSync?: boolean;
}

interface StoredCheckpoint extends PlaybackCheckpoint {
  viewerKey: string;
  mediaKey: string;
}

/** An episode ID is authoritative; coordinates are only a fallback without it. */
export function playbackMediaKey(
  titleId: string,
  episodeId?: string,
  seasonNumber?: number,
  episodeNumber?: number,
): string {
  if (typeof titleId !== 'string' || !titleId.trim() || titleId.length > 200) return '';
  if (episodeId !== undefined) {
    if (typeof episodeId !== 'string' || !episodeId.trim() || episodeId.length > 200) return '';
    return JSON.stringify([titleId, 'episode', episodeId]);
  }
  if (seasonNumber !== undefined || episodeNumber !== undefined) {
    if (!Number.isSafeInteger(seasonNumber) || seasonNumber! < 0 ||
        !Number.isSafeInteger(episodeNumber) || episodeNumber! < 1) return '';
    return JSON.stringify([titleId, 'episode', seasonNumber, episodeNumber]);
  }
  return JSON.stringify([titleId, 'title']);
}

function validScope(viewerKey: unknown, mediaKey: unknown): boolean {
  return typeof viewerKey === 'string' && viewerKey.length <= 256 &&
    (viewerKey === 'guest' || /^account:[^:\s]+(?::profile:[^:\s]+)?$/.test(viewerKey)) &&
    typeof mediaKey === 'string' && mediaKey.length > 0 && mediaKey.length <= 512;
}

function validPosition(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER;
}

function validTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= Date.now();
}

function readStored(): StoredCheckpoint[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw || raw.length > MAX_STORAGE_LENGTH) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const now = Date.now();
    return parsed.filter((entry): entry is StoredCheckpoint => {
      if (!entry || typeof entry !== 'object') return false;
      const e = entry as StoredCheckpoint;
      return validScope(e.viewerKey, e.mediaKey) && validPosition(e.positionSeconds) &&
        (e.pendingSync === undefined || typeof e.pendingSync === 'boolean') &&
        (e.durationSeconds === undefined || (validPosition(e.durationSeconds) && e.durationSeconds > 0)) &&
        Number.isFinite(e.updatedAt) && e.updatedAt > 0 &&
        e.updatedAt >= now - MAX_AGE_MS && e.updatedAt <= now;
    }).map((e) => ({
      viewerKey: e.viewerKey,
      mediaKey: e.mediaKey,
      positionSeconds: e.positionSeconds,
      ...(e.durationSeconds !== undefined ? { durationSeconds: e.durationSeconds } : {}),
      updatedAt: e.updatedAt,
      ...(e.pendingSync ? { pendingSync: true } : {}),
    })).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_ENTRIES);
  } catch {
    return [];
  }
}

export function readPlaybackCheckpoint(viewerKey: string, mediaKey: string): PlaybackCheckpoint | null {
  if (!validScope(viewerKey, mediaKey)) return null;
  const entry = readStored().find((e) => e.viewerKey === viewerKey && e.mediaKey === mediaKey);
  if (!entry) return null;
  return {
    positionSeconds: entry.positionSeconds,
    ...(entry.durationSeconds !== undefined ? { durationSeconds: entry.durationSeconds } : {}),
    updatedAt: entry.updatedAt,
    ...(entry.pendingSync ? { pendingSync: true } : {}),
  };
}

/** Returns the persisted point, or null on invalid input/storage failure. Zero resets resume. */
export function writePlaybackCheckpoint(
  viewerKey: string,
  mediaKey: string,
  positionSeconds: number,
  durationSeconds?: number,
  pendingSync = false,
  capturedAt = Date.now(),
): PlaybackCheckpoint | null {
  if (!validScope(viewerKey, mediaKey) || !validPosition(positionSeconds) ||
      typeof pendingSync !== 'boolean' || !validTimestamp(capturedAt) ||
      (durationSeconds !== undefined && !validPosition(durationSeconds))) return null;
  const checkpoint: PlaybackCheckpoint = {
    positionSeconds,
    ...(durationSeconds !== undefined && durationSeconds > 0 ? { durationSeconds } : {}),
    updatedAt: capturedAt,
    ...(pendingSync ? { pendingSync: true } : {}),
  };
  try {
    const rest = readStored().filter((e) => e.viewerKey !== viewerKey || e.mediaKey !== mediaKey);
    const entries = [
      { viewerKey, mediaKey, ...checkpoint }, ...rest,
    ].slice(0, MAX_ENTRIES);
    let serialized = JSON.stringify(entries);
    // Escaped opaque IDs can exceed their string lengths; bound encoded storage too.
    while (serialized.length > MAX_STORAGE_LENGTH && entries.length > 1) {
      entries.pop();
      serialized = JSON.stringify(entries);
    }
    localStorage.setItem(STORAGE_KEY, serialized);
    return checkpoint;
  } catch {
    return null;
  }
}

/** An old acknowledgement must never clear a newer seek's pending checkpoint. */
export function markPlaybackCheckpointSynced(viewerKey: string, mediaKey: string, reported: PlaybackCheckpoint): void {
  if (!validScope(viewerKey, mediaKey)) return;
  const entries = readStored();
  const current = entries.find((entry) => entry.viewerKey === viewerKey && entry.mediaKey === mediaKey);
  if (!current || current.updatedAt !== reported.updatedAt || current.positionSeconds !== reported.positionSeconds
    || current.durationSeconds !== reported.durationSeconds) return;
  delete current.pendingSync;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(entries)); } catch { /* Keep the local point authoritative. */ }
}
