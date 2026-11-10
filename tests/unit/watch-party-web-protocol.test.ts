import { afterEach, describe, expect, it, vi } from 'vitest';
import mediaVectors from '../../workers/watch-party/tests/fixtures/media-identities.json';
import {
  planWatchPartyDrift,
  type WatchPartyRoomSnapshotMessage,
} from '@/features/watch-party/protocol';
import { decodeWatchPartyServerMessage } from '@/features/watch-party/web/codec';
import {
  INITIAL_WATCH_PARTY_STATE,
  reduceWatchPartyServerMessage,
} from '@/features/watch-party/web/reducer';
import {
  buildWatchPartyInviteUrl,
  clearWatchPartyResume,
  readWatchPartyResume,
  writeWatchPartyResume,
} from '@/features/watch-party/web/session-storage';

const HOST_ID = '10000000-0000-4000-8000-000000000001';
const MEMBER_ID = '10000000-0000-4000-8000-000000000002';
const TITLE_ID = '10000000-0000-4000-8000-000000000003';
const MESSAGE_ID = '10000000-0000-4000-8000-000000000004';

afterEach(() => vi.unstubAllGlobals());

function snapshot(): WatchPartyRoomSnapshotMessage {
  return {
    v: 1,
    type: 'room.snapshot',
    serverTimeMs: 1_050,
    room: {
      roomCode: 'ABCDE23456',
      revision: 2,
      createdAtMs: 100,
      expiresAtMs: 50_000,
      hostParticipantId: HOST_ID,
    },
    self: { participantId: MEMBER_ID, role: 'member', resumeToken: 'wp1.resume.signature' },
    playback: {
      media: { kind: 'movie', mediaId: TITLE_ID },
      mode: 'paused',
      positionSeconds: 12,
      playbackRate: 1,
      anchorServerTimeMs: 1_000,
      revision: 0,
    },
    participants: [
      { participantId: HOST_ID, displayName: 'Host', role: 'host', connected: true, joinedAtMs: 100 },
      { participantId: MEMBER_ID, displayName: 'Viewer', role: 'member', connected: true, joinedAtMs: 200 },
    ],
    chat: [],
  };
}

describe('Watch Party web protocol vectors', () => {
  it('decodes public TMDB room identities without relaxing snapshot or participant validation', () => {
    for (const media of mediaVectors.valid) {
      expect(decodeWatchPartyServerMessage({ ...snapshot(), playback: { ...snapshot().playback, media } })).toMatchObject({ ok: true });
    }
    for (const media of mediaVectors.invalid) {
      expect(decodeWatchPartyServerMessage({ ...snapshot(), playback: { ...snapshot().playback, media } })).toEqual({ ok: false });
    }
    expect(decodeWatchPartyServerMessage({ ...snapshot(), self: { ...snapshot().self, participantId: 'tmdb:movie:27205' } })).toEqual({ ok: false });
  });
  it('strictly decodes the frozen mode/freeze and episode-coordinate shapes', () => {
    expect(decodeWatchPartyServerMessage(snapshot())).toMatchObject({ ok: true });
    const frozen = {
      v: 1,
      type: 'playback.state',
      revision: 3,
      serverTimeMs: 2_000,
      playback: {
        media: {
          kind: 'episode',
          mediaId: TITLE_ID,
          episodeId: MESSAGE_ID,
          seasonNumber: 1,
          episodeNumber: 2,
        },
        mode: 'frozen',
        freezeReason: 'host-disconnected',
        positionSeconds: 42,
        playbackRate: 1,
        anchorServerTimeMs: 2_000,
        revision: 3,
      },
    };
    expect(decodeWatchPartyServerMessage(frozen)).toMatchObject({ ok: true });
    expect(decodeWatchPartyServerMessage({
      ...frozen,
      playback: { ...frozen.playback, mode: 'paused', freezeReason: 'host-disconnected' },
    })).toEqual({ ok: false });
    expect(decodeWatchPartyServerMessage({
      ...frozen,
      playback: { ...frozen.playback, freezeReason: 'client-invented' },
    })).toEqual({ ok: false });
  });

  it('requests replay on a revision gap and applies a contiguous replay once', () => {
    const initial = reduceWatchPartyServerMessage(INITIAL_WATCH_PARTY_STATE, snapshot(), 1_100);
    const gap = {
      v: 1 as const,
      type: 'chat.message' as const,
      revision: 4,
      serverTimeMs: 1_400,
      message: {
        messageId: MESSAGE_ID,
        participantId: MEMBER_ID,
        displayName: 'Viewer',
        text: 'Hello',
        format: 'plain' as const,
        revision: 4,
        serverTimeMs: 1_400,
      },
    };
    const waiting = reduceWatchPartyServerMessage(initial, gap, 1_450);
    expect(waiting.syncFromRevision).toBe(2);
    expect(waiting.chat).toHaveLength(0);
    const replay = {
      v: 1 as const,
      type: 'room.replay' as const,
      fromRevision: 2,
      revision: 4,
      serverTimeMs: 1_500,
      events: [
        {
          v: 1 as const,
          type: 'presence.state' as const,
          revision: 3,
          serverTimeMs: 1_300,
          hostParticipantId: HOST_ID,
          participants: snapshot().participants,
        },
        gap,
      ],
    };
    const synchronized = reduceWatchPartyServerMessage(waiting, replay, 1_550);
    expect(synchronized.room?.revision).toBe(4);
    expect(synchronized.syncFromRevision).toBeNull();
    expect(synchronized.chat.map((message) => message.text)).toEqual(['Hello']);
    expect(reduceWatchPartyServerMessage(synchronized, replay, 1_600).chat).toHaveLength(1);
  });

  it('does not rewind state for a delayed snapshot or already superseded replay', () => {
    const current = reduceWatchPartyServerMessage(INITIAL_WATCH_PARTY_STATE, snapshot(), 1_100);
    const old = { ...snapshot(), room: { ...snapshot().room, revision: 1 } };
    expect(reduceWatchPartyServerMessage(current, old, 1_200)).toBe(current);
    expect(reduceWatchPartyServerMessage(current, { v: 1, type: 'room.replay', fromRevision: 0,
      revision: 1, serverTimeMs: 1_200, events: [] }, 1_200)).toBe(current);
    const duplicateHost = snapshot();
    duplicateHost.participants[1]!.role = 'host'; duplicateHost.self.role = 'host';
    expect(decodeWatchPartyServerMessage(duplicateHost)).toEqual({ ok: false });
  });

  it('records RTT samples and preserves drift-correction hysteresis', () => {
    const connected = reduceWatchPartyServerMessage(INITIAL_WATCH_PARTY_STATE, snapshot(), 1_100);
    const sampled = reduceWatchPartyServerMessage(connected, {
      v: 1,
      type: 'server.pong',
      requestId: 'ping-1',
      clientSentAtMs: 2_000,
      serverTimeMs: 2_070,
    }, 2_040);
    expect(sampled.clockSamples).toEqual([{ roundTripMs: 40, offsetMs: 50, receivedAtMs: 2_040 }]);
    const playback = { ...snapshot().playback, mode: 'playing' as const, freezeReason: undefined,
      positionSeconds: 10, anchorServerTimeMs: 1_000 };
    const entering = planWatchPartyDrift({ playback, localMedia: playback.media,
      localPositionSeconds: 10.6, localMode: 'playing', localNowMs: 2_000, clockSamples: [] });
    expect(entering).toMatchObject({ kind: 'rate', correctionState: 'correcting' });
    const staying = planWatchPartyDrift({ playback, localMedia: playback.media,
      localPositionSeconds: 10.85, localMode: 'playing', localNowMs: 2_000, clockSamples: [],
      correctionState: 'correcting' });
    expect(staying).toMatchObject({ kind: 'rate', correctionState: 'correcting' });
    const stable = planWatchPartyDrift({ playback, localMedia: playback.media,
      localPositionSeconds: 10.95, localMode: 'playing', localNowMs: 2_000, clockSamples: [],
      correctionState: 'correcting' });
    expect(stable).toMatchObject({ kind: 'none', correctionState: 'stable' });
  });

  it('builds token-free invite URLs and bounds session resume storage', () => {
    expect(buildWatchPartyInviteUrl(
      'https://app.example/watch/tv/show?season=1&episode=2&token=secret#fragment',
      'ABCDE23456',
    )).toBe('https://app.example/watch/tv/show?season=1&episode=2&party=ABCDE23456');
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    } as unknown as Storage;
    const stored = writeWatchPartyResume(storage, snapshot(), 1_000);
    expect(readWatchPartyResume(storage, 1_001)).toEqual(stored);
    expect(readWatchPartyResume(storage, stored.expiresAtMs)).toBeNull();
  });

  it('catches the browser sessionStorage getter for restore, write and clear without losing a valid in-memory resume', () => {
    const window = Object.defineProperty({}, 'sessionStorage', { get() { throw new Error('Storage getter blocked'); } });
    vi.stubGlobal('window', window);
    expect(readWatchPartyResume()).toBeNull();
    expect(() => clearWatchPartyResume()).not.toThrow();
    expect(writeWatchPartyResume(undefined, snapshot(), 1_000)).toMatchObject({ roomCode: 'ABCDE23456', resumeToken: 'wp1.resume.signature' });
  });

  it('guards throwing storage methods and expired-token removal as well as missing browser storage', () => {
    const storage = { getItem() { throw new Error('Read blocked'); }, setItem() { throw new Error('Write blocked'); },
      removeItem() { throw new Error('Clear blocked'); } } as unknown as Storage;
    vi.stubGlobal('window', { sessionStorage: storage });
    expect(readWatchPartyResume()).toBeNull(); expect(() => clearWatchPartyResume()).not.toThrow();
    const stored = writeWatchPartyResume(undefined, snapshot(), 1_000);
    vi.stubGlobal('window', { sessionStorage: { ...storage, getItem: () => JSON.stringify(stored) } });
    expect(readWatchPartyResume(undefined, stored.expiresAtMs)).toBeNull();
    vi.stubGlobal('window', undefined);
    expect(readWatchPartyResume()).toBeNull(); expect(() => clearWatchPartyResume()).not.toThrow();
    expect(() => writeWatchPartyResume(undefined, snapshot(), 1_000)).not.toThrow();
  });
});
