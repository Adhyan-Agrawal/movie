export const WATCH_PARTY_PROTOCOL_VERSION = 1 as const;
export const WATCH_PARTY_SUBPROTOCOL = 'lumora.watch-party.v1' as const;
export const WATCH_PARTY_TICKET_SUBPROTOCOL_PREFIX = 'lumora.ticket.' as const;

export const WATCH_PARTY_LIMITS = Object.freeze({
  maxParticipants: 50,
  maxConnectionsPerParticipant: 3,
  maxMessageBytes: 16 * 1024,
  maxServerMessageBytes: 128 * 1024,
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
  'INVALID_REQUEST',
  'UNSUPPORTED_VERSION',
  'INVALID_TICKET',
  'TICKET_EXPIRED',
  'ORIGIN_FORBIDDEN',
  'UPGRADE_REQUIRED',
  'ROOM_NOT_FOUND',
  'ROOM_EXPIRED',
  'ROOM_FULL',
  'ROOM_CODE_COLLISION',
  'TOO_MANY_CONNECTIONS',
  'INVALID_MESSAGE',
  'MESSAGE_TOO_LARGE',
  'RATE_LIMITED',
  'HOST_REQUIRED',
  'STALE_REVISION',
  'PARTICIPANT_NOT_FOUND',
  'ROOM_CLOSED',
  'INTERNAL_ERROR',
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
  | {
    kind: 'episode';
    mediaId: string;
    episodeId?: string;
    seasonNumber?: number;
    episodeNumber?: number;
  };

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

interface ClientMessageBase {
  v: typeof WATCH_PARTY_PROTOCOL_VERSION;
  requestId: string;
}

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

export interface WatchPartyChatSendMessage extends ClientMessageBase {
  type: 'chat.send';
  text: string;
}

export interface WatchPartyHostTransferMessage extends ClientMessageBase {
  type: 'host.transfer';
  baseRevision: number;
  participantId: string;
}

export interface WatchPartySyncMessage extends ClientMessageBase {
  type: 'client.sync';
  sinceRevision: number;
}

export interface WatchPartyPingMessage extends ClientMessageBase {
  type: 'client.ping';
  clientSentAtMs: number;
}

export interface WatchPartyLeaveMessage extends ClientMessageBase {
  type: 'room.leave';
}

export type WatchPartyClientMessage =
  | WatchPartyPlaybackCommandMessage
  | WatchPartyChatSendMessage
  | WatchPartyHostTransferMessage
  | WatchPartySyncMessage
  | WatchPartyPingMessage
  | WatchPartyLeaveMessage;

interface ServerMutationBase {
  v: typeof WATCH_PARTY_PROTOCOL_VERSION;
  revision: number;
  serverTimeMs: number;
}

export interface WatchPartyPlaybackStateMessage extends ServerMutationBase {
  type: 'playback.state';
  playback: WatchPartyPlaybackState;
}

export interface WatchPartyPresenceStateMessage extends ServerMutationBase {
  type: 'presence.state';
  hostParticipantId: string;
  participants: WatchPartyParticipant[];
}

export interface WatchPartyChatMessageEvent extends ServerMutationBase {
  type: 'chat.message';
  message: WatchPartyChatMessage;
}

export interface WatchPartyHostChangedMessage extends ServerMutationBase {
  type: 'host.changed';
  previousHostParticipantId: string;
  hostParticipantId: string;
}

export type WatchPartyReplayEvent =
  | WatchPartyPlaybackStateMessage
  | WatchPartyPresenceStateMessage
  | WatchPartyChatMessageEvent
  | WatchPartyHostChangedMessage;

export interface WatchPartyRoomSnapshotMessage {
  v: typeof WATCH_PARTY_PROTOCOL_VERSION;
  type: 'room.snapshot';
  serverTimeMs: number;
  room: {
    roomCode: string;
    revision: number;
    createdAtMs: number;
    expiresAtMs: number;
    hostParticipantId: string;
  };
  self: {
    participantId: string;
    role: WatchPartyRole;
    resumeToken: string;
  };
  playback: WatchPartyPlaybackState;
  participants: WatchPartyParticipant[];
  chat: WatchPartyChatMessage[];
}

export interface WatchPartyReplayMessage {
  v: typeof WATCH_PARTY_PROTOCOL_VERSION;
  type: 'room.replay';
  fromRevision: number;
  revision: number;
  serverTimeMs: number;
  events: WatchPartyReplayEvent[];
}

export interface WatchPartyPongMessage {
  v: typeof WATCH_PARTY_PROTOCOL_VERSION;
  type: 'server.pong';
  requestId: string;
  clientSentAtMs: number;
  serverTimeMs: number;
}

export interface WatchPartyAckMessage {
  v: typeof WATCH_PARTY_PROTOCOL_VERSION;
  type: 'server.ack';
  requestId: string;
  revision: number;
  serverTimeMs: number;
}

export interface WatchPartyErrorMessage {
  v: typeof WATCH_PARTY_PROTOCOL_VERSION;
  type: 'server.error';
  code: WatchPartyErrorCode;
  message: string;
  requestId?: string;
  retryAfterMs?: number;
  revision?: number;
  serverTimeMs: number;
}

export interface WatchPartyRoomClosedMessage {
  v: typeof WATCH_PARTY_PROTOCOL_VERSION;
  type: 'room.closed';
  code: 'ROOM_EXPIRED' | 'ROOM_CLOSED';
  serverTimeMs: number;
}

export type WatchPartyServerMessage =
  | WatchPartyRoomSnapshotMessage
  | WatchPartyReplayMessage
  | WatchPartyReplayEvent
  | WatchPartyPongMessage
  | WatchPartyAckMessage
  | WatchPartyErrorMessage
  | WatchPartyRoomClosedMessage;

export type WatchPartyTicketRequest =
  | {
    v: typeof WATCH_PARTY_PROTOCOL_VERSION;
    action: 'create';
    platform: WatchPartyPlatform;
    displayName: string;
    media: WatchPartyMediaIdentity;
    positionSeconds?: number;
  }
  | {
    v: typeof WATCH_PARTY_PROTOCOL_VERSION;
    action: 'join';
    platform: WatchPartyPlatform;
    displayName: string;
    roomCode: string;
  }
  | {
    v: typeof WATCH_PARTY_PROTOCOL_VERSION;
    action: 'resume';
    platform: WatchPartyPlatform;
    resumeToken: string;
  };

export interface WatchPartyTicketResponse {
  v: typeof WATCH_PARTY_PROTOCOL_VERSION;
  ticket: string;
  ticketExpiresAtMs: number;
  roomCode: string;
  participantId: string;
  websocketUrl: string;
  subprotocols: [typeof WATCH_PARTY_SUBPROTOCOL, string];
}

export interface WatchPartyClockSample {
  roundTripMs: number;
  offsetMs: number;
  receivedAtMs: number;
}

export type WatchPartyDriftAction =
  | { kind: 'none'; projectedPositionSeconds: number; driftSeconds: number; playbackRate: number;
    correctionState: 'stable' }
  | { kind: 'rate'; projectedPositionSeconds: number; driftSeconds: number; playbackRate: number;
    correctionState: 'correcting' }
  | {
    kind: 'hard-sync';
    reason: 'drift' | 'media' | 'status';
    projectedPositionSeconds: number;
    driftSeconds: number;
    playbackRate: number;
    mode: WatchPartyPlaybackMode;
    freezeReason?: WatchPartyFreezeReason;
    correctionState: 'stable';
  };

type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: 'INVALID_MESSAGE' | 'UNSUPPORTED_VERSION' };

const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ROOM_CODE_RE = /^[A-HJ-KM-NP-TV-Z2-9]{10}$/;
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Public catalogue identity only, never a database key or a playback capability.
const TMDB_MEDIA_ID_RE = /^tmdb:(movie|tv):[1-9][0-9]{0,9}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPosition(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 86_400;
}

function isPlaybackRate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0.25 && value <= 4;
}

function isSeasonNumber(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 999;
}

function isEpisodeNumber(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 9_999;
}

function characterLength(value: string): number {
  return Array.from(value).length;
}

export function isWatchPartyRoomCode(value: unknown): value is string {
  return typeof value === 'string' && ROOM_CODE_RE.test(value);
}

export function normalizeWatchPartyRoomCode(value: string): string | null {
  const normalized = value.toUpperCase().replace(/[\s-]+/g, '');
  return isWatchPartyRoomCode(normalized) ? normalized : null;
}

export function isWatchPartyParticipantId(value: unknown): value is string {
  return typeof value === 'string' && UUID_V4_RE.test(value);
}

function normalizePlainText(value: unknown, maxCharacters: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/</g, '\u2039')
    .replace(/>/g, '\u203a')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized || characterLength(normalized) > maxCharacters) return null;
  return normalized;
}

export function normalizeWatchPartyDisplayName(value: unknown): string | null {
  return normalizePlainText(value, WATCH_PARTY_LIMITS.maxDisplayNameCharacters);
}

export function normalizeWatchPartyChat(value: unknown): string | null {
  return normalizePlainText(value, WATCH_PARTY_LIMITS.maxChatCharacters);
}

export function parseWatchPartyMediaIdentity(value: unknown): WatchPartyMediaIdentity | null {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['kind', 'mediaId', 'episodeId', 'seasonNumber', 'episodeNumber'])) return null;
  if ((value.kind !== 'movie' && value.kind !== 'episode') || typeof value.mediaId !== 'string') return null;
  const tmdbKind = TMDB_MEDIA_ID_RE.exec(value.mediaId)?.[1];
  if (!UUID_V4_RE.test(value.mediaId) && !tmdbKind) return null;
  if (tmdbKind && tmdbKind !== (value.kind === 'movie' ? 'movie' : 'tv')) return null;
  if (value.kind === 'movie') {
    if (value.episodeId !== undefined || value.seasonNumber !== undefined || value.episodeNumber !== undefined) return null;
    return { kind: 'movie', mediaId: value.mediaId };
  }
  const episodeId = value.episodeId;
  if (tmdbKind && episodeId !== undefined) return null;
  if (episodeId !== undefined && (typeof episodeId !== 'string' || !UUID_V4_RE.test(episodeId))) return null;
  const hasSeasonNumber = value.seasonNumber !== undefined;
  const hasEpisodeNumber = value.episodeNumber !== undefined;
  if (hasSeasonNumber !== hasEpisodeNumber
    || (hasSeasonNumber && (!isSeasonNumber(value.seasonNumber) || !isEpisodeNumber(value.episodeNumber)))
    || (episodeId === undefined && !hasSeasonNumber)) return null;
  return {
    kind: 'episode',
    mediaId: value.mediaId,
    ...(episodeId === undefined ? {} : { episodeId }),
    ...(hasSeasonNumber ? { seasonNumber: value.seasonNumber as number,
      episodeNumber: value.episodeNumber as number } : {}),
  };
}

function parsePlaybackCommand(value: unknown): WatchPartyPlaybackCommand | null {
  if (!isRecord(value) || typeof value.kind !== 'string') return null;
  switch (value.kind) {
    case 'play':
    case 'pause':
      return hasOnlyKeys(value, ['kind']) ? { kind: value.kind } : null;
    case 'freeze':
      return hasOnlyKeys(value, ['kind', 'reason'])
        && (value.reason === 'source-change' || value.reason === 'ad-break' || value.reason === 'background')
        ? { kind: 'freeze', reason: value.reason } : null;
    case 'seek':
      return hasOnlyKeys(value, ['kind', 'positionSeconds']) && isPosition(value.positionSeconds)
        ? { kind: 'seek', positionSeconds: value.positionSeconds } : null;
    case 'rate':
      return hasOnlyKeys(value, ['kind', 'playbackRate']) && isPlaybackRate(value.playbackRate)
        ? { kind: 'rate', playbackRate: value.playbackRate } : null;
    case 'media': {
      if (!hasOnlyKeys(value, ['kind', 'media', 'positionSeconds'])) return null;
      const media = parseWatchPartyMediaIdentity(value.media);
      if (!media || (value.positionSeconds !== undefined && !isPosition(value.positionSeconds))) return null;
      return { kind: 'media', media, ...(value.positionSeconds === undefined ? {} : { positionSeconds: value.positionSeconds }) };
    }
    default:
      return null;
  }
}

export function parseWatchPartyClientMessage(value: unknown): ParseResult<WatchPartyClientMessage> {
  if (!isRecord(value)) return { ok: false, code: 'INVALID_MESSAGE' };
  if (value.v !== WATCH_PARTY_PROTOCOL_VERSION) return { ok: false, code: 'UNSUPPORTED_VERSION' };
  if (typeof value.requestId !== 'string' || !REQUEST_ID_RE.test(value.requestId)) {
    return { ok: false, code: 'INVALID_MESSAGE' };
  }
  switch (value.type) {
    case 'playback.command': {
      const command = parsePlaybackCommand(value.command);
      if (!hasOnlyKeys(value, ['v', 'type', 'requestId', 'baseRevision', 'command'])
        || !isRevision(value.baseRevision) || !command) return { ok: false, code: 'INVALID_MESSAGE' };
      return { ok: true, value: { v: 1, type: 'playback.command', requestId: value.requestId,
        baseRevision: value.baseRevision, command } };
    }
    case 'chat.send':
      if (!hasOnlyKeys(value, ['v', 'type', 'requestId', 'text']) || typeof value.text !== 'string') {
        return { ok: false, code: 'INVALID_MESSAGE' };
      }
      return { ok: true, value: { v: 1, type: 'chat.send', requestId: value.requestId, text: value.text } };
    case 'host.transfer':
      if (!hasOnlyKeys(value, ['v', 'type', 'requestId', 'baseRevision', 'participantId'])
        || !isRevision(value.baseRevision) || !isWatchPartyParticipantId(value.participantId)) {
        return { ok: false, code: 'INVALID_MESSAGE' };
      }
      return { ok: true, value: { v: 1, type: 'host.transfer', requestId: value.requestId,
        baseRevision: value.baseRevision, participantId: value.participantId } };
    case 'client.sync':
      if (!hasOnlyKeys(value, ['v', 'type', 'requestId', 'sinceRevision']) || !isRevision(value.sinceRevision)) {
        return { ok: false, code: 'INVALID_MESSAGE' };
      }
      return { ok: true, value: { v: 1, type: 'client.sync', requestId: value.requestId,
        sinceRevision: value.sinceRevision } };
    case 'client.ping':
      if (!hasOnlyKeys(value, ['v', 'type', 'requestId', 'clientSentAtMs'])
        || typeof value.clientSentAtMs !== 'number' || !Number.isFinite(value.clientSentAtMs)
        || value.clientSentAtMs < 0 || value.clientSentAtMs > Number.MAX_SAFE_INTEGER) {
        return { ok: false, code: 'INVALID_MESSAGE' };
      }
      return { ok: true, value: { v: 1, type: 'client.ping', requestId: value.requestId,
        clientSentAtMs: value.clientSentAtMs } };
    case 'room.leave':
      if (!hasOnlyKeys(value, ['v', 'type', 'requestId'])) return { ok: false, code: 'INVALID_MESSAGE' };
      return { ok: true, value: { v: 1, type: 'room.leave', requestId: value.requestId } };
    default:
      return { ok: false, code: 'INVALID_MESSAGE' };
  }
}

export function clockSample(clientSentAtMs: number, clientReceivedAtMs: number,
  serverTimeMs: number): WatchPartyClockSample | null {
  if (![clientSentAtMs, clientReceivedAtMs, serverTimeMs].every(Number.isFinite)
    || clientReceivedAtMs < clientSentAtMs) return null;
  const roundTripMs = clientReceivedAtMs - clientSentAtMs;
  return {
    roundTripMs,
    offsetMs: serverTimeMs - (clientSentAtMs + roundTripMs / 2),
    receivedAtMs: clientReceivedAtMs,
  };
}

export function bestClockOffsetMs(samples: readonly WatchPartyClockSample[]): number {
  const valid = samples.filter((sample) => Number.isFinite(sample.roundTripMs) && sample.roundTripMs >= 0
    && Number.isFinite(sample.offsetMs) && Number.isFinite(sample.receivedAtMs))
    .slice(-WATCH_PARTY_DRIFT_POLICY.clockSamples);
  if (!valid.length) return 0;
  return [...valid].sort((a, b) => a.roundTripMs - b.roundTripMs || b.receivedAtMs - a.receivedAtMs)[0]!.offsetMs;
}

export function projectWatchPartyPosition(playback: WatchPartyPlaybackState, localNowMs: number,
  samples: readonly WatchPartyClockSample[]): number {
  if (playback.mode !== 'playing') return Math.max(0, playback.positionSeconds);
  const estimatedServerNowMs = localNowMs + bestClockOffsetMs(samples);
  const elapsedSeconds = Math.max(0, estimatedServerNowMs - playback.anchorServerTimeMs) / 1000;
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
  const correctionState = input.correctionState ?? 'stable';
  const stable = correctionState === 'correcting'
    ? absoluteDrift <= WATCH_PARTY_DRIFT_POLICY.correctionExitSeconds
    : absoluteDrift <= WATCH_PARTY_DRIFT_POLICY.noCorrectionSeconds;
  if (stable) {
    return { kind: 'none', projectedPositionSeconds, driftSeconds,
      playbackRate: input.playback.playbackRate, correctionState: 'stable' };
  }
  const correctionRatio = clamp(driftSeconds * WATCH_PARTY_DRIFT_POLICY.rateCorrectionGain,
    -WATCH_PARTY_DRIFT_POLICY.maxRateCorrectionRatio, WATCH_PARTY_DRIFT_POLICY.maxRateCorrectionRatio);
  return { kind: 'rate', projectedPositionSeconds, driftSeconds,
    playbackRate: clamp(input.playback.playbackRate * (1 + correctionRatio), 0.25, 4),
    correctionState: 'correcting' };
}
