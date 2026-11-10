import {
  WATCH_PARTY_ERROR_CODES,
  WATCH_PARTY_LIMITS,
  WATCH_PARTY_PROTOCOL_VERSION,
  WATCH_PARTY_SUBPROTOCOL,
  WATCH_PARTY_TICKET_SUBPROTOCOL_PREFIX,
  isWatchPartyParticipantId,
  isWatchPartyRoomCode,
  normalizeWatchPartyChat,
  normalizeWatchPartyDisplayName,
  parseWatchPartyMediaIdentity,
  type WatchPartyChatMessage,
  type WatchPartyErrorCode,
  type WatchPartyParticipant,
  type WatchPartyPlaybackState,
  type WatchPartyReplayEvent,
  type WatchPartyServerMessage,
  type WatchPartyTicketResponse,
} from '../protocol';

export type WatchPartyDecodeResult<T> = { ok: true; value: T } | { ok: false };

const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const RESUME_TOKEN_RE = /^wp1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

function isSafeInteger(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}

function isPosition(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 86_400;
}

function isRate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0.25 && value <= 4;
}

function parseParticipant(value: unknown): WatchPartyParticipant | null {
  if (!isRecord(value) || !exactKeys(value,
    ['participantId', 'displayName', 'role', 'connected', 'joinedAtMs'])) return null;
  if (!isWatchPartyParticipantId(value.participantId)
    || typeof value.displayName !== 'string'
    || normalizeWatchPartyDisplayName(value.displayName) !== value.displayName
    || (value.role !== 'host' && value.role !== 'member')
    || typeof value.connected !== 'boolean'
    || !isSafeInteger(value.joinedAtMs)) return null;
  return {
    participantId: value.participantId,
    displayName: value.displayName,
    role: value.role,
    connected: value.connected,
    joinedAtMs: value.joinedAtMs,
  };
}

function parsePlayback(value: unknown): WatchPartyPlaybackState | null {
  if (!isRecord(value) || !exactKeys(value,
    ['media', 'mode', 'positionSeconds', 'playbackRate', 'anchorServerTimeMs', 'revision'], ['freezeReason'])) return null;
  const media = parseWatchPartyMediaIdentity(value.media);
  if (!media || (value.mode !== 'playing' && value.mode !== 'paused' && value.mode !== 'frozen')
    || !isPosition(value.positionSeconds)
    || !isRate(value.playbackRate) || !isSafeInteger(value.anchorServerTimeMs)
    || !isSafeInteger(value.revision)) return null;
  const base = {
    media,
    positionSeconds: value.positionSeconds,
    playbackRate: value.playbackRate,
    anchorServerTimeMs: value.anchorServerTimeMs,
    revision: value.revision,
  };
  if (value.mode === 'frozen') {
    if (value.freezeReason !== 'source-change' && value.freezeReason !== 'ad-break'
      && value.freezeReason !== 'background' && value.freezeReason !== 'host-disconnected') return null;
    return { ...base, mode: 'frozen', freezeReason: value.freezeReason };
  }
  if (value.freezeReason !== undefined) return null;
  return { ...base, mode: value.mode };
}

function parseChat(value: unknown): WatchPartyChatMessage | null {
  if (!isRecord(value) || !exactKeys(value,
    ['messageId', 'participantId', 'displayName', 'text', 'format', 'revision', 'serverTimeMs'])) return null;
  if (!isWatchPartyParticipantId(value.messageId) || !isWatchPartyParticipantId(value.participantId)
    || typeof value.displayName !== 'string' || normalizeWatchPartyDisplayName(value.displayName) !== value.displayName
    || typeof value.text !== 'string' || normalizeWatchPartyChat(value.text) !== value.text
    || value.format !== 'plain' || !isSafeInteger(value.revision) || !isSafeInteger(value.serverTimeMs)) return null;
  return {
    messageId: value.messageId,
    participantId: value.participantId,
    displayName: value.displayName,
    text: value.text,
    format: 'plain',
    revision: value.revision,
    serverTimeMs: value.serverTimeMs,
  };
}

function mutationBase(value: Record<string, unknown>, keys: readonly string[]): {
  revision: number;
  serverTimeMs: number;
} | null {
  if (!exactKeys(value, ['v', 'type', 'revision', 'serverTimeMs', ...keys])
    || value.v !== WATCH_PARTY_PROTOCOL_VERSION
    || !isSafeInteger(value.revision) || !isSafeInteger(value.serverTimeMs)) return null;
  return { revision: value.revision, serverTimeMs: value.serverTimeMs };
}

function parseReplayEvent(value: unknown): WatchPartyReplayEvent | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null;
  if (value.type === 'playback.state') {
    const base = mutationBase(value, ['playback']);
    const playback = parsePlayback(value.playback);
    if (!base || !playback || playback.revision !== base.revision) return null;
    return { v: 1, type: 'playback.state', ...base, playback };
  }
  if (value.type === 'presence.state') {
    const base = mutationBase(value, ['hostParticipantId', 'participants']);
    if (!base || !isWatchPartyParticipantId(value.hostParticipantId) || !Array.isArray(value.participants)
      || value.participants.length > WATCH_PARTY_LIMITS.maxParticipants) return null;
    const participants = value.participants.map(parseParticipant);
    if (participants.some((participant) => participant === null)) return null;
    const parsed = participants as WatchPartyParticipant[];
    if (new Set(parsed.map((participant) => participant.participantId)).size !== parsed.length
      || !parsed.some((participant) => participant.participantId === value.hostParticipantId && participant.role === 'host')
      || parsed.some((participant) => participant.role === 'host' && participant.participantId !== value.hostParticipantId)) return null;
    return { v: 1, type: 'presence.state', ...base,
      hostParticipantId: value.hostParticipantId, participants: parsed };
  }
  if (value.type === 'chat.message') {
    const base = mutationBase(value, ['message']);
    const message = parseChat(value.message);
    if (!base || !message || message.revision !== base.revision || message.serverTimeMs !== base.serverTimeMs) return null;
    return { v: 1, type: 'chat.message', ...base, message };
  }
  if (value.type === 'host.changed') {
    const base = mutationBase(value, ['previousHostParticipantId', 'hostParticipantId']);
    if (!base || !isWatchPartyParticipantId(value.previousHostParticipantId)
      || !isWatchPartyParticipantId(value.hostParticipantId)
      || value.previousHostParticipantId === value.hostParticipantId) return null;
    return { v: 1, type: 'host.changed', ...base,
      previousHostParticipantId: value.previousHostParticipantId, hostParticipantId: value.hostParticipantId };
  }
  return null;
}

function decodeSnapshot(value: Record<string, unknown>): WatchPartyServerMessage | null {
  if (!exactKeys(value, ['v', 'type', 'serverTimeMs', 'room', 'self', 'playback', 'participants', 'chat'])
    || !isSafeInteger(value.serverTimeMs) || !isRecord(value.room) || !isRecord(value.self)
    || !Array.isArray(value.participants) || !Array.isArray(value.chat)
    || value.participants.length > WATCH_PARTY_LIMITS.maxParticipants
    || value.chat.length > WATCH_PARTY_LIMITS.chatHistory) return null;
  const room = value.room;
  const selfValue = value.self;
  if (!exactKeys(room, ['roomCode', 'revision', 'createdAtMs', 'expiresAtMs', 'hostParticipantId'])
    || !isWatchPartyRoomCode(room.roomCode) || !isSafeInteger(room.revision)
    || !isSafeInteger(room.createdAtMs) || !isSafeInteger(room.expiresAtMs)
    || room.expiresAtMs <= room.createdAtMs || !isWatchPartyParticipantId(room.hostParticipantId)) return null;
  if (!exactKeys(selfValue, ['participantId', 'role', 'resumeToken'])
    || !isWatchPartyParticipantId(selfValue.participantId)
    || (selfValue.role !== 'host' && selfValue.role !== 'member')
    || typeof selfValue.resumeToken !== 'string' || selfValue.resumeToken.length > 4096
    || !RESUME_TOKEN_RE.test(selfValue.resumeToken)) return null;
  const roomRevision = room.revision;
  const playback = parsePlayback(value.playback);
  const participants = value.participants.map(parseParticipant);
  const chat = value.chat.map(parseChat);
  if (!playback || playback.revision > roomRevision
    || participants.some((participant) => participant === null) || chat.some((message) => message === null)) return null;
  const parsedParticipants = participants as WatchPartyParticipant[];
  const parsedChat = chat as WatchPartyChatMessage[];
  const self = parsedParticipants.find((participant) => participant.participantId === selfValue.participantId);
  if (!self || self.role !== selfValue.role
    || !parsedParticipants.some((participant) => participant.participantId === room.hostParticipantId
      && participant.role === 'host')
    || parsedParticipants.some((participant) => participant.role === 'host' && participant.participantId !== room.hostParticipantId)
    || new Set(parsedParticipants.map((participant) => participant.participantId)).size !== parsedParticipants.length
    || parsedChat.some((message, index) => message.revision > roomRevision
      || (index > 0 && message.revision <= parsedChat[index - 1]!.revision))) return null;
  return {
    v: 1,
    type: 'room.snapshot',
    serverTimeMs: value.serverTimeMs,
    room: {
      roomCode: room.roomCode,
      revision: room.revision,
      createdAtMs: room.createdAtMs,
      expiresAtMs: room.expiresAtMs,
      hostParticipantId: room.hostParticipantId,
    },
    self: {
      participantId: selfValue.participantId,
      role: selfValue.role,
      resumeToken: selfValue.resumeToken,
    },
    playback,
    participants: parsedParticipants,
    chat: parsedChat,
  };
}

function decodeReplay(value: Record<string, unknown>): WatchPartyServerMessage | null {
  if (!exactKeys(value, ['v', 'type', 'fromRevision', 'revision', 'serverTimeMs', 'events'])
    || !isSafeInteger(value.fromRevision) || !isSafeInteger(value.revision)
    || value.revision < value.fromRevision || !isSafeInteger(value.serverTimeMs)
    || !Array.isArray(value.events) || value.events.length > WATCH_PARTY_LIMITS.replayHistory) return null;
  const fromRevision = value.fromRevision as number;
  const revision = value.revision as number;
  const events = value.events.map(parseReplayEvent);
  if (events.some((event) => event === null)) return null;
  const parsed = events as WatchPartyReplayEvent[];
  if ((parsed.length === 0 && revision !== fromRevision)
    || parsed.some((event, index) => event.revision !== fromRevision + index + 1)
    || (parsed.length > 0 && parsed[parsed.length - 1]!.revision !== revision)) return null;
  return { v: 1, type: 'room.replay', fromRevision, revision,
    serverTimeMs: value.serverTimeMs, events: parsed };
}

export function decodeWatchPartyServerMessage(value: unknown): WatchPartyDecodeResult<WatchPartyServerMessage> {
  if (!isRecord(value) || value.v !== WATCH_PARTY_PROTOCOL_VERSION || typeof value.type !== 'string') return { ok: false };
  const event = parseReplayEvent(value);
  if (event) return { ok: true, value: event };
  if (value.type === 'room.snapshot') {
    const snapshot = decodeSnapshot(value);
    return snapshot ? { ok: true, value: snapshot } : { ok: false };
  }
  if (value.type === 'room.replay') {
    const replay = decodeReplay(value);
    return replay ? { ok: true, value: replay } : { ok: false };
  }
  if (value.type === 'server.pong') {
    if (!exactKeys(value, ['v', 'type', 'requestId', 'clientSentAtMs', 'serverTimeMs'])
      || typeof value.requestId !== 'string' || !REQUEST_ID_RE.test(value.requestId)
      || !isSafeInteger(value.clientSentAtMs) || !isSafeInteger(value.serverTimeMs)) return { ok: false };
    return { ok: true, value: { v: 1, type: 'server.pong', requestId: value.requestId,
      clientSentAtMs: value.clientSentAtMs, serverTimeMs: value.serverTimeMs } };
  }
  if (value.type === 'server.ack') {
    if (!exactKeys(value, ['v', 'type', 'requestId', 'revision', 'serverTimeMs'])
      || typeof value.requestId !== 'string' || !REQUEST_ID_RE.test(value.requestId)
      || !isSafeInteger(value.revision) || !isSafeInteger(value.serverTimeMs)) return { ok: false };
    return { ok: true, value: { v: 1, type: 'server.ack', requestId: value.requestId,
      revision: value.revision, serverTimeMs: value.serverTimeMs } };
  }
  if (value.type === 'server.error') {
    if (!exactKeys(value, ['v', 'type', 'code', 'message', 'serverTimeMs'],
      ['requestId', 'retryAfterMs', 'revision'])
      || typeof value.code !== 'string' || !WATCH_PARTY_ERROR_CODES.includes(value.code as WatchPartyErrorCode)
      || typeof value.message !== 'string' || value.message.length > 1_000 || !isSafeInteger(value.serverTimeMs)
      || (value.requestId !== undefined && (typeof value.requestId !== 'string' || !REQUEST_ID_RE.test(value.requestId)))
      || (value.retryAfterMs !== undefined && (!isSafeInteger(value.retryAfterMs, 1) || value.retryAfterMs > 60_000))
      || (value.revision !== undefined && !isSafeInteger(value.revision))) return { ok: false };
    return { ok: true, value: { v: 1, type: 'server.error', code: value.code as WatchPartyErrorCode,
      message: value.message, serverTimeMs: value.serverTimeMs,
      ...(value.requestId === undefined ? {} : { requestId: value.requestId }),
      ...(value.retryAfterMs === undefined ? {} : { retryAfterMs: value.retryAfterMs }),
      ...(value.revision === undefined ? {} : { revision: value.revision }) } };
  }
  if (value.type === 'room.closed') {
    if (!exactKeys(value, ['v', 'type', 'code', 'serverTimeMs'])
      || (value.code !== 'ROOM_EXPIRED' && value.code !== 'ROOM_CLOSED')
      || !isSafeInteger(value.serverTimeMs)) return { ok: false };
    return { ok: true, value: { v: 1, type: 'room.closed', code: value.code,
      serverTimeMs: value.serverTimeMs } };
  }
  return { ok: false };
}

function validWebSocketUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2_048 || /[\r\n\0]/.test(value)) return false;
  try {
    const url = new URL(value);
    const local = url.protocol === 'ws:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]');
    return (url.protocol === 'wss:' || local) && !url.username && !url.password && !url.hash
      && !url.search && url.pathname === '/v1/ws';
  } catch {
    return false;
  }
}

export function decodeWatchPartyTicket(value: unknown, nowMs = Date.now()): WatchPartyDecodeResult<WatchPartyTicketResponse> {
  if (!isRecord(value) || !exactKeys(value,
    ['v', 'ticket', 'ticketExpiresAtMs', 'roomCode', 'participantId', 'websocketUrl', 'subprotocols'])
    || value.v !== 1 || typeof value.ticket !== 'string' || value.ticket.length > 4096
    || !RESUME_TOKEN_RE.test(value.ticket) || !isSafeInteger(value.ticketExpiresAtMs)
    || value.ticketExpiresAtMs <= nowMs || value.ticketExpiresAtMs > nowMs + WATCH_PARTY_LIMITS.ticketTtlSeconds * 1_000 + 5_000
    || !isWatchPartyRoomCode(value.roomCode) || !isWatchPartyParticipantId(value.participantId)
    || !validWebSocketUrl(value.websocketUrl) || !Array.isArray(value.subprotocols)
    || value.subprotocols.length !== 2 || value.subprotocols[0] !== WATCH_PARTY_SUBPROTOCOL
    || value.subprotocols[1] !== `${WATCH_PARTY_TICKET_SUBPROTOCOL_PREFIX}${value.ticket}`) return { ok: false };
  return { ok: true, value: {
    v: 1,
    ticket: value.ticket,
    ticketExpiresAtMs: value.ticketExpiresAtMs,
    roomCode: value.roomCode,
    participantId: value.participantId,
    websocketUrl: value.websocketUrl,
    subprotocols: [WATCH_PARTY_SUBPROTOCOL, value.subprotocols[1]],
  } };
}

export function decodeWatchPartyApiError(value: unknown): WatchPartyErrorCode | null {
  if (!isRecord(value) || value.v !== 1 || !isRecord(value.error)
    || typeof value.error.code !== 'string'
    || !WATCH_PARTY_ERROR_CODES.includes(value.error.code as WatchPartyErrorCode)) return null;
  return value.error.code as WatchPartyErrorCode;
}
