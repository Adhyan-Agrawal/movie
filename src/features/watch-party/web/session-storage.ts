import {
  WATCH_PARTY_LIMITS,
  isWatchPartyParticipantId,
  isWatchPartyRoomCode,
  type WatchPartyRoomSnapshotMessage,
} from '../protocol';

const STORAGE_KEY = 'lumora:watch-party:web:v1';
const TOKEN_RE = /^wp1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export interface StoredWatchPartyResume {
  v: 1;
  roomCode: string;
  participantId: string;
  resumeToken: string;
  expiresAtMs: number;
}

export function buildWatchPartyInviteUrl(currentHref: string, roomCode: string): string | null {
  if (!isWatchPartyRoomCode(roomCode)) return null;
  try {
    const current = new URL(currentHref);
    if (current.protocol !== 'http:' && current.protocol !== 'https:') return null;
    const invite = new URL(current.pathname, current.origin);
    for (const key of ['season', 'episode']) {
      const value = current.searchParams.get(key);
      if (value && /^\d{1,4}$/.test(value)) invite.searchParams.set(key, value);
    }
    invite.searchParams.set('party', roomCode);
    return invite.href;
  } catch {
    return null;
  }
}

export function readWatchPartyResume(storage?: Storage, nowMs = Date.now()): StoredWatchPartyResume | null {
  let value: unknown;
  let session: Storage | undefined;
  try {
    session = storage ?? (typeof window === 'undefined' ? undefined : window.sessionStorage);
    const raw = session?.getItem(STORAGE_KEY);
    if (!raw) return null;
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Partial<StoredWatchPartyResume>;
  if (record.v !== 1 || !isWatchPartyRoomCode(record.roomCode)
    || !isWatchPartyParticipantId(record.participantId)
    || typeof record.resumeToken !== 'string' || record.resumeToken.length > 4096
    || !TOKEN_RE.test(record.resumeToken) || !Number.isSafeInteger(record.expiresAtMs)
    || (record.expiresAtMs as number) <= nowMs) {
    try { session?.removeItem(STORAGE_KEY); } catch { /* Storage is best effort. */ }
    return null;
  }
  return record as StoredWatchPartyResume;
}

export function writeWatchPartyResume(storage: Storage | undefined, snapshot: WatchPartyRoomSnapshotMessage,
  nowMs = Date.now()): StoredWatchPartyResume {
  const value: StoredWatchPartyResume = {
    v: 1,
    roomCode: snapshot.room.roomCode,
    participantId: snapshot.self.participantId,
    resumeToken: snapshot.self.resumeToken,
    expiresAtMs: Math.min(snapshot.room.expiresAtMs,
      nowMs + WATCH_PARTY_LIMITS.resumeTtlSeconds * 1_000),
  };
  try {
    const session = storage ?? (typeof window === 'undefined' ? undefined : window.sessionStorage);
    session?.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch { /* Storage is best effort. */ }
  return value;
}

export function clearWatchPartyResume(storage?: Storage): void {
  try {
    const session = storage ?? (typeof window === 'undefined' ? undefined : window.sessionStorage);
    session?.removeItem(STORAGE_KEY);
  } catch { /* Storage is best effort. */ }
}
