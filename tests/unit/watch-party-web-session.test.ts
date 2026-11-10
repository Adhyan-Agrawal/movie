import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WATCH_PARTY_SUBPROTOCOL, type WatchPartyRoomSnapshotMessage } from '@/features/watch-party/protocol';
import type { PartyPlayerIntent, PartyPlayerPort } from '@/features/watch-party/web/player-port';

const harness = vi.hoisted(() => ({
  slots: [] as any[], cursor: 0, effects: [] as Array<() => void>, dirty: false,
  fetch: vi.fn<typeof fetch>(),
}));
vi.mock('react', async (original) => {
  const actual = await original<typeof import('react')>();
  const equal = (left?: unknown[], right?: unknown[]) => Boolean(left && right && left.length === right.length && left.every((value, index) => Object.is(value, right[index])));
  const state = (initial: unknown) => {
    const index = harness.cursor++;
    if (!harness.slots[index]) harness.slots[index] = { value: typeof initial === 'function' ? initial() : initial };
    return [harness.slots[index].value, (next: unknown) => {
      const value = typeof next === 'function' ? next(harness.slots[index].value) : next;
      if (!Object.is(value, harness.slots[index].value)) { harness.slots[index].value = value; harness.dirty = true; }
    }];
  };
  return { ...actual,
    useState: state,
    useReducer(reducer: (state: unknown, action: unknown) => unknown, initial: unknown) {
      const [value, set] = state(initial) as [unknown, (next: unknown) => void];
      return [value, (action: unknown) => set((previous: unknown) => reducer(previous, action))];
    },
    useRef(value: unknown) { const index = harness.cursor++; return harness.slots[index] ??= { current: value }; },
    useCallback(callback: unknown, dependencies: unknown[]) {
      const index = harness.cursor++; const previous = harness.slots[index];
      if (!previous || !equal(previous.dependencies, dependencies)) harness.slots[index] = { callback, dependencies };
      return harness.slots[index].callback;
    },
    useEffect(effect: () => void | (() => void), dependencies?: unknown[]) {
      const index = harness.cursor++; const previous = harness.slots[index];
      if (previous && equal(previous.dependencies, dependencies)) return;
      harness.slots[index] = { dependencies, cleanup: previous?.cleanup };
      harness.effects.push(() => { harness.slots[index].cleanup?.(); harness.slots[index].cleanup = effect(); });
    },
  };
});

import { useWatchPartySession, type WatchPartySessionController } from '@/features/watch-party/web/useWatchPartySession';

const TITLE_ID = '10000000-0000-4000-8000-000000000001';
const HOST_ID = '10000000-0000-4000-8000-000000000002';
const MEMBER_ID = '10000000-0000-4000-8000-000000000003';
const media = { kind: 'movie' as const, mediaId: TITLE_ID };
let options: Parameters<typeof useWatchPartySession>[0];
let session: WatchPartySessionController;

class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  protocol = WATCH_PARTY_SUBPROTOCOL;
  sent: string[] = [];
  private listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();
  constructor(readonly url: string, readonly protocols: string[]) { FakeSocket.instances.push(this); }
  addEventListener(type: string, listener: (event: { data?: unknown }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  removeEventListener(type: string, listener: (event: { data?: unknown }) => void) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((value) => value !== listener));
  }
  send(value: string) { this.sent.push(value); }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; for (const listener of this.listeners.get('open') ?? []) listener({}); }
  message(value: unknown) { for (const listener of this.listeners.get('message') ?? []) listener({ data: JSON.stringify(value) }); }
  networkClose() { this.readyState = 3; for (const listener of this.listeners.get('close') ?? []) listener({}); }
}

function snapshot(): WatchPartyRoomSnapshotMessage {
  return { v: 1, type: 'room.snapshot', serverTimeMs: Date.now(),
    room: { roomCode: 'ABCDE23456', revision: 0, createdAtMs: Date.now() - 1_000,
      expiresAtMs: Date.now() + 60_000, hostParticipantId: HOST_ID },
    self: { participantId: MEMBER_ID, role: 'member', resumeToken: 'wp1.resume.signature' },
    playback: { media, mode: 'paused', positionSeconds: 12, playbackRate: 1, anchorServerTimeMs: Date.now(), revision: 0 },
    participants: [{ participantId: HOST_ID, displayName: 'Host', role: 'host', connected: true, joinedAtMs: Date.now() - 1_000 },
      { participantId: MEMBER_ID, displayName: 'Viewer', role: 'member', connected: true, joinedAtMs: Date.now() - 500 }], chat: [] };
}
// eslint-disable-next-line react-hooks/rules-of-hooks -- React hooks are replaced by the deterministic harness above.
function render() { harness.cursor = 0; harness.dirty = false; session = useWatchPartySession(options); }
async function pump() {
  for (let index = 0; index < 25; index += 1) {
    while (harness.effects.length) harness.effects.shift()!();
    await Promise.resolve(); if (harness.dirty) render();
  }
}
async function mount() { render(); await pump(); }
function unmount() { for (const slot of harness.slots) slot?.cleanup?.(); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  harness.slots = []; harness.effects = []; harness.cursor = 0; harness.dirty = false; FakeSocket.instances = [];
  harness.fetch.mockReset(); harness.fetch.mockImplementation(async () => Response.json({ v: 1, ticket: 'wp1.ticket.signature',
    ticketExpiresAtMs: Date.now() + 120_000, roomCode: 'ABCDE23456', participantId: MEMBER_ID,
    websocketUrl: 'wss://party.example/v1/ws', subprotocols: [WATCH_PARTY_SUBPROTOCOL, 'lumora.ticket.wp1.ticket.signature'] }));
  vi.stubGlobal('fetch', harness.fetch); vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('window', { setTimeout, clearTimeout, setInterval, clearInterval,
    location: new URL('https://app.example/watch/movie/fixture'),
    sessionStorage: { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() } });
  options = { configured: true, media, surface: 'native' };
});
afterEach(() => { unmount(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('Watch Party release availability and storage failures', () => {
  it.each(['native', 'embed', 'unavailable'] as const)('blocks create/join/resume/retry with no config or ticket request on %s', async (surface) => {
    options = { configured: false, media, surface }; await mount();
    expect(session.available).toBe(false); expect(session.syncStatus).toBe('unavailable');
    expect(session.create('Viewer')).toBe(false); expect(session.join('Viewer', 'ABCDE23456')).toBe(false);
    expect(session.resume()).toBe(false); session.retry(); await pump();
    await vi.advanceTimersByTimeAsync(30_000); await pump();
    expect(harness.fetch).not.toHaveBeenCalled(); expect(FakeSocket.instances).toHaveLength(0); expect(session.state.phase).toBe('idle');
  });

  it('fails closed when the forwarded flag is absent without probing startup configuration', async () => {
    options = { media, surface: 'native' }; await mount();
    expect(session.available).toBe(false); expect(session.create('Viewer')).toBe(false); expect(harness.fetch).not.toHaveBeenCalled();
  });

  it.each([TITLE_ID, 'tmdb:movie:123'])('keeps configured ticket flow lazy and labels native sync unavailable until a port actually registers for %s', async (mediaId) => {
    const media = { kind: 'movie' as const, mediaId };
    options = { configured: true, media, surface: 'native' };
    await mount(); expect(session.available).toBe(true); expect(session.syncStatus).toBe('awaiting-player-port');
    expect(harness.fetch).not.toHaveBeenCalled();
    const port: PartyPlayerPort = { read: () => ({ media, mode: 'paused', positionSeconds: 12, playbackRate: 1 }),
      apply: vi.fn(), subscribe: vi.fn(() => vi.fn()) };
    session.registerPlayerPort(port); await pump(); expect(session.syncStatus).toBe('ready');
    expect(session.create('Viewer')).toBe(true); await pump();
    expect(harness.fetch).toHaveBeenCalledOnce(); expect(harness.fetch.mock.calls[0]?.[0]).toBe('/api/watch-party');
    expect(JSON.parse(String(harness.fetch.mock.calls[0]?.[1]?.body))).toEqual({ v: 1, action: 'create', platform: 'web', displayName: 'Viewer', media, positionSeconds: 12 });
    session.registerPlayerPort(null); await pump(); expect(session.syncStatus).toBe('awaiting-player-port');
  });

  it('creates canonical TMDB rooms on embeds without claiming native synchronization', async () => {
    const media = { kind: 'movie' as const, mediaId: 'tmdb:movie:123' };
    options = { configured: true, media, surface: 'embed' }; await mount();
    expect(session.available).toBe(true); expect(session.syncStatus).toBe('chat-only-embed');
    expect(harness.fetch).not.toHaveBeenCalled();
    expect(session.create('Viewer')).toBe(true); await pump();
    expect(harness.fetch).toHaveBeenCalledOnce(); expect(harness.fetch.mock.calls[0]?.[0]).toBe('/api/watch-party');
    expect(JSON.parse(String(harness.fetch.mock.calls[0]?.[1]?.body))).toEqual({ v: 1, action: 'create', platform: 'web', displayName: 'Viewer', media });
    expect(FakeSocket.instances).toHaveLength(1); expect(session.syncStatus).toBe('chat-only-embed');
  });

  it('rejects noncanonical TMDB create identities without making service availability depend on catalog/native support', async () => {
    options = { configured: true, media: { kind: 'movie', mediaId: 'tmdb:movie:0123' }, surface: 'embed' }; await mount();
    expect(session.available).toBe(true); expect(session.syncStatus).toBe('unsupported-media');
    expect(session.create('Viewer')).toBe(false); await pump(); expect(harness.fetch).not.toHaveBeenCalled();
    expect(session.join('Viewer', 'ABCDE23456')).toBe(true); await pump(); expect(harness.fetch).toHaveBeenCalledOnce();
  });

  it('catches a throwing storage getter during restore/resume and never tickets a missing resume', async () => {
    Object.defineProperty(window, 'sessionStorage', { configurable: true, get() { throw new Error('Getter blocked'); } });
    await expect(mount()).resolves.toBeUndefined(); expect(session.savedResume).toBeNull();
    expect(session.resume()).toBe(false); await pump(); expect(harness.fetch).not.toHaveBeenCalled();
    expect(session.state.phase).toBe('idle');
  });

  it.each(['getter', 'methods'])('survives %s failures while writing a real snapshot and clearing a leave acknowledgement', async (failure) => {
    if (failure === 'getter') Object.defineProperty(window, 'sessionStorage', { configurable: true, get() { throw new Error('Getter blocked'); } });
    else Object.defineProperty(window, 'sessionStorage', { configurable: true, value: {
      getItem() { throw new Error('Read blocked'); }, setItem() { throw new Error('Write blocked'); }, removeItem() { throw new Error('Clear blocked'); },
    } });
    await mount(); session.join('Viewer', 'ABCDE23456'); await pump(); const socket = FakeSocket.instances[0]!; socket.open();
    expect(() => socket.message(snapshot())).not.toThrow(); await pump(); expect(session.state.phase).toBe('connected');
    expect(session.savedResume?.roomCode).toBe('ABCDE23456');
    session.leave(); const request = JSON.parse(socket.sent.at(-1)!) as { requestId: string };
    expect(() => socket.message({ v: 1, type: 'server.ack', requestId: request.requestId, revision: 0, serverTimeMs: Date.now() })).not.toThrow();
    await pump(); expect(session.state.phase).toBe('closed'); expect(session.savedResume).toBeNull(); expect(socket.readyState).toBe(3);
  });

  it('guards the timeout and terminal-error clear paths when storage becomes blocked after joining', async () => {
    await mount(); session.join('Viewer', 'ABCDE23456'); await pump(); const socket = FakeSocket.instances[0]!; socket.open(); socket.message(snapshot()); await pump();
    Object.defineProperty(window, 'sessionStorage', { configurable: true, get() { throw new Error('Getter blocked'); } });
    session.leave(); await vi.advanceTimersByTimeAsync(2_001); await pump(); expect(session.state.phase).toBe('closed');
    harness.fetch.mockImplementation(async () => Response.json({ v: 1, error: { code: 'INVALID_TICKET', message: 'private' } }, { status: 401 }));
    session.join('Viewer', 'ABCDE23456'); await pump(); expect(session.state.phase).toBe('error');
    expect(session.state.error?.message).toBe('This Watch Party session is no longer valid.'); expect(session.savedResume).toBeNull();
  });

  it('cancels a pending configured attempt and guards stale callbacks immediately when availability is revoked', async () => {
    const pending = deferred<Response>(); harness.fetch.mockReturnValue(pending.promise);
    await mount(); const oldJoin = session.join; session.join('Viewer', 'ABCDE23456'); await pump();
    options = { ...options, configured: false }; render(); expect(oldJoin('Viewer', 'ABCDE23456')).toBe(false); await pump();
    pending.resolve(Response.json({ v: 1, error: { code: 'INTERNAL_ERROR', message: 'private' } }, { status: 503 }));
    await pump(); session.retry(); await vi.advanceTimersByTimeAsync(30_000); await pump();
    expect(harness.fetch).toHaveBeenCalledOnce(); expect(session.state.phase).toBe('idle'); expect(session.state.error).toBeNull();
    expect(FakeSocket.instances).toHaveLength(0);
  });

  it('ignores a late ticket after unmount and makes retained callbacks inert', async () => {
    const pending = deferred<Response>(); harness.fetch.mockReturnValue(pending.promise);
    await mount(); session.join('Viewer', 'ABCDE23456'); await pump(); unmount(); harness.dirty = false;
    expect(session.join('Viewer', 'ABCDE23456')).toBe(false);
    pending.resolve(Response.json({ v: 1, error: { code: 'INTERNAL_ERROR' } }, { status: 503 }));
    await pump(); expect(harness.dirty).toBe(false); expect(FakeSocket.instances).toHaveLength(0);
  });

  it.each(['room', 'participant'])('rejects a valid-looking snapshot belonging to a different %s', async (field) => {
    await mount(); session.join('Viewer', 'ABCDE23456'); await pump();
    const socket = FakeSocket.instances[0]!; socket.open();
    const wrong = snapshot();
    if (field === 'room') wrong.room.roomCode = 'ZZZZZ23456';
    else wrong.self = { ...wrong.self, participantId: HOST_ID, role: 'host' };
    socket.message(wrong); await pump();
    expect(session.state.phase).toBe('error'); expect(session.state.error?.code).toBe('PROTOCOL');
    expect(session.state.room).toBeNull(); expect(session.savedResume).toBeNull(); expect(socket.readyState).toBe(3);
  });

  it('deduplicates leave immediately and cancels its timeout before joining again', async () => {
    await mount(); session.join('Viewer', 'ABCDE23456'); await pump();
    const socket = FakeSocket.instances[0]!; socket.open(); socket.message(snapshot()); await pump();
    session.leave(); session.leave();
    const leaves = socket.sent.map((raw) => JSON.parse(raw)).filter((message) => message.type === 'room.leave');
    expect(leaves).toHaveLength(1); expect(session.join('Other', 'ZZZZZ23456')).toBe(false);
    await pump(); expect(session.state.phase).toBe('leaving'); expect(session.sendChat('late')).toBe(false);
    socket.message({ v: 1, type: 'server.ack', requestId: leaves[0].requestId, revision: 0, serverTimeMs: Date.now() });
    await pump(); expect(session.state.phase).toBe('closed');
    session.retry(); expect(harness.fetch).toHaveBeenCalledOnce();
    expect(session.join('Viewer', 'ABCDE23456')).toBe(true); await pump();
    FakeSocket.instances[1]!.open(); FakeSocket.instances[1]!.message(snapshot()); await pump();
    await vi.advanceTimersByTimeAsync(2_001); await pump();
    expect(session.state.phase).toBe('connected'); expect(FakeSocket.instances[1]!.readyState).toBe(1);
  });
});

describe('Watch Party native port synchronization', () => {
  async function connectPort(role: 'host' | 'member' = 'host') {
    let emit!: (intent: PartyPlayerIntent) => void;
    const unsubscribe = vi.fn();
    const apply = vi.fn();
    const local = { media, mode: 'playing' as const, positionSeconds: 25, playbackRate: 1 };
    const port: PartyPlayerPort = { read: () => local, apply,
      subscribe(listener) { emit = listener; return unsubscribe; } };
    await mount(); session.registerPlayerPort(port); await pump();
    session.join('Viewer', 'ABCDE23456'); await pump();
    const socket = FakeSocket.instances[0]!; socket.open();
    const room = snapshot();
    if (role === 'host') {
      room.self.role = 'host'; room.room.hostParticipantId = MEMBER_ID;
      room.participants = room.participants.map((participant) => ({ ...participant,
        role: participant.participantId === MEMBER_ID ? 'host' : 'member' }));
    }
    socket.message(room); await pump();
    return { socket, room, emit, local, apply, unsubscribe };
  }

  it('serializes host controls, uses acknowledged revisions and coalesces rapid seeks without HTTP per frame', async () => {
    const { socket, room, emit, local } = await connectPort();
    const commands = () => socket.sent.map((raw) => JSON.parse(raw)).filter((message) => message.type === 'playback.command');
    emit({ kind: 'seek', snapshot: { ...local, positionSeconds: 42 } });
    emit({ kind: 'seek', snapshot: { ...local, positionSeconds: 60 } });
    emit({ kind: 'seek', snapshot: { ...local, positionSeconds: 84 } });
    emit({ kind: 'play', snapshot: { ...local, positionSeconds: 84 } });
    expect(commands()).toHaveLength(1);
    expect(commands()[0]).toMatchObject({ baseRevision: 0, command: { kind: 'seek', positionSeconds: 42 } });
    socket.message({ v: 1, type: 'playback.state', revision: 1, serverTimeMs: Date.now(),
      playback: { ...room.playback, revision: 1, positionSeconds: 42 } });
    socket.message({ v: 1, type: 'server.ack', requestId: commands()[0].requestId, revision: 1, serverTimeMs: Date.now() });
    expect(commands()).toHaveLength(2);
    expect(commands()[1]).toMatchObject({ baseRevision: 1, command: { kind: 'seek', positionSeconds: 84 } });
    socket.message({ v: 1, type: 'playback.state', revision: 2, serverTimeMs: Date.now(),
      playback: { ...room.playback, revision: 2, positionSeconds: 84 } });
    socket.message({ v: 1, type: 'server.ack', requestId: commands()[1].requestId, revision: 2, serverTimeMs: Date.now() });
    expect(commands()).toHaveLength(3);
    expect(commands()[2]).toMatchObject({ baseRevision: 2, command: { kind: 'play' } });
    socket.message({ v: 1, type: 'playback.state', revision: 3, serverTimeMs: Date.now(),
      playback: { ...room.playback, revision: 3, positionSeconds: 84, mode: 'playing' } });
    socket.message({ v: 1, type: 'server.ack', requestId: commands()[2].requestId, revision: 3, serverTimeMs: Date.now() });
    await pump(); await vi.advanceTimersByTimeAsync(5_000); await pump();
    expect(harness.fetch).toHaveBeenCalledOnce(); expect(commands()).toHaveLength(3);
  });

  it.each(['host', 'member'] as const)('applies authoritative snapshots to a %s without broadcasting local playback', async (role) => {
    const { socket, apply, emit, local } = await connectPort(role);
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ mode: 'paused', positionSeconds: 12, seek: true }));
    expect(socket.sent.map((raw) => JSON.parse(raw)).filter((message) => message.type === 'playback.command')).toHaveLength(0);
    if (role === 'member') {
      emit({ kind: 'play', snapshot: local });
      expect(socket.sent.map((raw) => JSON.parse(raw)).filter((message) => message.type === 'playback.command')).toHaveLength(0);
    }
  });

  it('discards queued host controls on transfer and on disconnect instead of replaying stale intentions', async () => {
    const { socket, emit, local } = await connectPort();
    emit({ kind: 'seek', snapshot: local }); emit({ kind: 'play', snapshot: local });
    const command = socket.sent.map((raw) => JSON.parse(raw)).find((message) => message.type === 'playback.command');
    socket.message({ v: 1, type: 'host.changed', revision: 1, serverTimeMs: Date.now(),
      previousHostParticipantId: MEMBER_ID, hostParticipantId: HOST_ID });
    socket.message({ v: 1, type: 'server.ack', requestId: command.requestId, revision: 0, serverTimeMs: Date.now() });
    await pump(); emit({ kind: 'play', snapshot: local });
    expect(socket.sent.map((raw) => JSON.parse(raw)).filter((message) => message.type === 'playback.command')).toHaveLength(1);
    socket.networkClose(); await pump();
    expect(session.state.phase).toBe('reconnecting'); expect(session.sendChat('offline')).toBe(false);
    expect(session.transferHost(HOST_ID)).toBe(false);
  });

  it('does not let queued host controls or subscriptions survive unmount', async () => {
    const { emit, local, apply, unsubscribe } = await connectPort();
    emit({ kind: 'seek', snapshot: local }); emit({ kind: 'play', snapshot: local });
    unmount(); harness.dirty = false;
    await vi.advanceTimersByTimeAsync(20_000); await pump();
    expect(unsubscribe).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
    expect(harness.fetch).toHaveBeenCalledOnce(); expect(harness.dirty).toBe(false);
    expect(apply).toHaveBeenCalled();
  });
});
