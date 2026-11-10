import { env, exports } from 'cloudflare:workers';
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import {
  WATCH_PARTY_SUBPROTOCOL,
  WATCH_PARTY_LIMITS,
  normalizeWatchPartyChat,
  type WatchPartyMediaIdentity,
  type WatchPartyRoomSnapshotMessage,
  type WatchPartyServerMessage,
} from '../../../../src/features/watch-party/protocol';
import {
  generateWatchPartyId,
  generateWatchPartyRoomCode,
  signWatchPartyToken,
  verifyWatchPartyToken,
  watchPartySubprotocols,
  watchPartyTokenBase,
  type WatchPartyConnectTicketClaims,
} from '../../../../src/features/watch-party/tickets';
import worker from '../../src/index';
import { decodeWatchPartyServerMessage } from '../../../../src/features/watch-party/web/codec';

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

async function createTicket(options: { roomCode?: string; nowMs?: number; media?: WatchPartyMediaIdentity } = {}): Promise<{
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
    media: options.media ?? { kind: 'movie', mediaId: TITLE_ID },
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

  it('accepts the explicit React Native app origin but rejects foreign native origins and missing service configuration', async () => {
    const created = await createTicket();
    const native = await signWatchPartyToken({ ...created.claims, platform: 'android' }, SECRET);
    expect((await exports.default.fetch(upgradeRequest(native, 'https://evil.example.com'))).status).toBe(403);
    expect((await exports.default.fetch(upgradeRequest(native, 'null'))).status).toBe(403);
    const connected = await connect(native);
    expect(connected.snapshot.self.role).toBe('host');
    const noOrigin = upgradeRequest(native); noOrigin.headers.delete('Origin');
    const response = await exports.default.fetch(noOrigin);
    expect(response.status).toBe(101);
    response.webSocket!.accept(); openSockets.add(response.webSocket!);
    const missing = await worker.fetch(upgradeRequest(created.token), { ...env, WATCH_PARTY_SECRET: '' });
    expect(missing.status).toBe(503);
    const invalid = await worker.fetch(upgradeRequest(created.token), { ...env, WATCH_PARTY_SECRET: `${SECRET}\n` });
    expect(invalid.status).toBe(503);
  });
});

describe('Watch Party room protocol', () => {
  it('smokes public TMDB create, Android join, host-only controls, persisted episode state, resume and leave locally', async () => {
    const created = await createTicket({ media: { kind: 'movie', mediaId: 'tmdb:movie:27205' } });
    const host = await connect(created.token);
    expect(decodeWatchPartyServerMessage(host.snapshot)).toMatchObject({ ok: true });
    expect(host.snapshot.playback.media).toEqual({ kind: 'movie', mediaId: 'tmdb:movie:27205' });
    const joined = await joinTicket(created.claims.roomCode);
    const androidTicket = await signWatchPartyToken({ ...joined.claims, platform: 'android' }, SECRET);
    const android = await connect(androidTicket);
    expect(android.snapshot.self.role).toBe('member');
    expect(decodeWatchPartyServerMessage(android.snapshot)).toMatchObject({ ok: true });
    sendMessage(android.socket, { type: 'playback.command', requestId: 'tmdb-denied', baseRevision: 0, command: { kind: 'play' } });
    expect((await android.messages.next('server.error', (message) => message.requestId === 'tmdb-denied')).code).toBe('HOST_REQUIRED');
    sendMessage(host.socket, { type: 'playback.command', requestId: 'tmdb-seek', baseRevision: 0,
      command: { kind: 'seek', positionSeconds: 42 } });
    const seek = await android.messages.next('playback.state', (message) => message.playback.positionSeconds === 42);
    const episode: WatchPartyMediaIdentity = { kind: 'episode', mediaId: 'tmdb:tv:1396', seasonNumber: 1, episodeNumber: 2 };
    sendMessage(host.socket, { type: 'playback.command', requestId: 'tmdb-episode', baseRevision: seek.playback.revision,
      command: { kind: 'media', media: episode } });
    const switched = await android.messages.next('playback.state', (message) => message.playback.media.kind === 'episode');
    expect(switched.playback.media).toEqual(episode);
    expect(decodeWatchPartyServerMessage(switched)).toMatchObject({ ok: true });
    android.socket.close(1000, 'reconnect'); openSockets.delete(android.socket);
    await host.messages.next('presence.state', (message) => message.participants.some((participant) => participant.participantId === joined.claims.participantId && !participant.connected));
    const stub = env.WATCH_PARTY_ROOMS.getByName(created.claims.roomCode);
    await evictDurableObject(stub);
    const token = await verifyWatchPartyToken(android.snapshot.self.resumeToken, SECRET, { expectedKind: 'resume' });
    if (!token.ok || token.claims.kind !== 'resume') throw new Error('Expected valid Android resume token');
    const resumed = await connect(await signWatchPartyToken({ ...watchPartyTokenBase({
      roomCode: token.claims.roomCode, roomId: token.claims.roomId, participantId: token.claims.participantId,
      displayName: token.claims.displayName, platform: 'android', ttlSeconds: 120,
    }), kind: 'connect', action: 'resume', role: 'member' }, SECRET));
    expect(resumed.snapshot.playback.media).toEqual(episode);
    expect(resumed.snapshot.self.participantId).toBe(joined.claims.participantId);
    sendMessage(resumed.socket, { type: 'room.leave', requestId: 'tmdb-member-leave' });
    await resumed.messages.next('server.ack', (message) => message.requestId === 'tmdb-member-leave');
    sendMessage(host.socket, { type: 'room.leave', requestId: 'tmdb-host-leave' });
    await host.messages.next('room.closed');
    expect((await exports.default.fetch(upgradeRequest(androidTicket))).status).not.toBe(101);
  });
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

  it('does not let an original join ticket resurrect an explicitly departed participant', async () => {
    const created = await createTicket();
    const host = await connect(created.token);
    const joined = await joinTicket(created.claims.roomCode);
    const member = await connect(joined.token);
    sendMessage(member.socket, { type: 'room.leave', requestId: 'leave-member' });
    await member.messages.next('server.ack', (message) => message.requestId === 'leave-member');
    await host.messages.next('presence.state', (message) =>
      !message.participants.some((participant) => participant.participantId === joined.claims.participantId));
    await evictDurableObject(env.WATCH_PARTY_ROOMS.getByName(created.claims.roomCode));
    const replay = await exports.default.fetch(upgradeRequest(joined.token));
    expect(replay.status).toBe(403);
    expect((await errorBody(replay)).error.code).toBe('PARTICIPANT_NOT_FOUND');
  });

  it('does not recreate a closed room by replaying its original create ticket', async () => {
    const created = await createTicket();
    const host = await connect(created.token);
    sendMessage(host.socket, { type: 'room.leave', requestId: 'leave-last-host' });
    await host.messages.next('room.closed');
    const stub = env.WATCH_PARTY_ROOMS.getByName(created.claims.roomCode);
    await evictDurableObject(stub);
    const replay = await exports.default.fetch(upgradeRequest(created.token));
    expect(replay.status).toBe(403);
    expect((await errorBody(replay)).error.code).toBe('ROOM_CLOSED');
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM room').one().count).toBe(0);
    });
  });

  it('transfers an abandoned host to the first later member without a repeated past-due alarm', async () => {
    const created = await createTicket();
    const host = await connect(created.token);
    const stub = env.WATCH_PARTY_ROOMS.getByName(created.claims.roomCode);
    host.socket.close(1000, 'host offline');
    openSockets.delete(host.socket);
    await runInDurableObject(stub, async (instance, state) => {
      state.storage.sql.exec('UPDATE room SET host_disconnect_deadline_ms = ?', Date.now() - 1);
      await instance.alarm();
      expect(await state.storage.getAlarm()).toBeGreaterThan(Date.now() + 1_000);
    });
    const joined = await joinTicket(created.claims.roomCode);
    const member = await connect(joined.token);
    expect(member.snapshot.self.role).toBe('host');
    expect(member.snapshot.room.hostParticipantId).toBe(joined.claims.participantId);
  });

  it('refreshes only the requesting participant resume credential during a long session', async () => {
    const created = await createTicket();
    const host = await connect(created.token);
    const joined = await joinTicket(created.claims.roomCode);
    const member = await connect(joined.token);
    const stub = env.WATCH_PARTY_ROOMS.getByName(created.claims.roomCode);
    await runInDurableObject(stub, (_instance, state) => {
      for (const socket of state.getWebSockets()) {
        const attachment = socket.deserializeAttachment() as Record<string, unknown>;
        if (attachment.participantId !== joined.claims.participantId) continue;
        attachment.resumeIssuedAtMs = Date.now() - WATCH_PARTY_LIMITS.resumeTtlSeconds * 1_000;
        socket.serializeAttachment(attachment);
      }
    });
    sendMessage(member.socket, { type: 'client.ping', requestId: 'refresh-resume', clientSentAtMs: Date.now() });
    await member.messages.next('server.pong', (message) => message.requestId === 'refresh-resume');
    const refreshed = await member.messages.next('room.snapshot');
    expect(refreshed.self.participantId).toBe(joined.claims.participantId);
    expect(refreshed.self.resumeToken).not.toBe(member.snapshot.self.resumeToken);
    expect(await verifyWatchPartyToken(refreshed.self.resumeToken, SECRET, { expectedKind: 'resume' }))
      .toMatchObject({ ok: true, claims: { participantId: joined.claims.participantId, roomId: created.claims.roomId } });
    expect(JSON.stringify(refreshed.participants)).not.toContain('wp1.');
    expect(host.snapshot.self.resumeToken).not.toBe(refreshed.self.resumeToken);
  });

  it('isolates room identity and rejects messages after membership is removed', async () => {
    const created = await createTicket();
    const host = await connect(created.token);
    const otherRoom = await createTicket();
    const otherHost = await connect(otherRoom.token);
    const crossed = await signWatchPartyToken({ ...watchPartyTokenBase({
      roomCode: created.claims.roomCode, roomId: otherRoom.claims.roomId,
      participantId: otherHost.snapshot.self.participantId, displayName: 'Host', platform: 'web', ttlSeconds: 120,
    }), kind: 'connect', action: 'resume', role: 'member' }, SECRET);
    expect(await verifyWatchPartyToken(crossed, SECRET, { expectedKind: 'connect' })).toMatchObject({ ok: true });
    const crossedResponse = await exports.default.fetch(upgradeRequest(crossed));
    expect((await errorBody(crossedResponse)).error.code).toBe('INVALID_TICKET');
    expect(crossedResponse.status).toBe(401);

    const joined = await joinTicket(created.claims.roomCode);
    const member = await connect(joined.token);
    const stub = env.WATCH_PARTY_ROOMS.getByName(created.claims.roomCode);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec('DELETE FROM participants WHERE participant_id = ?', joined.claims.participantId);
    });
    sendMessage(member.socket, { type: 'chat.send', requestId: 'removed-chat', text: 'not a member' });
    expect((await member.messages.next('server.error', (message) => message.requestId === 'removed-chat')).code)
      .toBe('PARTICIPANT_NOT_FOUND');
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM chat').one().count).toBe(0);
    });
    sendMessage(host.socket, { type: 'client.sync', requestId: 'isolated-state', sinceRevision: 0 });
    const replay = await host.messages.next('room.replay');
    expect(JSON.stringify(replay)).not.toContain(otherHost.snapshot.self.participantId);
    expect(JSON.stringify(replay)).not.toContain(otherHost.snapshot.self.resumeToken);
  });

  it('retains admission tombstones through command-history pruning, then expires them', async () => {
    const created = await createTicket();
    const host = await connect(created.token);
    const stub = env.WATCH_PARTY_ROOMS.getByName(created.claims.roomCode);
    await runInDurableObject(stub, (_instance, state) => {
      for (let index = 0; index < 410; index += 1) {
        state.storage.sql.exec('INSERT INTO requests (participant_id, request_id, revision) VALUES (?, ?, ?)',
          created.claims.participantId, `old-${index}`, 0);
      }
    });
    sendMessage(host.socket, { type: 'playback.command', requestId: 'prune-requests', baseRevision: 0,
      command: { kind: 'pause' } });
    await host.messages.next('server.ack', (message) => message.requestId === 'prune-requests');
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM requests WHERE request_id LIKE 'ticket:%'")
        .one().count).toBe(1);
      expect(state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM requests WHERE request_id NOT LIKE 'ticket:%'")
        .one().count).toBeLessThanOrEqual(WATCH_PARTY_LIMITS.replayHistory * 2);
    });
    sendMessage(host.socket, { type: 'room.leave', requestId: 'clear-room' });
    await host.messages.next('room.closed');
    await runInDurableObject(stub, async (instance, state) => {
      state.storage.sql.exec('UPDATE requests SET revision = ?', Date.now() - 1);
      await instance.alarm();
      expect(state.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM requests').one().count).toBe(0);
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  it('keeps a multibyte chat snapshot within the web frame bound without deleting durable chat', async () => {
    const created = await createTicket();
    const host = await connect(created.token);
    const stub = env.WATCH_PARTY_ROOMS.getByName(created.claims.roomCode);
    await runInDurableObject(stub, (_instance, state) => {
      for (let index = 0; index < WATCH_PARTY_LIMITS.chatHistory; index += 1) {
        state.storage.sql.exec(`INSERT INTO chat (message_id, participant_id, client_message_id, display_name, text, server_time_ms, revision)
          VALUES (?, ?, ?, ?, ?, ?, ?)`, `chat-${index}`, created.claims.participantId, `chat-${index}`, 'Host',
        String.fromCodePoint(0x1f30a).repeat(WATCH_PARTY_LIMITS.maxChatCharacters), Date.now(), index + 2);
      }
      state.storage.sql.exec('UPDATE room SET revision = ?', WATCH_PARTY_LIMITS.chatHistory + 1);
    });
    sendMessage(host.socket, { type: 'client.sync', requestId: 'large-snapshot', sinceRevision: 1 });
    const bounded = await host.messages.next('room.snapshot');
    expect(new TextEncoder().encode(JSON.stringify(bounded)).byteLength).toBeLessThanOrEqual(WATCH_PARTY_LIMITS.maxServerMessageBytes);
    expect(bounded.chat.length).toBeGreaterThan(0);
    expect(bounded.chat.length).toBeLessThan(WATCH_PARTY_LIMITS.chatHistory);
    expect(bounded.chat.at(-1)?.revision).toBe(WATCH_PARTY_LIMITS.chatHistory + 1);
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM chat').one().count)
        .toBe(WATCH_PARTY_LIMITS.chatHistory);
    });
  });

  it('falls back to a snapshot when a retained presence replay exceeds the frame bound', async () => {
    const created = await createTicket();
    const host = await connect(created.token);
    const stub = env.WATCH_PARTY_ROOMS.getByName(created.claims.roomCode);
    await runInDurableObject(stub, (_instance, state) => {
      const participants = Array.from({ length: WATCH_PARTY_LIMITS.maxParticipants }, () => ({
        participantId: generateWatchPartyId(), displayName: 'Viewer'.repeat(6), role: 'member',
        joinedAtMs: Date.now(), lastSeenAtMs: Date.now(), connected: true,
      }));
      participants[0] = { ...participants[0]!, participantId: created.claims.participantId, role: 'host' };
      for (let revision = 2; revision <= 61; revision += 1) {
        state.storage.sql.exec('INSERT INTO events (revision, server_time_ms, payload_json) VALUES (?, ?, ?)', revision, Date.now(),
          JSON.stringify({ v: 1, type: 'presence.state', revision, serverTimeMs: Date.now(), participants,
            hostParticipantId: created.claims.participantId }));
      }
      state.storage.sql.exec('UPDATE room SET revision = 61');
    });
    sendMessage(host.socket, { type: 'client.sync', requestId: 'large-replay', sinceRevision: 1 });
    const bounded = await host.messages.next('room.snapshot');
    expect(bounded.room.revision).toBe(61);
    expect(new TextEncoder().encode(JSON.stringify(bounded)).byteLength).toBeLessThanOrEqual(WATCH_PARTY_LIMITS.maxServerMessageBytes);
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
