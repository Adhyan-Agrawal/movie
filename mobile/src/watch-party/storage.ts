import AsyncStorage from '@react-native-async-storage/async-storage';
import { WATCH_PARTY_CLOUDFLARE_BASE_URL } from './config';
import { WATCH_PARTY_LIMITS, isWatchPartyParticipantId, isWatchPartyRoomCode,
  type WatchPartyRoomSnapshotMessage } from './protocol';

const STORAGE_KEY = 'lumora:watch-party:android:v1';
const TOKEN_RE = /^wp1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export interface StoredWatchPartyResume {
  v: 1;
  roomCode: string;
  participantId: string;
  resumeToken: string;
  expiresAtMs: number;
}

export function buildWatchPartyInviteUrl(input: {
  roomCode: string;
  type: 'movie' | 'tv';
  slug: string;
  season?: number;
  episode?: number;
}): string | null {
  if (!isWatchPartyRoomCode(input.roomCode) || !input.slug.trim()) return null;
  try {
    const invite = new URL(`/watch/${input.type}/${encodeURIComponent(input.slug)}`, `${WATCH_PARTY_CLOUDFLARE_BASE_URL}/`);
    if (input.season !== undefined) invite.searchParams.set('season', String(input.season));
    if (input.episode !== undefined) invite.searchParams.set('episode', String(input.episode));
    invite.searchParams.set('party', input.roomCode);
    return invite.href;
  } catch { return null; }
}

export function buildWatchPartySchemeUrl(input: {
  roomCode: string;
  type: 'movie' | 'tv';
  slug: string;
  season?: number;
  episode?: number;
}): string | null {
  if (!isWatchPartyRoomCode(input.roomCode) || !input.slug.trim()) return null;
  const query = new URLSearchParams();
  if (input.season !== undefined) query.set('season', String(input.season));
  if (input.episode !== undefined) query.set('episode', String(input.episode));
  query.set('party', input.roomCode);
  return `lumora://watch/${input.type}/${encodeURIComponent(input.slug)}?${query.toString()}`;
}

function parseStoredResume(raw: string | null, nowMs: number): StoredWatchPartyResume | null {
  if (!raw) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Partial<StoredWatchPartyResume>;
  return record.v === 1 && isWatchPartyRoomCode(record.roomCode)
    && isWatchPartyParticipantId(record.participantId) && typeof record.resumeToken === 'string'
    && record.resumeToken.length <= 4096 && TOKEN_RE.test(record.resumeToken)
    && Number.isSafeInteger(record.expiresAtMs) && (record.expiresAtMs as number) > nowMs
    ? record as StoredWatchPartyResume : null;
}

export async function readWatchPartyResume(nowMs = Date.now()): Promise<StoredWatchPartyResume | null> {
  try {
    const value = parseStoredResume(await AsyncStorage.getItem(STORAGE_KEY), nowMs);
    if (!value) await AsyncStorage.removeItem(STORAGE_KEY).catch(() => {});
    return value;
  } catch { return null; }
}

export async function writeWatchPartyResume(snapshot: WatchPartyRoomSnapshotMessage,
  nowMs = Date.now()): Promise<StoredWatchPartyResume> {
  const value: StoredWatchPartyResume = { v: 1, roomCode: snapshot.room.roomCode,
    participantId: snapshot.self.participantId, resumeToken: snapshot.self.resumeToken,
    expiresAtMs: Math.min(snapshot.room.expiresAtMs, nowMs + WATCH_PARTY_LIMITS.resumeTtlSeconds * 1_000) };
  try { await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(value)); } catch { /* Best effort. */ }
  return value;
}

export async function clearWatchPartyResume(): Promise<void> {
  try { await AsyncStorage.removeItem(STORAGE_KEY); } catch { /* Best effort. */ }
}
