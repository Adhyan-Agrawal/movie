import { DurableObject } from 'cloudflare:workers';
import {
  WATCH_PARTY_LIMITS,
  WATCH_PARTY_PROTOCOL_VERSION,
  WATCH_PARTY_SUBPROTOCOL,
  normalizeWatchPartyChat,
  parseWatchPartyClientMessage,
  sameWatchPartyMediaIdentity,
  type WatchPartyAckMessage,
  type WatchPartyChatMessage,
  type WatchPartyChatMessageEvent,
  type WatchPartyClientMessage,
  type WatchPartyErrorCode,
  type WatchPartyErrorMessage,
  type WatchPartyFreezeReason,
  type WatchPartyHostChangedMessage,
  type WatchPartyMediaIdentity,
  type WatchPartyParticipant,
  type WatchPartyPlaybackState,
  type WatchPartyPlaybackStateMessage,
  type WatchPartyPresenceStateMessage,
  type WatchPartyReplayEvent,
  type WatchPartyReplayMessage,
  type WatchPartyRoomClosedMessage,
  type WatchPartyRoomSnapshotMessage,
} from '../../../src/features/watch-party/protocol';
import {
  generateWatchPartyId,
  signWatchPartyToken,
  ticketFromWatchPartySubprotocol,
  verifyWatchPartyToken,
  watchPartyTokenBase,
  type WatchPartyConnectTicketClaims,
} from '../../../src/features/watch-party/tickets';

interface RoomRow {
  roomId: string;
  roomCode: string;
  createdAtMs: number;
  hardExpiresAtMs: number;
  expiresAtMs: number;
  lastActivityAtMs: number;
  hostParticipantId: string;
  hostDisconnectDeadlineMs: number | null;
  revision: number;
  lastServerTimeMs: number;
  playback: WatchPartyPlaybackState;
}

interface StoredRoomRow extends Record<string, SqlStorageValue> {
  room_id: string;
  room_code: string;
  created_at_ms: number;
  hard_expires_at_ms: number;
  expires_at_ms: number;
  last_activity_at_ms: number;
  host_participant_id: string;
  host_disconnect_deadline_ms: number | null;
  revision: number;
  last_server_time_ms: number;
  playback_json: string;
}

interface StoredParticipantRow extends Record<string, SqlStorageValue> {
  participant_id: string;
  display_name: string;
  joined_at_ms: number;
  last_seen_at_ms: number;
}

interface StoredChatRow extends Record<string, SqlStorageValue> {
  message_id: string;
  participant_id: string;
  display_name: string;
  text: string;
  revision: number;
  server_time_ms: number;
}

interface StoredEventRow extends Record<string, SqlStorageValue> {
  revision: number;
  payload_json: string;
}

interface StoredRequestRow extends Record<string, SqlStorageValue> {
  revision: number;
}

interface StoredRateRow extends Record<string, SqlStorageValue> {
  window_start_ms: number;
  message_count: number;
}

interface SocketAttachment {
  v: 1;
  participantId: string;
  displayName: string;
  platform: 'web' | 'android';
  connectedAtMs: number;
  resumeIssuedAtMs?: number;
  departed: boolean;
  general: number[];
  chat: number[];
  control: number[];
  sync: number[];
}

interface PlaybackDraft {
  media: WatchPartyMediaIdentity;
  mode: 'playing' | 'paused' | 'frozen';
  freezeReason?: WatchPartyFreezeReason;
  positionSeconds: number;
  playbackRate: number;
  anchorServerTimeMs: number;
  revision: number;
}

type RateBucket = 'general' | 'chat' | 'control' | 'sync';

const CLOSE_ROOM = 4000;
const CLOSE_POLICY = 4003;
const CLOSE_TOO_LARGE = 4009;

function errorMessage(code: WatchPartyErrorCode, message: string, serverTimeMs: number,
  options: { requestId?: string; retryAfterMs?: number; revision?: number } = {}): WatchPartyErrorMessage {
  return { v: WATCH_PARTY_PROTOCOL_VERSION, type: 'server.error', code, message, serverTimeMs, ...options };
}

function attachmentOf(socket: WebSocket): SocketAttachment | null {
  const value = socket.deserializeAttachment();
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const attachment = value as Partial<SocketAttachment>;
  if (attachment.v !== 1 || typeof attachment.participantId !== 'string'
    || typeof attachment.displayName !== 'string' || (attachment.platform !== 'web' && attachment.platform !== 'android')
    || typeof attachment.connectedAtMs !== 'number' || typeof attachment.departed !== 'boolean'
    || !Array.isArray(attachment.general)
    || !Array.isArray(attachment.chat) || !Array.isArray(attachment.control) || !Array.isArray(attachment.sync)) return null;
  return attachment as SocketAttachment;
}

function send(socket: WebSocket, message: object): void {
  try {
    socket.send(JSON.stringify(message));
  } catch {
    // The close/error callback will reconcile presence if the connection is gone.
  }
}

function playbackDraft(playback: WatchPartyPlaybackState): PlaybackDraft {
  return { ...playback, media: { ...playback.media } };
}

function playbackState(draft: PlaybackDraft): WatchPartyPlaybackState {
  const base = {
    media: draft.media,
    positionSeconds: draft.positionSeconds,
    playbackRate: draft.playbackRate,
    anchorServerTimeMs: draft.anchorServerTimeMs,
    revision: draft.revision,
  };
  if (draft.mode === 'frozen') {
    if (!draft.freezeReason) throw new Error('Frozen playback requires a reason.');
    return { ...base, mode: 'frozen', freezeReason: draft.freezeReason };
  }
  return { ...base, mode: draft.mode };
}

function publicMessageFor(code: WatchPartyErrorCode): string {
  const messages: Partial<Record<WatchPartyErrorCode, string>> = {
    INVALID_MESSAGE: 'The message does not match Watch Party protocol v1.',
    UNSUPPORTED_VERSION: 'This protocol version is not supported.',
    MESSAGE_TOO_LARGE: 'The message is too large.',
    RATE_LIMITED: 'Too many messages were sent.',
    HOST_REQUIRED: 'Only the current host can perform this action.',
    STALE_REVISION: 'The command was based on stale room state.',
    PARTICIPANT_NOT_FOUND: 'The participant is not available.',
    ROOM_EXPIRED: 'The room has expired.',
    ROOM_CLOSED: 'The room is closed.',
  };
  return messages[code] ?? 'The request could not be completed.';
}

export class WatchPartyRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.initializeSchema();
    });
  }

  private initializeSchema(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS room (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        room_id TEXT NOT NULL,
        room_code TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        hard_expires_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        last_activity_at_ms INTEGER NOT NULL,
        host_participant_id TEXT NOT NULL,
        host_disconnect_deadline_ms INTEGER,
        revision INTEGER NOT NULL,
        last_server_time_ms INTEGER NOT NULL,
        playback_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS participants (
        participant_id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        joined_at_ms INTEGER NOT NULL,
        last_seen_at_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chat (
        message_id TEXT PRIMARY KEY,
        participant_id TEXT NOT NULL,
        client_message_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        text TEXT NOT NULL,
        revision INTEGER NOT NULL UNIQUE,
        server_time_ms INTEGER NOT NULL,
        UNIQUE (participant_id, client_message_id)
      );
      CREATE TABLE IF NOT EXISTS events (
        revision INTEGER PRIMARY KEY,
        server_time_ms INTEGER NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS requests (
        participant_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        PRIMARY KEY (participant_id, request_id)
      );
      CREATE TABLE IF NOT EXISTS rate_limits (
        bucket TEXT PRIMARY KEY,
        window_start_ms INTEGER NOT NULL,
        message_count INTEGER NOT NULL
      );
    `);
  }

  private readRoom(): RoomRow | null {
    const row = this.ctx.storage.sql.exec<StoredRoomRow>('SELECT * FROM room WHERE singleton = 1').toArray()[0];
    if (!row) return null;
    return {
      roomId: row.room_id,
      roomCode: row.room_code,
      createdAtMs: row.created_at_ms,
      hardExpiresAtMs: row.hard_expires_at_ms,
      expiresAtMs: row.expires_at_ms,
      lastActivityAtMs: row.last_activity_at_ms,
      hostParticipantId: row.host_participant_id,
      hostDisconnectDeadlineMs: row.host_disconnect_deadline_ms,
      revision: row.revision,
      lastServerTimeMs: row.last_server_time_ms,
      playback: JSON.parse(row.playback_json) as WatchPartyPlaybackState,
    };
  }

  private writeRoom(room: RoomRow): void {
    this.ctx.storage.sql.exec(`UPDATE room SET
      room_id = ?, room_code = ?, created_at_ms = ?, hard_expires_at_ms = ?, expires_at_ms = ?,
      last_activity_at_ms = ?, host_participant_id = ?, host_disconnect_deadline_ms = ?, revision = ?,
      last_server_time_ms = ?, playback_json = ? WHERE singleton = 1`,
    room.roomId, room.roomCode, room.createdAtMs, room.hardExpiresAtMs, room.expiresAtMs,
    room.lastActivityAtMs, room.hostParticipantId, room.hostDisconnectDeadlineMs, room.revision,
    room.lastServerTimeMs, JSON.stringify(room.playback));
  }

  private createRoom(claims: WatchPartyConnectTicketClaims, now: number): RoomRow {
    if (claims.action !== 'create' || !claims.roomId || !claims.media || claims.role !== 'host') {
      throw new Error('Invalid create ticket.');
    }
    const playback: WatchPartyPlaybackState = {
      media: claims.media,
      mode: 'paused',
      positionSeconds: claims.positionSeconds ?? 0,
      playbackRate: 1,
      anchorServerTimeMs: now,
      revision: 0,
    };
    const room: RoomRow = {
      roomId: claims.roomId,
      roomCode: claims.roomCode,
      createdAtMs: now,
      hardExpiresAtMs: now + WATCH_PARTY_LIMITS.roomHardTtlMs,
      expiresAtMs: now + WATCH_PARTY_LIMITS.roomHardTtlMs,
      lastActivityAtMs: now,
      hostParticipantId: claims.participantId,
      hostDisconnectDeadlineMs: null,
      revision: 0,
      lastServerTimeMs: now,
      playback,
    };
    this.ctx.storage.sql.exec(`INSERT INTO room (
      singleton, room_id, room_code, created_at_ms, hard_expires_at_ms, expires_at_ms,
      last_activity_at_ms, host_participant_id, host_disconnect_deadline_ms, revision,
      last_server_time_ms, playback_json) VALUES (1, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?)`,
    room.roomId, room.roomCode, room.createdAtMs, room.hardExpiresAtMs, room.expiresAtMs,
    room.lastActivityAtMs, room.hostParticipantId, room.lastServerTimeMs, JSON.stringify(room.playback));
    return room;
  }

  private reserveServerTime(room: RoomRow, now = Date.now()): number {
    room.lastServerTimeMs = Math.max(now, room.lastServerTimeMs + 1);
    this.ctx.storage.sql.exec('UPDATE room SET last_server_time_ms = ? WHERE singleton = 1', room.lastServerTimeMs);
    return room.lastServerTimeMs;
  }

  private allSockets(excluding?: WebSocket): WebSocket[] {
    return this.ctx.getWebSockets().filter((socket) => socket !== excluding && socket.readyState === 1
      && attachmentOf(socket)?.departed === false);
  }

  private participantSockets(participantId: string, excluding?: WebSocket): WebSocket[] {
    return this.allSockets(excluding).filter((socket) => attachmentOf(socket)?.participantId === participantId);
  }

  private connectedParticipantIds(excluding?: WebSocket): Set<string> {
    const ids = new Set<string>();
    for (const socket of this.allSockets(excluding)) {
      const attachment = attachmentOf(socket);
      if (attachment) ids.add(attachment.participantId);
    }
    return ids;
  }

  private participants(room: RoomRow, excluding?: WebSocket): WatchPartyParticipant[] {
    const connected = this.connectedParticipantIds(excluding);
    return this.ctx.storage.sql.exec<StoredParticipantRow>(
      'SELECT participant_id, display_name, joined_at_ms, last_seen_at_ms FROM participants ORDER BY joined_at_ms, participant_id',
    ).toArray().map((participant) => ({
      participantId: participant.participant_id,
      displayName: participant.display_name,
      role: participant.participant_id === room.hostParticipantId ? 'host' : 'member',
      connected: connected.has(participant.participant_id),
      joinedAtMs: participant.joined_at_ms,
    }));
  }

  private chatHistory(): WatchPartyChatMessage[] {
    return this.ctx.storage.sql.exec<StoredChatRow>(`SELECT message_id, participant_id, display_name, text,
      revision, server_time_ms FROM chat ORDER BY revision DESC LIMIT ?`, WATCH_PARTY_LIMITS.chatHistory)
      .toArray().reverse().map((message) => ({
        messageId: message.message_id,
        participantId: message.participant_id,
        displayName: message.display_name,
        text: message.text,
        format: 'plain',
        revision: message.revision,
        serverTimeMs: message.server_time_ms,
      }));
  }

  private commitEvent(room: RoomRow, event: WatchPartyReplayEvent,
    request?: { participantId: string; requestId: string }): void {
    this.ctx.storage.transactionSync(() => {
      this.writeRoom(room);
      this.ctx.storage.sql.exec('INSERT INTO events (revision, server_time_ms, payload_json) VALUES (?, ?, ?)',
        event.revision, event.serverTimeMs, JSON.stringify(event));
      if (request) this.ctx.storage.sql.exec(
        'INSERT INTO requests (participant_id, request_id, revision) VALUES (?, ?, ?)',
        request.participantId, request.requestId, event.revision);
      this.ctx.storage.sql.exec(`DELETE FROM events WHERE revision NOT IN
        (SELECT revision FROM events ORDER BY revision DESC LIMIT ?)`, WATCH_PARTY_LIMITS.replayHistory);
      this.pruneRequests();
    });
  }

  private pruneRequests(now = Date.now()): void {
    // Ticket admission markers outlive leave/room deletion until the ticket expires.
    // ':' cannot appear in a client requestId, so clients cannot collide with this namespace.
    this.ctx.storage.sql.exec("DELETE FROM requests WHERE request_id LIKE 'ticket:%' AND revision <= ?", now);
    this.ctx.storage.sql.exec(`DELETE FROM requests WHERE request_id NOT LIKE 'ticket:%' AND rowid NOT IN
      (SELECT rowid FROM requests WHERE request_id NOT LIKE 'ticket:%' ORDER BY rowid DESC LIMIT ?)`,
    WATCH_PARTY_LIMITS.replayHistory * 2);
  }

  private nextMutation(room: RoomRow, now = Date.now()): { revision: number; serverTimeMs: number } {
    room.revision += 1;
    room.lastServerTimeMs = Math.max(now, room.lastServerTimeMs + 1);
    room.lastActivityAtMs = now;
    room.expiresAtMs = room.hardExpiresAtMs;
    return { revision: room.revision, serverTimeMs: room.lastServerTimeMs };
  }

  private broadcast(message: object, excluding?: WebSocket): void {
    for (const socket of this.allSockets(excluding)) send(socket, message);
  }

  private presenceEvent(room: RoomRow, now = Date.now(), excluding?: WebSocket): WatchPartyPresenceStateMessage {
    const mutation = this.nextMutation(room, now);
    return { v: 1, type: 'presence.state', ...mutation,
      hostParticipantId: room.hostParticipantId, participants: this.participants(room, excluding) };
  }

  private requestRevision(participantId: string, requestId: string): number | null {
    return this.ctx.storage.sql.exec<StoredRequestRow>(
      'SELECT revision FROM requests WHERE participant_id = ? AND request_id = ?', participantId, requestId,
    ).toArray()[0]?.revision ?? null;
  }

  private async sendSnapshot(socket: WebSocket, room: RoomRow, participantId: string): Promise<void> {
    const participant = this.ctx.storage.sql.exec<StoredParticipantRow>(
      'SELECT participant_id, display_name, joined_at_ms, last_seen_at_ms FROM participants WHERE participant_id = ?',
      participantId,
    ).toArray()[0];
    if (!participant) return;
    const now = Date.now();
    const remainingSeconds = Math.max(1, Math.min(WATCH_PARTY_LIMITS.resumeTtlSeconds,
      Math.floor((room.hardExpiresAtMs - now) / 1000)));
    const resumeToken = await signWatchPartyToken({
      ...watchPartyTokenBase({ roomCode: room.roomCode, roomId: room.roomId, participantId,
        displayName: participant.display_name, platform: attachmentOf(socket)?.platform ?? 'web',
        ttlSeconds: remainingSeconds, nowMs: now }),
      kind: 'resume',
      roomId: room.roomId,
    }, this.env.WATCH_PARTY_SECRET);
    const currentRoom = this.readRoom();
    if (!currentRoom || currentRoom.roomId !== room.roomId || Date.now() >= currentRoom.expiresAtMs) return;
    const currentParticipant = this.ctx.storage.sql.exec<StoredParticipantRow>(
      'SELECT participant_id, display_name, joined_at_ms, last_seen_at_ms FROM participants WHERE participant_id = ?',
      participantId,
    ).toArray()[0];
    const attachment = attachmentOf(socket);
    if (!currentParticipant || !attachment || attachment.departed || socket.readyState !== 1) return;
    attachment.resumeIssuedAtMs = now;
    socket.serializeAttachment(attachment);
    room = currentRoom;
    const serverTimeMs = this.reserveServerTime(room, now);
    const snapshot: WatchPartyRoomSnapshotMessage = {
      v: 1,
      type: 'room.snapshot',
      serverTimeMs,
      room: {
        roomCode: room.roomCode,
        revision: room.revision,
        createdAtMs: room.createdAtMs,
        expiresAtMs: room.expiresAtMs,
        hostParticipantId: room.hostParticipantId,
      },
      self: {
        participantId,
        role: participantId === room.hostParticipantId ? 'host' : 'member',
        resumeToken,
      },
      playback: room.playback,
      participants: this.participants(room),
      chat: this.chatHistory(),
    };
    const encoder = new TextEncoder();
    let bytes = encoder.encode(JSON.stringify(snapshot)).byteLength;
    while (bytes > WATCH_PARTY_LIMITS.maxServerMessageBytes && snapshot.chat.length) {
      const removed = snapshot.chat.shift()!;
      bytes -= encoder.encode(JSON.stringify(removed)).byteLength + (snapshot.chat.length ? 1 : 0);
    }
    send(socket, snapshot);
  }

  private async scheduleAlarm(room: RoomRow | null): Promise<void> {
    const now = Date.now();
    const times = room ? [room.expiresAtMs] : [];
    if (room?.hostDisconnectDeadlineMs !== null && room?.hostDisconnectDeadlineMs !== undefined
      && room.hostDisconnectDeadlineMs > now) times.push(room.hostDisconnectDeadlineMs);
    const ticketExpiry = this.ctx.storage.sql.exec<{ expiry: number | null }>(
      "SELECT MIN(revision) AS expiry FROM requests WHERE request_id LIKE 'ticket:%'",
    ).one().expiry;
    if (ticketExpiry !== null) times.push(ticketExpiry);
    if (times.length) await this.ctx.storage.setAlarm(Math.max(now + 1, Math.min(...times)));
    else await this.ctx.storage.deleteAlarm();
  }

  private pruneParticipants(room: RoomRow, now: number): void {
    const connected = this.connectedParticipantIds();
    const cutoff = now - WATCH_PARTY_LIMITS.participantRetentionMs;
    const stale = this.ctx.storage.sql.exec<StoredParticipantRow>(
      'SELECT participant_id, display_name, joined_at_ms, last_seen_at_ms FROM participants WHERE last_seen_at_ms < ?', cutoff,
    ).toArray();
    for (const participant of stale) {
      if (participant.participant_id !== room.hostParticipantId && !connected.has(participant.participant_id)) {
        this.ctx.storage.sql.exec('DELETE FROM participants WHERE participant_id = ?', participant.participant_id);
      }
    }
  }

  private oldestConnectedMember(room: RoomRow, excluding?: string): string | null {
    const connected = this.connectedParticipantIds();
    return this.ctx.storage.sql.exec<StoredParticipantRow>(
      'SELECT participant_id, display_name, joined_at_ms, last_seen_at_ms FROM participants ORDER BY joined_at_ms, participant_id',
    ).toArray().find((participant) => connected.has(participant.participant_id)
      && participant.participant_id !== room.hostParticipantId && participant.participant_id !== excluding)?.participant_id ?? null;
  }

  private transferHost(room: RoomRow, nextHostParticipantId: string, now: number,
    request?: { participantId: string; requestId: string }, excluding?: WebSocket): WatchPartyHostChangedMessage {
    const previousHostParticipantId = room.hostParticipantId;
    room.hostParticipantId = nextHostParticipantId;
    room.hostDisconnectDeadlineMs = null;
    const mutation = this.nextMutation(room, now);
    const event: WatchPartyHostChangedMessage = {
      v: 1, type: 'host.changed', ...mutation, previousHostParticipantId,
      hostParticipantId: nextHostParticipantId,
    };
    this.commitEvent(room, event, request);
    this.broadcast(event, excluding);
    return event;
  }

  private consumeRate(socket: WebSocket, bucket: RateBucket, now: number): number | null {
    const attachment = attachmentOf(socket);
    if (!attachment) return 1_000;
    const limit = bucket === 'general' ? WATCH_PARTY_LIMITS.generalRate
      : bucket === 'chat' ? WATCH_PARTY_LIMITS.chatRate
        : bucket === 'control' ? WATCH_PARTY_LIMITS.controlRate : WATCH_PARTY_LIMITS.syncRate;
    attachment[bucket] = attachment[bucket].filter((timestamp) => timestamp > now - limit.windowMs);
    if (attachment[bucket].length >= limit.limit) {
      const retryAfterMs = Math.max(1, attachment[bucket][0]! + limit.windowMs - now);
      socket.serializeAttachment(attachment);
      return retryAfterMs;
    }
    attachment[bucket].push(now);
    socket.serializeAttachment(attachment);
    return null;
  }

  private consumeRoomRate(bucket: 'general' | 'chat' | 'control', now: number): number | null {
    const limit = bucket === 'general' ? WATCH_PARTY_LIMITS.roomGeneralRate
      : bucket === 'chat' ? WATCH_PARTY_LIMITS.roomChatRate : WATCH_PARTY_LIMITS.roomControlRate;
    const row = this.ctx.storage.sql.exec<StoredRateRow>(
      'SELECT window_start_ms, message_count FROM rate_limits WHERE bucket = ?', bucket,
    ).toArray()[0];
    if (!row || now - row.window_start_ms >= limit.windowMs) {
      this.ctx.storage.sql.exec(`INSERT INTO rate_limits (bucket, window_start_ms, message_count)
        VALUES (?, ?, 1) ON CONFLICT (bucket) DO UPDATE SET window_start_ms = excluded.window_start_ms,
        message_count = 1`, bucket, now);
      return null;
    }
    if (row.message_count >= limit.limit) return Math.max(1, row.window_start_ms + limit.windowMs - now);
    this.ctx.storage.sql.exec('UPDATE rate_limits SET message_count = message_count + 1 WHERE bucket = ?', bucket);
    return null;
  }

  private sendError(socket: WebSocket, room: RoomRow | null, code: WatchPartyErrorCode,
    options: { requestId?: string; retryAfterMs?: number } = {}): void {
    const serverTimeMs = room ? this.reserveServerTime(room) : Date.now();
    send(socket, errorMessage(code, publicMessageFor(code), serverTimeMs,
      { ...options, ...(room ? { revision: room.revision } : {}) }));
  }

  private sendAck(socket: WebSocket, room: RoomRow, requestId: string, revision = room.revision): void {
    const ack: WatchPartyAckMessage = { v: 1, type: 'server.ack', requestId, revision,
      serverTimeMs: this.reserveServerTime(room) };
    send(socket, ack);
  }

  private projectPosition(playback: PlaybackDraft | WatchPartyPlaybackState, serverTimeMs: number): number {
    if (playback.mode !== 'playing') return playback.positionSeconds;
    return Math.min(86_400, Math.max(0, playback.positionSeconds
      + Math.max(0, serverTimeMs - playback.anchorServerTimeMs) / 1000 * playback.playbackRate));
  }

  private freezePlayback(room: RoomRow, reason: WatchPartyFreezeReason, now: number,
    excluding?: WebSocket): WatchPartyPlaybackStateMessage {
    const playback = playbackDraft(room.playback);
    const serverTimeMs = Math.max(now, room.lastServerTimeMs + 1);
    playback.positionSeconds = this.projectPosition(playback, serverTimeMs);
    playback.mode = 'frozen';
    playback.freezeReason = reason;
    const mutation = this.nextMutation(room, now);
    playback.revision = mutation.revision;
    playback.anchorServerTimeMs = mutation.serverTimeMs;
    room.playback = playbackState(playback);
    const event: WatchPartyPlaybackStateMessage = {
      v: 1,
      type: 'playback.state',
      ...mutation,
      playback: room.playback,
    };
    this.commitEvent(room, event);
    this.broadcast(event, excluding);
    return event;
  }

  private handlePlayback(socket: WebSocket, room: RoomRow, attachment: SocketAttachment,
    message: Extract<WatchPartyClientMessage, { type: 'playback.command' }>): void {
    if (attachment.participantId !== room.hostParticipantId) {
      this.sendError(socket, room, 'HOST_REQUIRED', { requestId: message.requestId });
      return;
    }
    const duplicateRevision = this.requestRevision(attachment.participantId, message.requestId);
    if (duplicateRevision !== null) {
      this.sendAck(socket, room, message.requestId, duplicateRevision);
      return;
    }
    if (message.baseRevision !== room.playback.revision) {
      this.sendError(socket, room, 'STALE_REVISION', { requestId: message.requestId });
      return;
    }
    const now = Date.now();
    const serverTimeMs = Math.max(now, room.lastServerTimeMs + 1);
    const playback = playbackDraft(room.playback);
    const materialized = this.projectPosition(playback, serverTimeMs);
    let changed = true;
    switch (message.command.kind) {
      case 'play':
        if (playback.mode === 'playing') changed = false;
        else {
          playback.mode = 'playing';
          playback.freezeReason = undefined;
          playback.positionSeconds = materialized;
        }
        break;
      case 'pause':
        if (playback.mode === 'paused') changed = false;
        else {
          playback.mode = 'paused';
          playback.freezeReason = undefined;
          playback.positionSeconds = materialized;
        }
        break;
      case 'freeze':
        if (playback.mode === 'frozen' && playback.freezeReason === message.command.reason) changed = false;
        else {
          playback.mode = 'frozen';
          playback.freezeReason = message.command.reason;
          playback.positionSeconds = materialized;
        }
        break;
      case 'seek':
        playback.positionSeconds = message.command.positionSeconds;
        break;
      case 'rate':
        if (playback.playbackRate === message.command.playbackRate) changed = false;
        else { playback.positionSeconds = materialized; playback.playbackRate = message.command.playbackRate; }
        break;
      case 'media':
        if (sameWatchPartyMediaIdentity(playback.media, message.command.media)
          && playback.positionSeconds === (message.command.positionSeconds ?? 0)
          && playback.mode === 'frozen' && playback.freezeReason === 'source-change') changed = false;
        else {
          playback.media = message.command.media;
          playback.positionSeconds = message.command.positionSeconds ?? 0;
          playback.mode = 'frozen';
          playback.freezeReason = 'source-change';
        }
        break;
    }
    if (!changed) {
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec('INSERT INTO requests (participant_id, request_id, revision) VALUES (?, ?, ?)',
          attachment.participantId, message.requestId, room.playback.revision);
        this.pruneRequests();
      });
      this.sendAck(socket, room, message.requestId, room.playback.revision);
      return;
    }
    playback.anchorServerTimeMs = serverTimeMs;
    const mutation = this.nextMutation(room, now);
    playback.revision = mutation.revision;
    playback.anchorServerTimeMs = mutation.serverTimeMs;
    room.playback = playbackState(playback);
    const event: WatchPartyPlaybackStateMessage = { v: 1, type: 'playback.state', ...mutation,
      playback: room.playback };
    this.commitEvent(room, event, { participantId: attachment.participantId, requestId: message.requestId });
    this.broadcast(event);
    this.sendAck(socket, room, message.requestId, event.revision);
  }

  private handleChat(socket: WebSocket, room: RoomRow, attachment: SocketAttachment,
    message: Extract<WatchPartyClientMessage, { type: 'chat.send' }>): void {
    const duplicateRevision = this.requestRevision(attachment.participantId, message.requestId);
    if (duplicateRevision !== null) {
      this.sendAck(socket, room, message.requestId, duplicateRevision);
      return;
    }
    const text = normalizeWatchPartyChat(message.text);
    if (!text) {
      this.sendError(socket, room, 'INVALID_MESSAGE', { requestId: message.requestId });
      return;
    }
    const mutation = this.nextMutation(room);
    const chat: WatchPartyChatMessage = {
      messageId: generateWatchPartyId(),
      participantId: attachment.participantId,
      displayName: attachment.displayName,
      text,
      format: 'plain',
      ...mutation,
    };
    const event: WatchPartyChatMessageEvent = { v: 1, type: 'chat.message', ...mutation, message: chat };
    this.ctx.storage.transactionSync(() => {
      this.writeRoom(room);
      this.ctx.storage.sql.exec(`INSERT INTO chat (message_id, participant_id, client_message_id,
        display_name, text, revision, server_time_ms) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      chat.messageId, chat.participantId, message.requestId, chat.displayName, chat.text,
      chat.revision, chat.serverTimeMs);
      this.ctx.storage.sql.exec('INSERT INTO events (revision, server_time_ms, payload_json) VALUES (?, ?, ?)',
        event.revision, event.serverTimeMs, JSON.stringify(event));
      this.ctx.storage.sql.exec('INSERT INTO requests (participant_id, request_id, revision) VALUES (?, ?, ?)',
        attachment.participantId, message.requestId, event.revision);
      this.ctx.storage.sql.exec(`DELETE FROM chat WHERE revision NOT IN
        (SELECT revision FROM chat ORDER BY revision DESC LIMIT ?)`, WATCH_PARTY_LIMITS.chatHistory);
      this.ctx.storage.sql.exec(`DELETE FROM events WHERE revision NOT IN
        (SELECT revision FROM events ORDER BY revision DESC LIMIT ?)`, WATCH_PARTY_LIMITS.replayHistory);
      this.pruneRequests();
    });
    this.broadcast(event);
    this.sendAck(socket, room, message.requestId, event.revision);
  }

  private handleTransfer(socket: WebSocket, room: RoomRow, attachment: SocketAttachment,
    message: Extract<WatchPartyClientMessage, { type: 'host.transfer' }>): void {
    if (attachment.participantId !== room.hostParticipantId) {
      this.sendError(socket, room, 'HOST_REQUIRED', { requestId: message.requestId });
      return;
    }
    const duplicateRevision = this.requestRevision(attachment.participantId, message.requestId);
    if (duplicateRevision !== null) {
      this.sendAck(socket, room, message.requestId, duplicateRevision);
      return;
    }
    if (message.baseRevision !== room.revision) {
      this.sendError(socket, room, 'STALE_REVISION', { requestId: message.requestId });
      return;
    }
    const participant = this.ctx.storage.sql.exec<StoredParticipantRow>(
      'SELECT participant_id, display_name, joined_at_ms, last_seen_at_ms FROM participants WHERE participant_id = ?',
      message.participantId,
    ).toArray()[0];
    if (!participant || !this.connectedParticipantIds().has(message.participantId)
      || message.participantId === room.hostParticipantId) {
      this.sendError(socket, room, 'PARTICIPANT_NOT_FOUND', { requestId: message.requestId });
      return;
    }
    this.transferHost(room, message.participantId, Date.now(),
      { participantId: attachment.participantId, requestId: message.requestId });
    const presence = this.presenceEvent(room);
    this.commitEvent(room, presence);
    this.broadcast(presence);
    this.sendAck(socket, room, message.requestId, room.revision);
  }

  private async handleSync(socket: WebSocket, room: RoomRow,
    message: Extract<WatchPartyClientMessage, { type: 'client.sync' }>): Promise<void> {
    if (message.sinceRevision > room.revision) {
      this.sendError(socket, room, 'STALE_REVISION', { requestId: message.requestId });
      return;
    }
    const rows = this.ctx.storage.sql.exec<StoredEventRow>(
      'SELECT revision, payload_json FROM events WHERE revision > ? ORDER BY revision LIMIT ?',
      message.sinceRevision, WATCH_PARTY_LIMITS.replayHistory + 1,
    ).toArray();
    // A full presence replay can be larger than a snapshot; never exceed clients' frame bound.
    const replayBytes = rows.reduce((bytes, row) => bytes + new TextEncoder().encode(row.payload_json).byteLength + 1, 256);
    if ((message.sinceRevision < room.revision && rows[0]?.revision !== message.sinceRevision + 1)
      || rows.length > WATCH_PARTY_LIMITS.replayHistory || replayBytes > WATCH_PARTY_LIMITS.maxServerMessageBytes) {
      const attachment = attachmentOf(socket);
      if (attachment) await this.sendSnapshot(socket, room, attachment.participantId);
      const current = this.readRoom();
      if (current && current.roomId === room.roomId && !attachmentOf(socket)?.departed) {
        this.sendAck(socket, current, message.requestId);
      }
      return;
    }
    const replay: WatchPartyReplayMessage = {
      v: 1,
      type: 'room.replay',
      fromRevision: message.sinceRevision,
      revision: room.revision,
      serverTimeMs: this.reserveServerTime(room),
      events: rows.map((row) => JSON.parse(row.payload_json) as WatchPartyReplayEvent),
    };
    send(socket, replay);
    this.sendAck(socket, room, message.requestId);
  }

  private async gracefulLeave(socket: WebSocket, room: RoomRow, attachment: SocketAttachment,
    requestId: string): Promise<void> {
    const participantId = attachment.participantId;
    const otherConnected = this.oldestConnectedMember(room, participantId);
    if (participantId === room.hostParticipantId && !otherConnected) {
      this.sendAck(socket, room, requestId);
      await this.closeAndClearRoom(room, 'ROOM_CLOSED');
      return;
    }
    const departingSockets = this.participantSockets(participantId);
    for (const participantSocket of departingSockets) {
      const participantAttachment = attachmentOf(participantSocket);
      if (participantAttachment) {
        participantAttachment.departed = true;
        participantSocket.serializeAttachment(participantAttachment);
      }
    }
    if (participantId === room.hostParticipantId && otherConnected) {
      this.freezePlayback(room, 'host-disconnected', Date.now(), socket);
      this.transferHost(room, otherConnected, Date.now());
    }
    this.ctx.storage.sql.exec('DELETE FROM participants WHERE participant_id = ?', participantId);
    const presence = this.presenceEvent(room, Date.now(), socket);
    if (this.allSockets().length === 0) {
      room.expiresAtMs = Math.min(room.hardExpiresAtMs, Date.now() + WATCH_PARTY_LIMITS.emptyRoomTtlMs);
    }
    this.commitEvent(room, presence);
    this.broadcast(presence, socket);
    this.sendAck(socket, room, requestId);
    for (const participantSocket of departingSockets) {
      try { participantSocket.close(1000, 'Left room'); } catch { /* Connection already closed. */ }
    }
    const currentRoom = this.readRoom();
    if (currentRoom) await this.scheduleAlarm(currentRoom);
  }

  private async processMessage(socket: WebSocket, message: WatchPartyClientMessage): Promise<void> {
    const attachment = attachmentOf(socket);
    let room = this.readRoom();
    if (!attachment || attachment.departed || !room) {
      this.sendError(socket, room, 'ROOM_CLOSED', { requestId: message.requestId });
      socket.close(CLOSE_ROOM, 'Room closed');
      return;
    }
    const participant = this.ctx.storage.sql.exec<StoredParticipantRow>(
      'SELECT participant_id, display_name, joined_at_ms, last_seen_at_ms FROM participants WHERE participant_id = ?',
      attachment.participantId,
    ).toArray()[0];
    if (!participant || participant.display_name !== attachment.displayName) {
      attachment.departed = true;
      socket.serializeAttachment(attachment);
      this.sendError(socket, null, 'PARTICIPANT_NOT_FOUND', { requestId: message.requestId });
      socket.close(CLOSE_POLICY, 'Participant unavailable');
      return;
    }
    if (Date.now() >= room.expiresAtMs) {
      await this.closeAndClearRoom(room, 'ROOM_EXPIRED');
      return;
    }
    const category = message.type === 'chat.send' ? 'chat'
      : message.type === 'playback.command' || message.type === 'host.transfer' ? 'control'
        : message.type === 'client.sync' ? 'sync' : null;
    if (category) {
      const now = Date.now();
      const retryAfterMs = this.consumeRate(socket, category, now);
      if (retryAfterMs !== null) {
        this.sendError(socket, room, 'RATE_LIMITED', { requestId: message.requestId, retryAfterMs });
        return;
      }
      if (category === 'chat' || category === 'control') {
        const roomRetryAfterMs = this.consumeRoomRate(category, now);
        if (roomRetryAfterMs !== null) {
          this.sendError(socket, room, 'RATE_LIMITED', { requestId: message.requestId, retryAfterMs: roomRetryAfterMs });
          return;
        }
      }
    }
    switch (message.type) {
      case 'playback.command':
        this.handlePlayback(socket, room, attachment, message);
        break;
      case 'chat.send':
        this.handleChat(socket, room, attachment, message);
        break;
      case 'host.transfer':
        this.handleTransfer(socket, room, attachment, message);
        break;
      case 'client.sync':
        await this.handleSync(socket, room, message);
        break;
      case 'client.ping':
        send(socket, { v: 1, type: 'server.pong', requestId: message.requestId,
          clientSentAtMs: message.clientSentAtMs, serverTimeMs: this.reserveServerTime(room) });
        if (Date.now() - (attachment.resumeIssuedAtMs ?? attachment.connectedAtMs)
          >= WATCH_PARTY_LIMITS.resumeTtlSeconds * 500) {
          await this.sendSnapshot(socket, room, attachment.participantId);
        }
        break;
      case 'room.leave':
        await this.gracefulLeave(socket, room, attachment, message.requestId);
        return;
    }
    room = this.readRoom();
    if (room) await this.scheduleAlarm(room);
  }

  private httpError(code: WatchPartyErrorCode, message: string, status: number): Response {
    return Response.json({ v: 1, error: { code, message } }, {
      status,
      headers: { 'Cache-Control': 'private, no-store, max-age=0', 'X-Content-Type-Options': 'nosniff' },
    });
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return this.httpError('UPGRADE_REQUIRED', 'A WebSocket upgrade is required.', 426);
    }
    const ticket = ticketFromWatchPartySubprotocol(request.headers.get('Sec-WebSocket-Protocol'));
    if (!ticket) return this.httpError('INVALID_TICKET', 'A valid connection ticket is required.', 401);
    const verified = await verifyWatchPartyToken(ticket, this.env.WATCH_PARTY_SECRET, { expectedKind: 'connect' });
    if (!verified.ok) {
      return this.httpError(verified.reason === 'expired' ? 'TICKET_EXPIRED' : 'INVALID_TICKET',
        verified.reason === 'expired' ? 'The connection ticket has expired.' : 'The connection ticket is invalid.', 401);
    }
    if (verified.claims.kind !== 'connect') {
      return this.httpError('INVALID_TICKET', 'The connection ticket is invalid.', 401);
    }
    const claims = verified.claims;
    const now = Date.now();
    this.pruneRequests(now);
    const admittedTicket = this.requestRevision(claims.participantId, `ticket:${claims.jti}`);
    let room = this.readRoom();
    if (room && now >= room.expiresAtMs) {
      await this.closeAndClearRoom(room, 'ROOM_EXPIRED');
      room = this.readRoom();
    }
    if (!room) {
      if (claims.action !== 'create') return this.httpError('ROOM_NOT_FOUND', 'The room was not found.', 404);
      if (admittedTicket !== null) return this.httpError('ROOM_CLOSED', 'The room is closed.', 403);
      room = this.createRoom(claims, now);
    } else {
      if (claims.roomCode !== room.roomCode) return this.httpError('INVALID_TICKET', 'The connection ticket is invalid.', 401);
      if (claims.action === 'create' && claims.roomId !== room.roomId) {
        return this.httpError('ROOM_CODE_COLLISION', 'Generate a new room code and retry.', 409);
      }
      if (claims.action === 'resume' && claims.roomId !== room.roomId) {
        return this.httpError('INVALID_TICKET', 'The connection ticket is invalid.', 401);
      }
    }
    this.pruneParticipants(room, now);
    const existing = this.ctx.storage.sql.exec<StoredParticipantRow>(
      'SELECT participant_id, display_name, joined_at_ms, last_seen_at_ms FROM participants WHERE participant_id = ?',
      claims.participantId,
    ).toArray()[0];
    if (!existing && (claims.action === 'resume' || admittedTicket !== null)) {
      return this.httpError('PARTICIPANT_NOT_FOUND', 'The participant can no longer resume.', 403);
    }
    const existingSockets = this.participantSockets(claims.participantId);
    if (existingSockets.length >= WATCH_PARTY_LIMITS.maxConnectionsPerParticipant) {
      return this.httpError('TOO_MANY_CONNECTIONS', 'Too many connections are open for this participant.', 409);
    }
    const retryAfterMs = this.consumeRoomRate('general', now);
    if (retryAfterMs !== null) return this.httpError('RATE_LIMITED', 'Too many connections were requested.', 429);
    if (!existing) {
      const count = this.ctx.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM participants').one().count;
      if (count >= WATCH_PARTY_LIMITS.maxParticipants) return this.httpError('ROOM_FULL', 'The room is full.', 409);
      this.ctx.storage.sql.exec(`INSERT INTO participants
        (participant_id, display_name, joined_at_ms, last_seen_at_ms) VALUES (?, ?, ?, ?)`,
      claims.participantId, claims.displayName, now, now);
    } else {
      if (existing.display_name !== claims.displayName) return this.httpError('INVALID_TICKET', 'The connection ticket is invalid.', 401);
      this.ctx.storage.sql.exec('UPDATE participants SET last_seen_at_ms = ? WHERE participant_id = ?', now, claims.participantId);
    }
    if (claims.action !== 'resume') {
      this.ctx.storage.sql.exec('INSERT OR IGNORE INTO requests (participant_id, request_id, revision) VALUES (?, ?, ?)',
        claims.participantId, `ticket:${claims.jti}`, claims.exp * 1_000);
    }
    const wasConnected = existingSockets.length > 0;
    if (claims.participantId === room.hostParticipantId) room.hostDisconnectDeadlineMs = null;
    room.expiresAtMs = room.hardExpiresAtMs;
    room.lastActivityAtMs = now;
    this.writeRoom(room);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    const attachment: SocketAttachment = {
      v: 1,
      participantId: claims.participantId,
      displayName: claims.displayName,
      platform: claims.platform,
      connectedAtMs: now,
      departed: false,
      general: [],
      chat: [],
      control: [],
      sync: [],
    };
    server.serializeAttachment(attachment);

    if (room.hostDisconnectDeadlineMs !== null && room.hostDisconnectDeadlineMs <= now
      && room.hostParticipantId !== claims.participantId
      && this.participantSockets(room.hostParticipantId).length === 0) {
      this.transferHost(room, claims.participantId, now, undefined, server);
    }
    if (!wasConnected) {
      const presence = this.presenceEvent(room, now);
      this.commitEvent(room, presence);
      this.broadcast(presence, server);
      await this.sendSnapshot(server, room, claims.participantId);
    } else {
      await this.sendSnapshot(server, room, claims.participantId);
    }
    const roomForAlarm = this.readRoom();
    if (roomForAlarm) await this.scheduleAlarm(roomForAlarm);
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { 'Sec-WebSocket-Protocol': WATCH_PARTY_SUBPROTOCOL },
    });
  }

  override async webSocketMessage(socket: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const room = this.readRoom();
    const attachment = attachmentOf(socket);
    if (!attachment) {
      socket.close(CLOSE_POLICY, 'Invalid connection state');
      return;
    }
    if (attachment.departed) {
      socket.close(CLOSE_POLICY, 'Connection left room');
      return;
    }
    const bytes = typeof raw === 'string' ? new TextEncoder().encode(raw).byteLength : raw.byteLength;
    if (bytes > WATCH_PARTY_LIMITS.maxMessageBytes) {
      this.sendError(socket, room, 'MESSAGE_TOO_LARGE');
      socket.close(CLOSE_TOO_LARGE, 'Message too large');
      return;
    }
    const retryAfterMs = this.consumeRate(socket, 'general', Date.now());
    if (retryAfterMs !== null) {
      this.sendError(socket, room, 'RATE_LIMITED', { retryAfterMs });
      return;
    }
    const roomRetryAfterMs = room ? this.consumeRoomRate('general', Date.now()) : null;
    if (roomRetryAfterMs !== null) {
      this.sendError(socket, room, 'RATE_LIMITED', { retryAfterMs: roomRetryAfterMs });
      return;
    }
    if (typeof raw !== 'string') {
      this.sendError(socket, room, 'INVALID_MESSAGE');
      return;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { this.sendError(socket, room, 'INVALID_MESSAGE'); return; }
    const result = parseWatchPartyClientMessage(parsed);
    if (!result.ok) {
      this.sendError(socket, room, result.code);
      return;
    }
    await this.processMessage(socket, result.value);
  }

  private async reconcileClose(socket: WebSocket): Promise<void> {
    const attachment = attachmentOf(socket);
    const room = this.readRoom();
    if (!attachment || attachment.departed || !room) return;
    attachment.departed = true;
    try { socket.serializeAttachment(attachment); } catch { /* The connection is already gone. */ }
    if (this.participantSockets(attachment.participantId, socket).length > 0) return;
    const now = Date.now();
    this.ctx.storage.sql.exec('UPDATE participants SET last_seen_at_ms = ? WHERE participant_id = ?',
      now, attachment.participantId);
    if (attachment.participantId === room.hostParticipantId) {
      room.hostDisconnectDeadlineMs = now + WATCH_PARTY_LIMITS.hostReconnectGraceMs;
      this.freezePlayback(room, 'host-disconnected', now, socket);
    }
    const presence = this.presenceEvent(room, now, socket);
    if (this.allSockets(socket).length === 0) {
      room.expiresAtMs = Math.min(room.hardExpiresAtMs, now + WATCH_PARTY_LIMITS.emptyRoomTtlMs);
    }
    this.commitEvent(room, presence);
    this.broadcast(presence, socket);
    await this.scheduleAlarm(room);
  }

  override async webSocketClose(socket: WebSocket): Promise<void> {
    await this.reconcileClose(socket);
  }

  override async webSocketError(socket: WebSocket): Promise<void> {
    await this.reconcileClose(socket);
    try { socket.close(1011, 'Connection error'); } catch { /* Already closed. */ }
  }

  private async closeAndClearRoom(room: RoomRow, code: 'ROOM_EXPIRED' | 'ROOM_CLOSED'): Promise<void> {
    const closed: WatchPartyRoomClosedMessage = { v: 1, type: 'room.closed', code,
      serverTimeMs: Math.max(Date.now(), room.lastServerTimeMs + 1) };
    this.broadcast(closed);
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = attachmentOf(socket);
      if (attachment) {
        attachment.departed = true;
        try { socket.serializeAttachment(attachment); } catch { /* Closed. */ }
      }
      try { socket.close(CLOSE_ROOM, code === 'ROOM_EXPIRED' ? 'Room expired' : 'Room closed'); } catch { /* Closed. */ }
    }
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(`DELETE FROM requests WHERE request_id NOT LIKE 'ticket:%'; DELETE FROM events;
        DELETE FROM chat; DELETE FROM participants; DELETE FROM room;`);
      this.pruneRequests();
    });
    await this.scheduleAlarm(null);
  }

  override async alarm(): Promise<void> {
    this.pruneRequests();
    const room = this.readRoom();
    if (!room) {
      const remaining = this.ctx.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM requests').one().count;
      if (remaining === 0) this.ctx.storage.sql.exec('DELETE FROM rate_limits');
      await this.scheduleAlarm(null);
      return;
    }
    const now = Date.now();
    if (now >= room.expiresAtMs || now >= room.hardExpiresAtMs) {
      await this.closeAndClearRoom(room, 'ROOM_EXPIRED');
      return;
    }
    if (room.hostDisconnectDeadlineMs !== null && now >= room.hostDisconnectDeadlineMs
      && this.participantSockets(room.hostParticipantId).length === 0) {
      const nextHost = this.oldestConnectedMember(room);
      if (nextHost) {
        this.transferHost(room, nextHost, now);
        const presence = this.presenceEvent(room, now);
        this.commitEvent(room, presence);
        this.broadcast(presence);
      }
    }
    this.pruneParticipants(room, now);
    await this.scheduleAlarm(room);
  }
}
