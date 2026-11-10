export const WATCH_PARTY_PROTOCOL_VERSION = 1 as const;
export const WATCH_PARTY_SUBPROTOCOL = 'lumora.watch-party.v1' as const;
export const WATCH_PARTY_TICKET_SUBPROTOCOL_PREFIX = 'lumora.ticket.' as const;

export const WATCH_PARTY_LIMITS = Object.freeze({
  maxParticipants: 50,
  maxConnectionsPerParticipant: 3,
  maxMessageBytes: 16 * 1024,
  maxDisplayNameCharacters: 40,
  maxChatCharacters: 500,
  chatHistory: 100,
  replayHistory: 200,
  ticketTtlSeconds: 120,
  resumeTtlSeconds: 30 * 60,
  roomHardTtlMs: 24 * 60 * 60 * 1000,
  emptyRoomTtlMs: 30 * 60 * 1000,
  hostReconnectGraceMs: 30 * 1000,
  participantRetentionMs: 30 * 60 * 1000,
  generalRate: Object.freeze({ limit: 40, windowMs: 10_000 }),
  chatRate: Object.freeze({ limit: 5, windowMs: 10_000 }),
  controlRate: Object.freeze({ limit: 12, windowMs: 5_000 }),
  syncRate: Object.freeze({ limit: 6, windowMs: 10_000 }),
  roomGeneralRate: Object.freeze({ limit: 300, windowMs: 10_000 }),
  roomChatRate: Object.freeze({ limit: 60, windowMs: 10_000 }),
  roomControlRate: Object.freeze({ limit: 60, windowMs: 5_000 }),
});

export const WATCH_PARTY_DRIFT_POLICY = Object.freeze({
  clockSamples: 5,
  noCorrectionSeconds: 0.25,
  correctionExitSeconds: 0.1,
  hardSyncSeconds: 1.5,
  maxRateCorrectionRatio: 0.05,
  rateCorrectionGain: 0.04,
});

export const WATCH_PARTY_ERROR_CODES = Object.freeze([
  'INVALID_REQUEST', 'UNSUPPORTED_VERSION', 'INVALID_TICKET', 'TICKET_EXPIRED',
  'ORIGIN_FORBIDDEN', 'UPGRADE_REQUIRED', 'ROOM_NOT_FOUND', 'ROOM_EXPIRED',
  'ROOM_FULL', 'ROOM_CODE_COLLISION', 'TOO_MANY_CONNECTIONS', 'INVALID_MESSAGE',
  'MESSAGE_TOO_LARGE', 'RATE_LIMITED', 'HOST_REQUIRED', 'STALE_REVISION',
  'PARTICIPANT_NOT_FOUND', 'ROOM_CLOSED', 'INTERNAL_ERROR',
] as const);

export type WatchPartyErrorCode = typeof WATCH_PARTY_ERROR_CODES[number];
export type WatchPartyPlatform = 'web' | 'android';
export type WatchPartyRole = 'host' | 'member';
export type WatchPartyPlaybackMode = 'playing' | 'paused' | 'frozen';
export type WatchPartyClientFreezeReason = 'source-change' | 'ad-break' | 'background';
export type WatchPartyFreezeReason = WatchPartyClientFreezeReason | 'host-disconnected';
export type WatchPartyCorrectionState = 'stable' | 'correcting';

export type WatchPartyMediaIdentity =
  | { kind: 'movie'; mediaId: string }
  | { kind: 'episode'; mediaId: string; episodeId?: string; seasonNumber?: number; episodeNumber?: number };

interface WatchPartyPlaybackBase {
  media: WatchPartyMediaIdentity;
  positionSeconds: number;
  playbackRate: number;
  anchorServerTimeMs: number;
  revision: number;
}

export type WatchPartyPlaybackState = WatchPartyPlaybackBase & (
  | { mode: 'playing' | 'paused'; freezeReason?: never }
  | { mode: 'frozen'; freezeReason: WatchPartyFreezeReason }
);

export interface WatchPartyParticipant {
  participantId: string;
  displayName: string;
  role: WatchPartyRole;
  connected: boolean;
  joinedAtMs: number;
}

export interface WatchPartyChatMessage {
  messageId: string;
  participantId: string;
  displayName: string;
  text: string;
  format: 'plain';
  revision: number;
  serverTimeMs: number;
}

interface ClientMessageBase { v: 1; requestId: string }

export type WatchPartyPlaybackCommand =
  | { kind: 'play' }
  | { kind: 'pause' }
  | { kind: 'freeze'; reason: WatchPartyClientFreezeReason }
  | { kind: 'seek'; positionSeconds: number }
  | { kind: 'rate'; playbackRate: number }
  | { kind: 'media'; media: WatchPartyMediaIdentity; positionSeconds?: number };

export interface WatchPartyPlaybackCommandMessage extends ClientMessageBase {
  type: 'playback.command';
  baseRevision: number;
  command: WatchPartyPlaybackCommand;
}

export interface WatchPartyChatSendMessage extends ClientMessageBase { type: 'chat.send'; text: string }
export interface WatchPartyHostTransferMessage extends ClientMessageBase {
  type: 'host.transfer'; baseRevision: number; participantId: string;
}
export interface WatchPartySyncMessage extends ClientMessageBase { type: 'client.sync'; sinceRevision: number }
export interface WatchPartyPingMessage extends ClientMessageBase { type: 'client.ping'; clientSentAtMs: number }
export interface WatchPartyLeaveMessage extends ClientMessageBase { type: 'room.leave' }
export type WatchPartyClientMessage = WatchPartyPlaybackCommandMessage | WatchPartyChatSendMessage
  | WatchPartyHostTransferMessage | WatchPartySyncMessage | WatchPartyPingMessage | WatchPartyLeaveMessage;

interface ServerMutationBase { v: 1; revision: number; serverTimeMs: number }
export interface WatchPartyPlaybackStateMessage extends ServerMutationBase {
  type: 'playback.state'; playback: WatchPartyPlaybackState;
}
export interface WatchPartyPresenceStateMessage extends ServerMutationBase {
  type: 'presence.state'; hostParticipantId: string; participants: WatchPartyParticipant[];
}
export interface WatchPartyChatMessageEvent extends ServerMutationBase {
  type: 'chat.message'; message: WatchPartyChatMessage;
}
export interface WatchPartyHostChangedMessage extends ServerMutationBase {
  type: 'host.changed'; previousHostParticipantId: string; hostParticipantId: string;
}
export type WatchPartyReplayEvent = WatchPartyPlaybackStateMessage | WatchPartyPresenceStateMessage
  | WatchPartyChatMessageEvent | WatchPartyHostChangedMessage;

export interface WatchPartyRoomSnapshotMessage {
  v: 1;
  type: 'room.snapshot';
  serverTimeMs: number;
  room: { roomCode: string; revision: number; createdAtMs: number; expiresAtMs: number; hostParticipantId: string };
  self: { participantId: string; role: WatchPartyRole; resumeToken: string };
  playback: WatchPartyPlaybackState;
  participants: WatchPartyParticipant[];
  chat: WatchPartyChatMessage[];
}

export interface WatchPartyReplayMessage {
  v: 1; type: 'room.replay'; fromRevision: number; revision: number; serverTimeMs: number;
  events: WatchPartyReplayEvent[];
}
export interface WatchPartyPongMessage {
  v: 1; type: 'server.pong'; requestId: string; clientSentAtMs: number; serverTimeMs: number;
}
export interface WatchPartyAckMessage {
  v: 1; type: 'server.ack'; requestId: string; revision: number; serverTimeMs: number;
}
export interface WatchPartyErrorMessage {
  v: 1; type: 'server.error'; code: WatchPartyErrorCode; message: string; requestId?: string;
  retryAfterMs?: number; revision?: number; serverTimeMs: number;
}
export interface WatchPartyRoomClosedMessage {
  v: 1; type: 'room.closed'; code: 'ROOM_EXPIRED' | 'ROOM_CLOSED'; serverTimeMs: number;
}
export type WatchPartyServerMessage = WatchPartyRoomSnapshotMessage | WatchPartyReplayMessage
  | WatchPartyReplayEvent | WatchPartyPongMessage | WatchPartyAckMessage
  | WatchPartyErrorMessage | WatchPartyRoomClosedMessage;

export type WatchPartyTicketRequest =
  | { v: 1; action: 'create'; platform: WatchPartyPlatform; displayName: string;
    media: WatchPartyMediaIdentity; positionSeconds?: number }
  | { v: 1; action: 'join'; platform: WatchPartyPlatform; displayName: string; roomCode: string }
  | { v: 1; action: 'resume'; platform: WatchPartyPlatform; resumeToken: string };

export interface WatchPartyTicketResponse {
  v: 1;
  ticket: string;
  ticketExpiresAtMs: number;
  roomCode: string;
  participantId: string;
  websocketUrl: string;
  subprotocols: [typeof WATCH_PARTY_SUBPROTOCOL, string];
}

export interface WatchPartyClockSample { roundTripMs: number; offsetMs: number; receivedAtMs: number }
export type WatchPartyDriftAction =
  | { kind: 'none'; projectedPositionSeconds: number; driftSeconds: number; playbackRate: number; correctionState: 'stable' }
  | { kind: 'rate'; projectedPositionSeconds: number; driftSeconds: number; playbackRate: number; correctionState: 'correcting' }
  | { kind: 'hard-sync'; reason: 'drift' | 'media' | 'status'; projectedPositionSeconds: number;
    driftSeconds: number; playbackRate: number; mode: WatchPartyPlaybackMode;
    freezeReason?: WatchPartyFreezeReason; correctionState: 'stable' };

const ROOM_CODE_RE = /^[A-HJ-KM-NP-TV-Z2-9]{10}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Public catalogue identity only, never a database key or a playback capability.
const TMDB_MEDIA_ID_RE = /^tmdb:(movie|tv):[1-9][0-9]{0,9}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function characterLength(value: string): number { return Array.from(value).length; }

function normalizePlainText(value: unknown, maxCharacters: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/</g, '\u2039').replace(/>/g, '\u203a').replace(/\s+/g, ' ').trim();
  return normalized && characterLength(normalized) <= maxCharacters ? normalized : null;
}

export function isWatchPartyRoomCode(value: unknown): value is string {
  return typeof value === 'string' && ROOM_CODE_RE.test(value);
}

export function normalizeWatchPartyRoomCode(value: string): string | null {
  const normalized = value.toUpperCase().replace(/[\s-]+/g, '');
  return isWatchPartyRoomCode(normalized) ? normalized : null;
}

export function isWatchPartyParticipantId(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function normalizeWatchPartyDisplayName(value: unknown): string | null {
  return normalizePlainText(value, WATCH_PARTY_LIMITS.maxDisplayNameCharacters);
}

export function normalizeWatchPartyChat(value: unknown): string | null {
  return normalizePlainText(value, WATCH_PARTY_LIMITS.maxChatCharacters);
}

export function parseWatchPartyMediaIdentity(value: unknown): WatchPartyMediaIdentity | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['kind', 'mediaId', 'episodeId', 'seasonNumber', 'episodeNumber'])
    || (value.kind !== 'movie' && value.kind !== 'episode')
    || typeof value.mediaId !== 'string') return null;
  const tmdbKind = TMDB_MEDIA_ID_RE.exec(value.mediaId)?.[1];
  if (!UUID_RE.test(value.mediaId) && !tmdbKind) return null;
  if (tmdbKind && tmdbKind !== (value.kind === 'movie' ? 'movie' : 'tv')) return null;
  if (value.kind === 'movie') {
    return value.episodeId === undefined && value.seasonNumber === undefined && value.episodeNumber === undefined
      ? { kind: 'movie', mediaId: value.mediaId } : null;
  }
  const episodeId = value.episodeId;
  if (tmdbKind && episodeId !== undefined) return null;
  if (episodeId !== undefined && (typeof episodeId !== 'string' || !UUID_RE.test(episodeId))) return null;
  const hasSeason = value.seasonNumber !== undefined;
  const hasEpisode = value.episodeNumber !== undefined;
  if (hasSeason !== hasEpisode || (hasSeason && (!Number.isSafeInteger(value.seasonNumber)
    || (value.seasonNumber as number) < 0 || (value.seasonNumber as number) > 999
    || !Number.isSafeInteger(value.episodeNumber) || (value.episodeNumber as number) < 1
    || (value.episodeNumber as number) > 9_999)) || (episodeId === undefined && !hasSeason)) return null;
  return { kind: 'episode', mediaId: value.mediaId,
    ...(episodeId === undefined ? {} : { episodeId }),
    ...(hasSeason ? { seasonNumber: value.seasonNumber as number,
      episodeNumber: value.episodeNumber as number } : {}) };
}

export function clockSample(clientSentAtMs: number, clientReceivedAtMs: number,
  serverTimeMs: number): WatchPartyClockSample | null {
  if (![clientSentAtMs, clientReceivedAtMs, serverTimeMs].every(Number.isFinite)
    || clientReceivedAtMs < clientSentAtMs) return null;
  const roundTripMs = clientReceivedAtMs - clientSentAtMs;
  return { roundTripMs, offsetMs: serverTimeMs - (clientSentAtMs + roundTripMs / 2),
    receivedAtMs: clientReceivedAtMs };
}

export function bestClockOffsetMs(samples: readonly WatchPartyClockSample[]): number {
  const valid = samples.filter((sample) => Number.isFinite(sample.roundTripMs) && sample.roundTripMs >= 0
    && Number.isFinite(sample.offsetMs) && Number.isFinite(sample.receivedAtMs))
    .slice(-WATCH_PARTY_DRIFT_POLICY.clockSamples);
  return valid.length
    ? [...valid].sort((a, b) => a.roundTripMs - b.roundTripMs || b.receivedAtMs - a.receivedAtMs)[0]!.offsetMs
    : 0;
}

export function projectWatchPartyPosition(playback: WatchPartyPlaybackState, localNowMs: number,
  samples: readonly WatchPartyClockSample[]): number {
  if (playback.mode !== 'playing') return Math.max(0, playback.positionSeconds);
  const elapsedSeconds = Math.max(0, localNowMs + bestClockOffsetMs(samples) - playback.anchorServerTimeMs) / 1000;
  return Math.max(0, playback.positionSeconds + elapsedSeconds * playback.playbackRate);
}

export function sameWatchPartyMediaIdentity(left: WatchPartyMediaIdentity,
  right: WatchPartyMediaIdentity): boolean {
  if (left.kind !== right.kind || left.mediaId !== right.mediaId) return false;
  if (left.kind === 'movie' || right.kind === 'movie') return true;
  if (left.episodeId !== undefined && right.episodeId !== undefined) return left.episodeId === right.episodeId;
  return left.seasonNumber !== undefined && left.episodeNumber !== undefined
    && right.seasonNumber !== undefined && right.episodeNumber !== undefined
    && left.seasonNumber === right.seasonNumber && left.episodeNumber === right.episodeNumber;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function planWatchPartyDrift(input: {
  playback: WatchPartyPlaybackState;
  localMedia: WatchPartyMediaIdentity;
  localPositionSeconds: number;
  localMode: WatchPartyPlaybackMode;
  localNowMs: number;
  clockSamples: readonly WatchPartyClockSample[];
  correctionState?: WatchPartyCorrectionState;
}): WatchPartyDriftAction {
  const projectedPositionSeconds = projectWatchPartyPosition(input.playback, input.localNowMs, input.clockSamples);
  const driftSeconds = projectedPositionSeconds - input.localPositionSeconds;
  const hardSync = (reason: 'drift' | 'media' | 'status'): WatchPartyDriftAction => ({
    kind: 'hard-sync', reason, projectedPositionSeconds, driftSeconds,
    playbackRate: input.playback.playbackRate, mode: input.playback.mode,
    ...(input.playback.freezeReason ? { freezeReason: input.playback.freezeReason } : {}),
    correctionState: 'stable',
  });
  if (!sameWatchPartyMediaIdentity(input.playback.media, input.localMedia)) return hardSync('media');
  if (input.playback.mode !== input.localMode) return hardSync('status');
  const absoluteDrift = Math.abs(driftSeconds);
  if (absoluteDrift > WATCH_PARTY_DRIFT_POLICY.hardSyncSeconds) return hardSync('drift');
  if (input.playback.mode !== 'playing') {
    if (absoluteDrift > WATCH_PARTY_DRIFT_POLICY.noCorrectionSeconds) return hardSync('drift');
    return { kind: 'none', projectedPositionSeconds, driftSeconds,
      playbackRate: input.playback.playbackRate, correctionState: 'stable' };
  }
  const stable = (input.correctionState ?? 'stable') === 'correcting'
    ? absoluteDrift <= WATCH_PARTY_DRIFT_POLICY.correctionExitSeconds
    : absoluteDrift <= WATCH_PARTY_DRIFT_POLICY.noCorrectionSeconds;
  if (stable) return { kind: 'none', projectedPositionSeconds, driftSeconds,
    playbackRate: input.playback.playbackRate, correctionState: 'stable' };
  const correctionRatio = clamp(driftSeconds * WATCH_PARTY_DRIFT_POLICY.rateCorrectionGain,
    -WATCH_PARTY_DRIFT_POLICY.maxRateCorrectionRatio, WATCH_PARTY_DRIFT_POLICY.maxRateCorrectionRatio);
  return { kind: 'rate', projectedPositionSeconds, driftSeconds,
    playbackRate: clamp(input.playback.playbackRate * (1 + correctionRatio), 0.25, 4),
    correctionState: 'correcting' };
}
