import {
  WATCH_PARTY_LIMITS,
  WATCH_PARTY_PROTOCOL_VERSION,
  WATCH_PARTY_SUBPROTOCOL,
  WATCH_PARTY_TICKET_SUBPROTOCOL_PREFIX,
  isWatchPartyParticipantId,
  isWatchPartyRoomCode,
  normalizeWatchPartyDisplayName,
  parseWatchPartyMediaIdentity,
  type WatchPartyMediaIdentity,
  type WatchPartyPlatform,
  type WatchPartyRole,
} from './protocol';

const TOKEN_PREFIX = 'wp1';
const TOKEN_ISSUER = 'lumora-ticket-api';
const TOKEN_AUDIENCE = 'lumora-watch-party';
const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
const MAX_TOKEN_BYTES = 4096;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface WatchPartyTokenBase {
  v: typeof WATCH_PARTY_PROTOCOL_VERSION;
  iss: typeof TOKEN_ISSUER;
  aud: typeof TOKEN_AUDIENCE;
  jti: string;
  iat: number;
  exp: number;
  roomCode: string;
  roomId?: string;
  participantId: string;
  displayName: string;
  platform: WatchPartyPlatform;
}

export interface WatchPartyConnectTicketClaims extends WatchPartyTokenBase {
  kind: 'connect';
  action: 'create' | 'join' | 'resume';
  role: WatchPartyRole;
  media?: WatchPartyMediaIdentity;
  positionSeconds?: number;
}

export interface WatchPartyResumeTokenClaims extends WatchPartyTokenBase {
  kind: 'resume';
  roomId: string;
}

export type WatchPartyTokenClaims = WatchPartyConnectTicketClaims | WatchPartyResumeTokenClaims;

export type WatchPartyTokenVerification =
  | { ok: true; claims: WatchPartyTokenClaims }
  | { ok: false; reason: 'invalid' | 'expired' | 'not-yet-valid' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => allowed.has(key));
}

function validBase(value: Record<string, unknown>): boolean {
  return value.v === WATCH_PARTY_PROTOCOL_VERSION && value.iss === TOKEN_ISSUER && value.aud === TOKEN_AUDIENCE
    && typeof value.jti === 'string' && UUID_RE.test(value.jti)
    && Number.isSafeInteger(value.iat) && Number.isSafeInteger(value.exp) && (value.iat as number) > 0
    && (value.exp as number) > (value.iat as number)
    && (value.exp as number) - (value.iat as number) <= WATCH_PARTY_LIMITS.resumeTtlSeconds
    && isWatchPartyRoomCode(value.roomCode)
    && (value.roomId === undefined || (typeof value.roomId === 'string' && UUID_RE.test(value.roomId)))
    && isWatchPartyParticipantId(value.participantId)
    && normalizeWatchPartyDisplayName(value.displayName) === value.displayName
    && (value.platform === 'web' || value.platform === 'android');
}

function parseClaims(value: unknown): WatchPartyTokenClaims | null {
  if (!isRecord(value) || !validBase(value)) return null;
  const baseKeys = ['v', 'iss', 'aud', 'jti', 'iat', 'exp', 'roomCode', 'participantId', 'displayName', 'platform', 'kind'];
  if (value.kind === 'resume') {
    if (!hasExactKeys(value, [...baseKeys, 'roomId']) || typeof value.roomId !== 'string') return null;
    return value as unknown as WatchPartyResumeTokenClaims;
  }
  if (value.kind !== 'connect' || !hasExactKeys(value, [...baseKeys, 'action', 'role'], ['roomId', 'media', 'positionSeconds'])) return null;
  if ((value.exp as number) - (value.iat as number) > WATCH_PARTY_LIMITS.ticketTtlSeconds) return null;
  if ((value.action !== 'create' && value.action !== 'join' && value.action !== 'resume')
    || (value.role !== 'host' && value.role !== 'member')) return null;
  const media = value.media === undefined ? undefined : parseWatchPartyMediaIdentity(value.media);
  if ((value.media !== undefined && !media) || (value.positionSeconds !== undefined
    && (typeof value.positionSeconds !== 'number' || !Number.isFinite(value.positionSeconds)
      || value.positionSeconds < 0 || value.positionSeconds > 86_400))) return null;
  if (value.action === 'create' && (value.role !== 'host' || !media || typeof value.roomId !== 'string')) return null;
  if (value.action === 'join' && (value.role !== 'member' || value.roomId !== undefined
    || value.media !== undefined || value.positionSeconds !== undefined)) return null;
  if (value.action === 'resume' && (value.role !== 'member' || typeof value.roomId !== 'string'
    || value.media !== undefined || value.positionSeconds !== undefined)) return null;
  return { ...(value as unknown as WatchPartyConnectTicketClaims), ...(media ? { media } : {}) };
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return bytesToBase64Url(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
}

function secretBytes(secret: string): Uint8Array {
  if (secret.length < 32 || /[\r\n\0]/.test(secret)) {
    throw new Error('WATCH_PARTY_SECRET must contain at least 32 characters and no line breaks.');
  }
  return new TextEncoder().encode(secret);
}

async function hmacKey(secret: string, usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', secretBytes(secret), { name: 'HMAC', hash: 'SHA-256' }, false, usages);
}

export function generateWatchPartyRoomCode(): string {
  const characters: string[] = [];
  const unbiasedLimit = Math.floor(256 / ROOM_CODE_ALPHABET.length) * ROOM_CODE_ALPHABET.length;
  while (characters.length < 10) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    for (const byte of bytes) {
      if (byte >= unbiasedLimit) continue;
      characters.push(ROOM_CODE_ALPHABET[byte % ROOM_CODE_ALPHABET.length]!);
      if (characters.length === 10) break;
    }
  }
  return characters.join('');
}

export function generateWatchPartyId(): string {
  return crypto.randomUUID();
}

export function watchPartyTokenTimes(ttlSeconds: number, nowMs = Date.now()): { iat: number; exp: number } {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > WATCH_PARTY_LIMITS.resumeTtlSeconds) {
    throw new Error('Invalid Watch Party token lifetime.');
  }
  const iat = Math.floor(nowMs / 1000);
  return { iat, exp: iat + ttlSeconds };
}

export function watchPartyTokenBase(input: {
  roomCode: string;
  roomId?: string;
  participantId: string;
  displayName: string;
  platform: WatchPartyPlatform;
  ttlSeconds: number;
  nowMs?: number;
}): Omit<WatchPartyTokenBase, 'kind'> {
  const times = watchPartyTokenTimes(input.ttlSeconds, input.nowMs);
  return {
    v: WATCH_PARTY_PROTOCOL_VERSION,
    iss: TOKEN_ISSUER,
    aud: TOKEN_AUDIENCE,
    jti: generateWatchPartyId(),
    ...times,
    roomCode: input.roomCode,
    ...(input.roomId ? { roomId: input.roomId } : {}),
    participantId: input.participantId,
    displayName: input.displayName,
    platform: input.platform,
  };
}

export async function signWatchPartyToken(claims: WatchPartyTokenClaims, secret: string): Promise<string> {
  if (!parseClaims(claims)) throw new Error('Invalid Watch Party token claims.');
  const payload = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(claims)));
  const key = await hmacKey(secret, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${TOKEN_PREFIX}.${payload}`));
  return `${TOKEN_PREFIX}.${payload}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

export async function verifyWatchPartyToken(token: string, secret: string, options: {
  expectedKind?: WatchPartyTokenClaims['kind'];
  nowMs?: number;
} = {}): Promise<WatchPartyTokenVerification> {
  if (typeof token !== 'string' || token.length > MAX_TOKEN_BYTES) return { ok: false, reason: 'invalid' };
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX || !parts[1] || !parts[2]) return { ok: false, reason: 'invalid' };
  const signature = base64UrlToBytes(parts[2]);
  if (!signature || signature.byteLength !== 32) return { ok: false, reason: 'invalid' };
  let verified = false;
  try {
    const key = await hmacKey(secret, ['verify']);
    verified = await crypto.subtle.verify('HMAC', key, signature,
      new TextEncoder().encode(`${TOKEN_PREFIX}.${parts[1]}`));
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (!verified) return { ok: false, reason: 'invalid' };
  const payload = base64UrlToBytes(parts[1]);
  if (!payload || payload.byteLength > MAX_TOKEN_BYTES) return { ok: false, reason: 'invalid' };
  let claims: WatchPartyTokenClaims | null = null;
  try {
    claims = parseClaims(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload)));
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (!claims || (options.expectedKind && claims.kind !== options.expectedKind)) return { ok: false, reason: 'invalid' };
  const nowSeconds = Math.floor((options.nowMs ?? Date.now()) / 1000);
  if (claims.iat > nowSeconds + 30) return { ok: false, reason: 'not-yet-valid' };
  if (nowSeconds >= claims.exp) return { ok: false, reason: 'expired' };
  return { ok: true, claims };
}

export function watchPartySubprotocols(ticket: string): [typeof WATCH_PARTY_SUBPROTOCOL, string] {
  return [WATCH_PARTY_SUBPROTOCOL, `${WATCH_PARTY_TICKET_SUBPROTOCOL_PREFIX}${ticket}`];
}

export function ticketFromWatchPartySubprotocol(header: string | null): string | null {
  if (!header) return null;
  const values = header.split(',').map((value) => value.trim()).filter(Boolean);
  if (!values.includes(WATCH_PARTY_SUBPROTOCOL)) return null;
  const tickets = values.filter((value) => value.startsWith(WATCH_PARTY_TICKET_SUBPROTOCOL_PREFIX));
  if (tickets.length !== 1) return null;
  const ticket = tickets[0]!.slice(WATCH_PARTY_TICKET_SUBPROTOCOL_PREFIX.length);
  return ticket || null;
}
