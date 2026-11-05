import { env, exports } from 'cloudflare:workers';
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import {
  WATCH_PARTY_SUBPROTOCOL,
  normalizeWatchPartyChat,
  type WatchPartyRoomSnapshotMessage,
  type WatchPartyServerMessage,
} from '../../../../src/features/watch-party/protocol';
import {
  generateWatchPartyId,
  generateWatchPartyRoomCode,
  signWatchPartyToken,
  watchPartySubprotocols,
  watchPartyTokenBase,
  type WatchPartyConnectTicketClaims,
} from '../../../../src/features/watch-party/tickets';

const SECRET = 'test-watch-party-secret-that-is-at-least-32-bytes';
const ORIGIN = 'https://app.example.com';
const TITLE_ID = '10000000-0000-4000-8000-000000000001';
const SHOW_ID = '10000000-0000-4000-8000-000000000002';
const EPISODE_ID = '10000000-0000-4000-8000-000000000003';
const openSockets = new Set<WebSocket>();

interface Connection {
  socket: WebSocket;
  messages: MessageReader;
  snapshot: WatchPartyRoomSnapshotMessage;
}

class MessageReader {
  private readonly queue: WatchPartyServerMessage[] = [];
  private readonly waiters = new Set<() => void>();

  constructor(socket: WebSocket) {
    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return;
      this.queue.push(JSON.parse(event.data) as WatchPartyServerMessage);
      for (const wake of this.waiters) wake();
      this.waiters.clear();
    });
  }

  async next<T extends WatchPartyServerMessage['type']>(type: T,
    predicate: (message: Extract<WatchPartyServerMessage, { type: T }>) => boolean = () => true,
    timeoutMs = 3_000): Promise<Extract<WatchPartyServerMessage, { type: T }>> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const index = this.queue.findIndex((candidate) => candidate.type === type
        && predicate(candidate as Extract<WatchPartyServerMessage, { type: T }>));
      if (index >= 0) return this.queue.splice(index, 1)[0] as Extract<WatchPartyServerMessage, { type: T }>;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Timed out waiting for ${type}; queued: ${this.queue.map((item) => item.type).join(', ')}`);
      await new Promise<void>((resolve, reject) => {
        const wake = () => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => { this.waiters.delete(wake); reject(new Error(`Timed out waiting for ${type}`)); }, remaining);
        this.waiters.add(wake);
      });
    }
  }
}

async function createTicket(options: { roomCode?: string; nowMs?: number } = {}): Promise<{
  token: string;
  claims: WatchPartyConnectTicketClaims;
}> {
  const claims: WatchPartyConnectTicketClaims = {
    ...watchPartyTokenBase({
      roomCode: options.roomCode ?? generateWatchPartyRoomCode(),
      roomId: generateWatchPartyId(),
      participantId: generateWatchPartyId(),
      displayName: 'Host',
      platform: 'web',
      ttlSeconds: 120,
      nowMs: options.nowMs,
    }),
    kind: 'connect',
    action: 'create',
    role: 'host',
    media: { kind: 'movie', mediaId: TITLE_ID },
  };
  return { claims, token: await signWatchPartyToken(claims, SECRET) };
}

async function joinTicket(roomCode: string, displayName = 'Viewer'): Promise<{
  token: string;
  claims: WatchPartyConnectTicketClaims;
}> {
  const claims: WatchPartyConnectTicketClaims = {
    ...watchPartyTokenBase({
      roomCode,
      participantId: generateWatchPartyId(),
      displayName,
      platform: 'web',
      ttlSeconds: 120,
    }),
    kind: 'connect',
    action: 'join',
    role: 'member',
  };
  return { claims, token: await signWatchPartyToken(claims, SECRET) };
}

function upgradeRequest(token: string, origin = ORIGIN): Request {
  return new Request('https://watch.example.com/v1/ws', {
    headers: {
      Upgrade: 'websocket',
      Origin: origin,
      'Sec-WebSocket-Protocol': watchPartySubprotocols(token).join(', '),
    },
  });
}

async function connect(token: string): Promise<Connection> {
  const response = await exports.default.fetch(upgradeRequest(token));
  expect(response.status).toBe(101);
  expect(response.headers.get('Sec-WebSocket-Protocol')).toBe(WATCH_PARTY_SUBPROTOCOL);
  const socket = response.webSocket;
  if (!socket) throw new Error('Expected a WebSocket response.');
  const messages = new MessageReader(socket);
  socket.accept();
  openSockets.add(socket);
  const snapshot = await messages.next('room.snapshot');
  return { socket, messages, snapshot };
}

function sendMessage(socket: WebSocket, message: object): void {
  socket.send(JSON.stringify({ v: 1, ...message }));
}

async function errorBody(response: Response): Promise<{ error: { code: string } }> {
  return response.json() as Promise<{ error: { code: string } }>;
}

afterEach(() => {
  for (const socket of openSockets) {
    try { socket.close(1000, 'test complete'); } catch { /* Already closed. */ }
  }
  openSockets.clear();
});

describe('Watch Party Worker edge authentication', () => {
  it('serves health without exposing bindings and rejects invalid upgrades', async () => {
    const health = await exports.default.fetch('https://watch.example.com/healthz');
    expect(await health.json()).toEqual({ ok: true, protocol: 1 });
    const plain = await exports.default.fetch('https://watch.example.com/v1/ws');
    expect(plain.status).toBe(426);
    expect((await errorBody(plain)).error.code).toBe('UPGRADE_REQUIRED');
    const missing = await exports.default.fetch(new Request('https://watch.example.com/v1/ws', {
      headers: { Upgrade: 'websocket', Origin: ORIGIN },
    }));
    expect(missing.status).toBe(401);
    expect((await errorBody(missing)).error.code).toBe('INVALID_TICKET');
  });

  it('rejects ticket tampering, expiry, and disallowed browser origins before the Durable Object', async () => {
    const valid = await createTicket();
    const tampered = `${valid.token.slice(0, -1)}${valid.token.endsWith('A') ? 'B' : 'A'}`;
    const tamperedResponse = await exports.default.fetch(upgradeRequest(tampered));
    expect(tamperedResponse.status).toBe(401);
    const expired = await createTicket({ nowMs: Date.now() - 121_000 });
    const expiredResponse = await exports.default.fetch(upgradeRequest(expired.token));
    expect(expiredResponse.status).toBe(401);
    expect((await errorBody(expiredResponse)).error.code).toBe('TICKET_EXPIRED');
    const forbidden = await exports.default.fetch(upgradeRequest(valid.token, 'https://evil.example.com'));
    expect(forbidden.status).toBe(403);
    expect((await errorBody(forbidden)).error.code).toBe('ORIGIN_FORBIDDEN');
  });
});

describe('Watch Party room protocol', () => {
  it('coordinates create/join, host playback, chat, replay, reconnect, and explicit transfer', async () => {
    const created = await createTicket();
    const host = await connect(created.token);
    expect(host.snapshot.self).toMatchObject({ participantId: created.claims.participantId, role: 'host' });
    expect(host.snapshot.playback).toMatchObject({ mode: 'paused', positionSeconds: 0, revision: 0 });
    expect(host.snapshot.self.resumeToken).toMatch(/^wp1\./);

    const joined = await joinTicket(created.claims.roomCode);
    const member = await connect(joined.token);
    expect(member.snapshot.self.role).toBe('member');
    const joinedPresence = await host.messages.next('presence.state', (message) =>
      message.participants.some((participant) => participant.participantId === joined.claims.participantId && participant.connected));
    expect(joinedPresence.revision).toBeGreaterThan(host.snapshot.room.revision);

    sendMessage(member.socket, {
      type: 'playback.command', requestId: 'member-play', baseRevision: member.snapshot.playback.revision,
      command: { kind: 'play' },
    });
    expect(await member.messages.next('server.error', (message) => message.requestId === 'member-play'))
      .toMatchObject({ code: 'HOST_REQUIRED' });

    sendMessage(host.socket, {
      type: 'playback.command', requestId: 'host-play', baseRevision: host.snapshot.playback.revision,
      command: { kind: 'play' },
    });
    const playing = await host.messages.next('playback.state', (message) => message.playback.mode === 'playing');
    const memberPlaying = await member.messages.next('playback.state', (message) => message.revision === playing.revision);
    expect(memberPlaying.playback.anchorServerTimeMs).toBe(playing.serverTimeMs);
    await host.messages.next('server.ack', (message) => message.requestId === 'host-play');

    sendMessage(host.socket, {
      type: 'playback.command', requestId: 'host-stale', baseRevision: 0,
      command: { kind: 'pause' },
    });
    expect(await host.messages.next('server.error', (message) => message.requestId === 'host-stale'))
      .toMatchObject({ code: 'STALE_REVISION' });

    sendMessage(host.socket, {
      type: 'playback.command', requestId: 'host-seek', baseRevision: playing.playback.revision,
      command: { kind: 'seek', positionSeconds: 42 },
    });
    const sought = await host.messages.next('playback.state', (message) => message.playback.positionSeconds === 42);
    sendMessage(host.socket, {
      type: 'playback.command', requestId: 'host-rate', baseRevision: sought.playback.revision,
      command: { kind: 'rate', playbackRate: 1.25 },
    });
    const rated = await host.messages.next('playback.state', (message) => message.playback.playbackRate === 1.25);
    sendMessage(host.socket, {
      type: 'playback.command', requestId: 'host-media', baseRevision: rated.playback.revision,
      command: { kind: 'media', media: { kind: 'episode', mediaId: SHOW_ID, episodeId: EPISODE_ID,
        seasonNumber: 2, episodeNumber: 7 } },
    });
    const changedMedia = await host.messages.next('playback.state', (message) => message.playback.media.kind === 'episode');
    expect(changedMedia.playback).toMatchObject({ mode: 'frozen', freezeReason: 'source-change', positionSeconds: 0,
      media: { episodeId: EPISODE_ID, seasonNumber: 2, episodeNumber: 7 } });

    sendMessage(member.socket, { type: 'chat.send', requestId: 'chat-1', text: '<b>Hello</b>' });
    const chat = await member.messages.next('chat.message');
    expect(chat.message.text).toBe(normalizeWatchPartyChat('<b>Hello</b>'));
    expect(chat.message.format).toBe('plain');
    await host.messages.next('chat.message', (message) => message.message.messageId === chat.message.messageId);

    sendMessage(member.socket, { type: 'client.sync', requestId: 'sync-1', sinceRevision: 0 });
    const replay = await member.messages.next('room.replay');
    expect(replay.events.length).toBeGreaterThan(3);
    expect(replay.events.every((event, index, events) => index === 0 || event.revision > events[index - 1]!.revision)).toBe(true);

    member.socket.close(1000, 'reconnect');
    openSockets.delete(member.socket);
    await host.messages.next('presence.state', (message) => message.participants.some((participant) =>
      participant.participantId === joined.claims.participantId && !participant.connected));
    const reconnected = await connect(joined.token);
    expect(reconnected.snapshot.self.participantId).toBe(joined.claims.participantId);
    expect(reconnected.snapshot.chat.some((message) => message.messageId === chat.message.messageId)).toBe(true);
    expect(reconnected.snapshot.playback.media.kind).toBe('episode');
    await host.messages.next('presence.state', (message) => message.participants.some((participant) =>
      participant.participantId === joined.claims.participantId && participant.connected));

    sendMessage(host.socket, {
      type: 'host.transfer', requestId: 'transfer-1', baseRevision: reconnected.snapshot.room.revision,
      participantId: joined.claims.participantId,
    });
    const transferred = await host.messages.next('host.changed', (message) => message.hostParticipantId === joined.claims.participantId);
    expect(transferred.previousHostParticipantId).toBe(created.claims.participantId);
    await reconnected.messages.next('host.changed', (message) => message.revision === transferred.revision);
    await host.messages.next('server.ack', (message) => message.requestId === 'transfer-1');

    sendMessage(host.socket, {
      type: 'playback.command', requestId: 'old-host', baseRevision: changedMedia.playback.revision,
      command: { kind: 'play' },
    });
    expect(await host.messages.next('server.error', (message) => message.requestId === 'old-host'))
      .toMatchObject({ code: 'HOST_REQUIRED' });
    sendMessage(reconnected.socket, {
      type: 'playback.command', requestId: 'new-host', baseRevision: changedMedia.playback.revision,
      command: { kind: 'play' },
    });
    expect((await reconnected.messages.next('playback.state', (message) => message.playback.mode === 'playing'))
      .playback.mode).toBe('playing');
  });

  it('restores socket attachments and durable state after hibernation', async () => {
    const created = await createTicket();
    const host = await connect(created.token);
    const stub = env.WATCH_PARTY_ROOMS.getByName(created.claims.roomCode);
    await evictDurableObject(stub);
    sendMessage(host.socket, { type: 'client.ping', requestId: 'after-eviction', clientSentAtMs: 1234 });
    expect(await host.messages.next('server.pong', (message) => message.requestId === 'after-eviction'))
      .toMatchObject({ clientSentAtMs: 1234 });
    sendMessage(host.socket, {
      type: 'playback.command', requestId: 'post-eviction-play', baseRevision: host.snapshot.playback.revision,
      command: { kind: 'play' },
    });
    expect((await host.messages.next('playback.state')).playback.mode).toBe('playing');
  });

  it('keeps source, ad, and background freezes until an explicit current-revision play', async () => {
    const created = await createTicket();
    const host = await connect(created.token);
    sendMessage(host.socket, {
      type: 'playback.command', requestId: 'freeze-source', baseRevision: host.snapshot.playback.revision,
      command: { kind: 'freeze', reason: 'source-change' },
    });
    const sourceFreeze = await host.messages.next('playback.state', (message) =>
      message.playback.mode === 'frozen' && message.playback.freezeReason === 'source-change');
    sendMessage(host.socket, {
      type: 'playback.command', requestId: 'seek-frozen', baseRevision: sourceFreeze.playback.revision,
      command: { kind: 'seek', positionSeconds: 15 },
    });
    const sought = await host.messages.next('playback.state', (message) => message.playback.positionSeconds === 15);
    expect(sought.playback).toMatchObject({ mode: 'frozen', freezeReason: 'source-change' });
    sendMessage(host.socket, {
      type: 'playback.command', requestId: 'stale-resume', baseRevision: sourceFreeze.playback.revision,
      command: { kind: 'play' },
    });
    expect(await host.messages.next('server.error', (message) => message.requestId === 'stale-resume'))
      .toMatchObject({ code: 'STALE_REVISION' });
    sendMessage(host.socket, {
      type: 'playback.command', requestId: 'resume-source', baseRevision: sought.playback.revision,
      command: { kind: 'play' },
    });
    const resumed = await host.messages.next('playback.state', (message) => message.playback.mode === 'playing');
    expect(resumed.playback.freezeReason).toBeUndefined();

    sendMessage(host.socket, {
      type: 'playback.command', requestId: 'freeze-ad', baseRevision: resumed.playback.revision,
      command: { kind: 'freeze', reason: 'ad-break' },
    });
    const adFreeze = await host.messages.next('playback.state', (message) => message.playback.freezeReason === 'ad-break');
    sendMessage(host.socket, {
      type: 'playback.command', requestId: 'rate-frozen', baseRevision: adFreeze.playback.revision,
      command: { kind: 'rate', playbackRate: 1.25 },
    });
    const rated = await host.messages.next('playback.state', (message) => message.playback.playbackRate === 1.25);
    expect(rated.playback).toMatchObject({ mode: 'frozen', freezeReason: 'ad-break' });
    sendMessage(host.socket, {
      type: 'playback.command', requestId: 'resume-ad', baseRevision: rated.playback.revision,
      command: { kind: 'play' },
    });
    const resumedAd = await host.messages.next('playback.state', (message) => message.playback.mode === 'playing');
    sendMessage(host.socket, {
      type: 'playback.command', requestId: 'freeze-background', baseRevision: resumedAd.playback.revision,
      command: { kind: 'freeze', reason: 'background' },
    });
    const background = await host.messages.next('playback.state', (message) =>
      message.playback.mode === 'frozen' && message.playback.freezeReason === 'background');
    sendMessage(host.socket, {
      type: 'playback.command', requestId: 'fallback-episode', baseRevision: background.playback.revision,
      command: { kind: 'media', media: { kind: 'episode', mediaId: SHOW_ID,
        seasonNumber: 3, episodeNumber: 9 } },
    });
    const fallback = await host.messages.next('playback.state', (message) =>
      message.playback.media.kind === 'episode' && message.playback.media.episodeNumber === 9);
    expect(fallback.playback).toMatchObject({ mode: 'frozen', freezeReason: 'source-change',
      media: { seasonNumber: 3, episodeNumber: 9 } });
  });

  it('enforces per-socket chat rate limits without disconnecting the room', async () => {
    const created = await createTicket();
    const host = await connect(created.token);
    for (let index = 0; index < 6; index += 1) {
      sendMessage(host.socket, { type: 'chat.send', requestId: `chat-${index}`, text: `Message ${index}` });
    }
    const limited = await host.messages.next('server.error', (message) => message.code === 'RATE_LIMITED');
    expect(limited.retryAfterMs).toBeGreaterThan(0);
    sendMessage(host.socket, { type: 'client.ping', requestId: 'still-open', clientSentAtMs: 10 });
    expect(await host.messages.next('server.pong', (message) => message.requestId === 'still-open')).toBeDefined();

    const stub = env.WATCH_PARTY_ROOMS.getByName(created.claims.roomCode);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(`INSERT INTO rate_limits (bucket, window_start_ms, message_count)
        VALUES ('control', ?, 60) ON CONFLICT (bucket) DO UPDATE SET
        window_start_ms = excluded.window_start_ms, message_count = excluded.message_count`, Date.now());
    });
    sendMessage(host.socket, {
      type: 'playback.command', requestId: 'room-limited', baseRevision: host.snapshot.playback.revision,
      command: { kind: 'play' },
    });
    expect(await host.messages.next('server.error', (message) => message.requestId === 'room-limited'))
      .toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('bounds participant capacity and simultaneous sockets', async () => {
    const created = await createTicket();
    const host = await connect(created.token);
    const second = await connect(created.token);
    const third = await connect(created.token);
    expect(second.snapshot.self.participantId).toBe(created.claims.participantId);
    expect(third.snapshot.self.participantId).toBe(created.claims.participantId);
    const fourth = await exports.default.fetch(upgradeRequest(created.token));
    expect(fourth.status).toBe(409);
    expect((await errorBody(fourth)).error.code).toBe('TOO_MANY_CONNECTIONS');

    const stub = env.WATCH_PARTY_ROOMS.getByName(created.claims.roomCode);
    await runInDurableObject(stub, (_instance, state) => {
      const now = Date.now();
      for (let index = 1; index < 50; index += 1) {
        const id = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
        state.storage.sql.exec(`INSERT OR IGNORE INTO participants
          (participant_id, display_name, joined_at_ms, last_seen_at_ms) VALUES (?, ?, ?, ?)`, id, `User ${index}`, now, now);
      }
    });
    const joined = await joinTicket(created.claims.roomCode, 'Overflow');
    const full = await exports.default.fetch(upgradeRequest(joined.token));
    expect(full.status).toBe(409);
    expect((await errorBody(full)).error.code).toBe('ROOM_FULL');
    expect(host.snapshot.room.roomCode).toBe(created.claims.roomCode);
  });

  it('freezes on the last host socket, survives reconnect and transfer, then cleans expired storage', async () => {
    const created = await createTicket();
    const host = await connect(created.token);
    const secondHostSocket = await connect(created.token);
    const joined = await joinTicket(created.claims.roomCode);
    const member = await connect(joined.token);
    await host.messages.next('presence.state');
    sendMessage(host.socket, {
      type: 'playback.command', requestId: 'play-before-disconnect', baseRevision: host.snapshot.playback.revision,
      command: { kind: 'play' },
    });
    await host.messages.next('playback.state', (message) => message.playback.mode === 'playing');
    const stub = env.WATCH_PARTY_ROOMS.getByName(created.claims.roomCode);
    await runInDurableObject(stub, (_instance, state) => {
      const row = state.storage.sql.exec<{ playback_json: string }>(
        'SELECT playback_json FROM room WHERE singleton = 1',
      ).one();
      const playback = JSON.parse(row.playback_json) as Record<string, unknown>;
      playback.positionSeconds = 10;
      playback.anchorServerTimeMs = Date.now() - 5_000;
      state.storage.sql.exec('UPDATE room SET playback_json = ? WHERE singleton = 1', JSON.stringify(playback));
    });
    host.socket.close(1000, 'one host socket remains');
    openSockets.delete(host.socket);
    sendMessage(secondHostSocket.socket, { type: 'client.ping', requestId: 'host-still-connected', clientSentAtMs: 1 });
    await secondHostSocket.messages.next('server.pong', (message) => message.requestId === 'host-still-connected');
    await runInDurableObject(stub, (_instance, state) => {
      const stored = JSON.parse(state.storage.sql.exec<{ playback_json: string }>(
        'SELECT playback_json FROM room WHERE singleton = 1',
      ).one().playback_json) as { mode: string };
      expect(stored.mode).toBe('playing');
    });

    secondHostSocket.socket.close(1000, 'last host socket gone');
    openSockets.delete(secondHostSocket.socket);
    const frozen = await member.messages.next('playback.state', (message) =>
      message.playback.mode === 'frozen' && message.playback.freezeReason === 'host-disconnected');
    expect(frozen.playback.positionSeconds).toBeGreaterThanOrEqual(14.5);
    expect(frozen.playback.anchorServerTimeMs).toBe(frozen.serverTimeMs);
    const offlinePresence = await member.messages.next('presence.state', (message) => message.participants.some((participant) =>
      participant.participantId === created.claims.participantId && !participant.connected));
    expect(offlinePresence.revision).toBe(frozen.revision + 1);
    expect(offlinePresence.serverTimeMs).toBeGreaterThan(frozen.serverTimeMs);

    const reconnectedHost = await connect(created.token);
    expect(reconnectedHost.snapshot.playback).toMatchObject({ mode: 'frozen', freezeReason: 'host-disconnected',
      revision: frozen.playback.revision });
    reconnectedHost.socket.close(1000, 'host gone again');
    openSockets.delete(reconnectedHost.socket);
    const frozenAgain = await member.messages.next('playback.state', (message) =>
      message.playback.mode === 'frozen' && message.revision > frozen.revision);
    expect(frozenAgain.playback.positionSeconds).toBeCloseTo(frozen.playback.positionSeconds, 3);
    await member.messages.next('presence.state', (message) => message.participants.some((participant) =>
      participant.participantId === created.claims.participantId && !participant.connected));
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec('UPDATE room SET host_disconnect_deadline_ms = ?', Date.now() - 1);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await member.messages.next('host.changed', (message) => message.hostParticipantId === joined.claims.participantId))
      .toMatchObject({ previousHostParticipantId: created.claims.participantId });
    await runInDurableObject(stub, (_instance, state) => {
      const stored = JSON.parse(state.storage.sql.exec<{ playback_json: string }>(
        'SELECT playback_json FROM room WHERE singleton = 1',
      ).one().playback_json) as { mode: string; freezeReason?: string; revision: number };
      expect(stored).toMatchObject({ mode: 'frozen', freezeReason: 'host-disconnected',
        revision: frozenAgain.playback.revision });
    });
    sendMessage(member.socket, {
      type: 'playback.command', requestId: 'new-host-explicit-play', baseRevision: frozenAgain.playback.revision,
      command: { kind: 'play' },
    });
    expect(await member.messages.next('playback.state', (message) => message.playback.mode === 'playing'))
      .toMatchObject({ playback: { mode: 'playing' } });

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec('UPDATE room SET expires_at_ms = ?, hard_expires_at_ms = ?', Date.now() - 1, Date.now() - 1);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await member.messages.next('room.closed')).toMatchObject({ code: 'ROOM_EXPIRED' });
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM room').one().count).toBe(0);
      expect(state.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM participants').one().count).toBe(0);
      expect(state.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM chat').one().count).toBe(0);
    });
    const retry = await exports.default.fetch(upgradeRequest(joined.token));
    expect(retry.status).toBe(404);
    expect((await errorBody(retry)).error.code).toBe('ROOM_NOT_FOUND');
  });
});
