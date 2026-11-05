import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { getStateFromPath } from '@react-navigation/core';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const fixture = JSON.parse(readFileSync(join(here, 'contract-vectors.json'), 'utf8'));
const build = mkdtempSync(join(tmpdir(), 'lumora-watch-party-'));
const sourceFiles = [
  'src/lib/runtime-config.ts',
  'src/watch-party/config.ts',
  'src/watch-party/protocol.ts',
  'src/watch-party/errors.ts',
  'src/watch-party/codec.ts',
  'src/watch-party/reducer.ts',
  'src/watch-party/transport.ts',
];

for (const relative of sourceFiles) {
  const source = readFileSync(join(root, relative), 'utf8');
  const result = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
  }, fileName: relative, reportDiagnostics: true });
  const errors = (result.diagnostics ?? []).filter((item) => item.category === ts.DiagnosticCategory.Error);
  assert.equal(errors.length, 0, `transpile diagnostics for ${relative}`);
  const output = join(build, relative.replace(/\.ts$/, '.js'));
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, result.outputText);
}

const previousWebUrl = process.env.EXPO_PUBLIC_WEB_URL;
process.env.EXPO_PUBLIC_WEB_URL = 'https://lumora.adhyanagrawal777.workers.dev';
const protocol = require(join(build, 'src/watch-party/protocol.js'));
const codec = require(join(build, 'src/watch-party/codec.js'));
const reducer = require(join(build, 'src/watch-party/reducer.js'));
const transportModule = require(join(build, 'src/watch-party/transport.js'));

after(() => {
  if (previousWebUrl === undefined) delete process.env.EXPO_PUBLIC_WEB_URL;
  else process.env.EXPO_PUBLIC_WEB_URL = previousWebUrl;
  rmSync(build, { recursive: true, force: true });
});

function near(actual, expected, epsilon = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} is not within ${epsilon} of ${expected}`);
}

test('shared backend protocol checksum is pinned', () => {
  const canonical = readFileSync(fixture.source);
  assert.equal(createHash('sha256').update(canonical).digest('hex'), fixture.sha256);
});

test('mobile constants and normalization match backend vectors', () => {
  assert.equal(protocol.WATCH_PARTY_PROTOCOL_VERSION, fixture.protocolVersion);
  assert.equal(protocol.WATCH_PARTY_SUBPROTOCOL, fixture.subprotocol);
  assert.equal(protocol.WATCH_PARTY_TICKET_SUBPROTOCOL_PREFIX, fixture.ticketPrefix);
  for (const [key, value] of Object.entries(fixture.limits)) assert.equal(protocol.WATCH_PARTY_LIMITS[key], value);
  for (const [key, value] of Object.entries(fixture.driftPolicy)) assert.equal(protocol.WATCH_PARTY_DRIFT_POLICY[key], value);
  assert.equal(protocol.normalizeWatchPartyRoomCode(fixture.normalization.roomInput), fixture.normalization.roomOutput);
  assert.equal(protocol.normalizeWatchPartyDisplayName(fixture.normalization.displayNameInput), fixture.normalization.displayNameOutput);
  assert.equal(protocol.normalizeWatchPartyChat(fixture.normalization.chatInput), fixture.normalization.chatOutput);
  assert.equal(protocol.normalizeWatchPartyChat(' '.repeat(20)), null);
});

test('clock projection and drift hysteresis match backend vectors', () => {
  const sample = protocol.clockSample(fixture.clock.clientSentAtMs, fixture.clock.clientReceivedAtMs,
    fixture.clock.serverTimeMs);
  assert.deepEqual(sample, { roundTripMs: fixture.clock.roundTripMs, offsetMs: fixture.clock.offsetMs,
    receivedAtMs: fixture.clock.clientReceivedAtMs });
  const media = { kind: 'movie', mediaId: fixture.ids.movie };
  const playback = { media, mode: 'playing', positionSeconds: 10, playbackRate: 1,
    anchorServerTimeMs: 1000, revision: 4 };
  near(protocol.projectWatchPartyPosition(playback, 3000, []), 12);
  for (const vector of fixture.drift) {
    const action = protocol.planWatchPartyDrift({ playback, localMedia: media,
      localPositionSeconds: vector.localPositionSeconds, localMode: 'playing', localNowMs: 1000,
      clockSamples: [], correctionState: vector.correctionState });
    assert.equal(action.kind, vector.kind, vector.name);
    near(action.playbackRate, vector.rate, 1e-8);
  }
  const frozen = { ...playback, mode: 'frozen', freezeReason: 'ad-break', positionSeconds: 15 };
  assert.equal(protocol.projectWatchPartyPosition(frozen, 100_000, []), 15);
  assert.equal(protocol.planWatchPartyDrift({ playback, localMedia: { kind: 'movie', mediaId: fixture.ids.episode },
    localPositionSeconds: 10, localMode: 'playing', localNowMs: 1000, clockSamples: [] }).reason, 'media');
});

test('strict ticket and snapshot codecs reject drift fields', () => {
  const now = 1_000_000;
  const ticket = 'wp1.payload.signature';
  const response = { v: 1, ticket, ticketExpiresAtMs: now + 60_000, roomCode: 'ABCDEFGH23',
    participantId: fixture.ids.participant, websocketUrl: 'wss://party.example/v1/ws',
    subprotocols: [fixture.subprotocol, `${fixture.ticketPrefix}${ticket}`] };
  assert.equal(codec.decodeWatchPartyTicket(response, now).ok, true);
  assert.equal(codec.decodeWatchPartyTicket({ ...response, extra: true }, now).ok, false);
  assert.equal(codec.decodeWatchPartyTicket({ ...response, subprotocols: [fixture.subprotocol, ticket] }, now).ok, false);
  const snapshot = { v: 1, type: 'room.snapshot', serverTimeMs: now,
    room: { roomCode: 'ABCDEFGH23', revision: 0, createdAtMs: now - 100, expiresAtMs: now + 100_000,
      hostParticipantId: fixture.ids.participant },
    self: { participantId: fixture.ids.participant, role: 'host', resumeToken: ticket },
    playback: { media: { kind: 'movie', mediaId: fixture.ids.movie }, mode: 'paused', positionSeconds: 0,
      playbackRate: 1, anchorServerTimeMs: now, revision: 0 },
    participants: [{ participantId: fixture.ids.participant, displayName: 'Host', role: 'host', connected: true,
      joinedAtMs: now - 100 }], chat: [] };
  const decoded = codec.decodeWatchPartyServerMessage(snapshot);
  assert.equal(decoded.ok, true);
  assert.equal(codec.decodeWatchPartyServerMessage({ ...snapshot, unknown: 1 }).ok, false);
  const state = reducer.reduceWatchPartyServerMessage(reducer.INITIAL_WATCH_PARTY_STATE, decoded.value, now);
  assert.equal(state.phase, 'connected');
  assert.equal(state.room.roomCode, 'ABCDEFGH23');
  const replay = { v: 1, type: 'room.replay', fromRevision: 0, revision: 2, serverTimeMs: now + 20,
    events: [
      { v: 1, type: 'playback.state', revision: 1, serverTimeMs: now + 10,
        playback: { ...snapshot.playback, positionSeconds: 5, revision: 1, anchorServerTimeMs: now + 10 } },
      { v: 1, type: 'chat.message', revision: 2, serverTimeMs: now + 20,
        message: { messageId: fixture.ids.episode, participantId: fixture.ids.participant,
          displayName: 'Host', text: 'Ready', format: 'plain', revision: 2, serverTimeMs: now + 20 } },
    ] };
  const decodedReplay = codec.decodeWatchPartyServerMessage(replay);
  assert.equal(decodedReplay.ok, true);
  const replayed = reducer.reduceWatchPartyServerMessage(state, decodedReplay.value, now + 20);
  assert.equal(replayed.room.revision, 2);
  assert.equal(replayed.playback.positionSeconds, 5);
  assert.equal(replayed.chat[0].text, 'Ready');
  assert.equal(codec.decodeWatchPartyServerMessage({ ...replay,
    events: replay.events.map((event, index) => index ? { ...event, revision: 3,
      message: { ...event.message, revision: 3 } } : event) }).ok, false);
});

class FakeSocket {
  constructor(protocol = fixture.subprotocol) {
    this.protocol = protocol;
    this.readyState = 0;
    this.listeners = new Map();
    this.sent = [];
    this.closed = null;
  }
  addEventListener(name, listener) {
    const current = this.listeners.get(name) ?? [];
    current.push(listener);
    this.listeners.set(name, current);
  }
  emit(name, value = {}) { for (const listener of this.listeners.get(name) ?? []) listener(value); }
  send(value) { this.sent.push(value); }
  close(code, reason) { this.readyState = 3; this.closed = { code, reason }; }
}

async function waitFor(predicate) {
  for (let index = 0; index < 40; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail('timed out waiting for transport');
}

test('Android transport uses the exact Cloudflare ticket API and subprotocol-only ticket', async () => {
  const originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = class { static OPEN = 1; static CLOSING = 2; };
  const now = 2_000_000;
  const ticket = 'wp1.mobile.signature';
  const socket = new FakeSocket();
  let fetchInput;
  let fetchInit;
  let socketInput;
  let socketProtocols;
  let socketOptions;
  const statuses = [];
  const errors = [];
  const environment = {
    fetch: async (input, init) => {
      fetchInput = input; fetchInit = init;
      return new Response(JSON.stringify({ v: 1, ticket, ticketExpiresAtMs: now + 60_000,
        roomCode: 'ABCDEFGH23', participantId: fixture.ids.participant,
        websocketUrl: 'wss://party.example/v1/ws',
        subprotocols: [fixture.subprotocol, `${fixture.ticketPrefix}${ticket}`] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
    createSocket: (url, protocols, options) => {
      socketInput = url; socketProtocols = protocols; socketOptions = options; return socket;
    },
    setTimeout, clearTimeout, now: () => now, random: () => 0,
  };
  const transport = new transportModule.WatchPartyTransport({
    onStatus: (status) => statuses.push(status.phase), onMessage: () => {},
    onError: (error, fatal) => errors.push({ error, fatal }),
  }, environment);
  transport.start({ v: 1, action: 'join', platform: 'android', displayName: 'Alice', roomCode: 'ABCDEFGH23' });
  await waitFor(() => Boolean(socketInput));
  assert.equal(fetchInput, 'https://lumora.adhyanagrawal777.workers.dev/api/watch-party');
  assert.equal(fetchInit.credentials, 'omit');
  assert.equal(fetchInit.redirect, 'error');
  assert.deepEqual(JSON.parse(fetchInit.body), { v: 1, action: 'join', platform: 'android',
    displayName: 'Alice', roomCode: 'ABCDEFGH23' });
  assert.equal(socketInput, 'wss://party.example/v1/ws');
  assert.equal(new URL(socketInput).search, '');
  assert.ok(!socketInput.includes(ticket));
  assert.deepEqual(socketProtocols, [fixture.subprotocol, `${fixture.ticketPrefix}${ticket}`]);
  assert.deepEqual(socketOptions, { headers: { Origin: 'https://lumora.adhyanagrawal777.workers.dev' } });
  assert.ok(!JSON.stringify(socketOptions).includes(ticket));
  socket.readyState = 1;
  socket.emit('open');
  assert.ok(statuses.includes('connected'));
  assert.equal(errors.length, 0);
  assert.equal(transport.send({ v: 1, type: 'client.ping' }), true);
  assert.equal(socket.sent.length, 1);
  transport.disconnect();
  globalThis.WebSocket = originalWebSocket;
});

test('transport rejects any websocket URL carrying a query ticket', async () => {
  const now = 3_000_000;
  const ticket = 'wp1.mobile.signature';
  const errors = [];
  let socketCreated = false;
  const transport = new transportModule.WatchPartyTransport({
    onStatus: () => {}, onMessage: () => {}, onError: (error, fatal) => errors.push({ error, fatal }),
  }, {
    fetch: async () => new Response(JSON.stringify({ v: 1, ticket, ticketExpiresAtMs: now + 60_000,
      roomCode: 'ABCDEFGH23', participantId: fixture.ids.participant,
      websocketUrl: `wss://party.example/v1/ws?ticket=${ticket}`,
      subprotocols: [fixture.subprotocol, `${fixture.ticketPrefix}${ticket}`] }), { status: 200 }),
    createSocket: () => { socketCreated = true; return new FakeSocket(); },
    setTimeout, clearTimeout, now: () => now, random: () => 0,
  });
  transport.start({ v: 1, action: 'join', platform: 'android', displayName: 'Alice', roomCode: 'ABCDEFGH23' });
  await waitFor(() => errors.length > 0);
  assert.equal(socketCreated, false);
  assert.equal(errors[0].error.code, 'PROTOCOL');
  assert.equal(errors[0].fatal, true);
  transport.disconnect();
});

test('reconnect backoff is bounded and deterministic', () => {
  assert.equal(transportModule.watchPartyReconnectDelay(1, 0), 500);
  assert.equal(transportModule.watchPartyReconnectDelay(2, 1), 1250);
  assert.equal(transportModule.watchPartyReconnectDelay(20, 1), 15250);
});

test('NavigationContainer mapping parses app-link and scheme paths', () => {
  const state = getStateFromPath('watch/movie/example-title?party=ABCDEFGH23&season=2&episode=3', {
    screens: { Tabs: '', WatchPartyLink: { path: 'watch/:type/:slug',
      parse: { season: Number, episode: Number, party: String } } },
  });
  assert.deepEqual(state.routes[0].params, { type: 'movie', slug: 'example-title',
    episode: 3, party: 'ABCDEFGH23', season: 2 });
});
