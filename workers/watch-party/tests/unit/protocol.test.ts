import { describe, expect, it } from 'vitest';
import mediaVectors from '../fixtures/media-identities.json';
import {
  WATCH_PARTY_PROTOCOL_VERSION,
  bestClockOffsetMs,
  clockSample,
  normalizeWatchPartyChat,
  normalizeWatchPartyDisplayName,
  normalizeWatchPartyRoomCode,
  parseWatchPartyClientMessage,
  parseWatchPartyMediaIdentity,
  planWatchPartyDrift,
  projectWatchPartyPosition,
  sameWatchPartyMediaIdentity,
  type WatchPartyPlaybackState,
} from '@watch-party/protocol';

const TITLE_ID = '10000000-0000-4000-8000-000000000001';
const OTHER_TITLE_ID = '10000000-0000-4000-8000-000000000002';
const EPISODE_ID = '10000000-0000-4000-8000-000000000003';

const playback: WatchPartyPlaybackState = {
  media: { kind: 'movie', mediaId: TITLE_ID },
  mode: 'playing',
  positionSeconds: 10,
  playbackRate: 1,
  anchorServerTimeMs: 1_000,
  revision: 7,
};

describe('Watch Party protocol v1', () => {
  it('accepts only explicit canonical catalogue namespaces and preserves UUID identities', () => {
    for (const media of mediaVectors.valid) expect(parseWatchPartyMediaIdentity(media)).toEqual(media);
    for (const media of mediaVectors.invalid) expect(parseWatchPartyMediaIdentity(media)).toBeNull();
    expect(sameWatchPartyMediaIdentity(
      { kind: 'episode', mediaId: 'tmdb:tv:1396', seasonNumber: 1, episodeNumber: 2 },
      { kind: 'episode', mediaId: 'tmdb:tv:1396', seasonNumber: 1, episodeNumber: 3 },
    )).toBe(false);
  });
  it('strictly validates versioned messages and media identities', () => {
    expect(parseWatchPartyMediaIdentity({ kind: 'movie', mediaId: TITLE_ID })).toEqual({
      kind: 'movie', mediaId: TITLE_ID,
    });
    expect(parseWatchPartyMediaIdentity({ kind: 'movie', mediaId: 'https://provider.example/video' })).toBeNull();
    expect(parseWatchPartyMediaIdentity({ kind: 'movie', mediaId: TITLE_ID, provider: 'secret' })).toBeNull();
    expect(parseWatchPartyMediaIdentity({ kind: 'episode', mediaId: TITLE_ID, episodeId: EPISODE_ID }))
      .toEqual({ kind: 'episode', mediaId: TITLE_ID, episodeId: EPISODE_ID });
    expect(parseWatchPartyMediaIdentity({ kind: 'episode', mediaId: TITLE_ID,
      seasonNumber: 2, episodeNumber: 7 })).toEqual({
      kind: 'episode', mediaId: TITLE_ID, seasonNumber: 2, episodeNumber: 7,
    });
    expect(parseWatchPartyMediaIdentity({ kind: 'episode', mediaId: TITLE_ID, episodeId: EPISODE_ID,
      seasonNumber: 2, episodeNumber: 7 })).toEqual({
      kind: 'episode', mediaId: TITLE_ID, episodeId: EPISODE_ID, seasonNumber: 2, episodeNumber: 7,
    });
    expect(parseWatchPartyMediaIdentity({ kind: 'episode', mediaId: TITLE_ID, seasonNumber: 2 })).toBeNull();
    expect(sameWatchPartyMediaIdentity(
      { kind: 'episode', mediaId: TITLE_ID, episodeId: EPISODE_ID, seasonNumber: 2, episodeNumber: 7 },
      { kind: 'episode', mediaId: TITLE_ID, seasonNumber: 2, episodeNumber: 7 },
    )).toBe(true);
    expect(parseWatchPartyClientMessage({
      v: WATCH_PARTY_PROTOCOL_VERSION,
      type: 'playback.command',
      requestId: 'command-1',
      baseRevision: 7,
      command: { kind: 'seek', positionSeconds: 12.5 },
    })).toMatchObject({ ok: true });
    expect(parseWatchPartyClientMessage({ v: 2, type: 'room.leave', requestId: 'leave-1' }))
      .toEqual({ ok: false, code: 'UNSUPPORTED_VERSION' });
    expect(parseWatchPartyClientMessage({ v: 1, type: 'room.leave', requestId: 'leave-1', role: 'host' }))
      .toEqual({ ok: false, code: 'INVALID_MESSAGE' });
    expect(parseWatchPartyClientMessage({ v: 1, type: 'playback.command', requestId: 'freeze-1',
      baseRevision: 7, command: { kind: 'freeze', reason: 'ad-break' } })).toMatchObject({ ok: true });
    expect(parseWatchPartyClientMessage({ v: 1, type: 'playback.command', requestId: 'freeze-2',
      baseRevision: 7, command: { kind: 'freeze', reason: 'host-disconnected' } }))
      .toEqual({ ok: false, code: 'INVALID_MESSAGE' });
  });

  it('normalizes codes and makes participant text inert plain text', () => {
    expect(normalizeWatchPartyRoomCode('abcde-23456')).toBe('ABCDE23456');
    expect(normalizeWatchPartyRoomCode('contains-i')).toBeNull();
    expect(normalizeWatchPartyDisplayName('  <Admin>\u0000  ')).toBe('\u2039Admin\u203a');
    expect(normalizeWatchPartyChat('<img src=x onerror=alert(1)>')).toBe('\u2039img src=x onerror=alert(1)\u203a');
    expect(normalizeWatchPartyChat('x'.repeat(501))).toBeNull();
  });

  it('selects the lowest-RTT clock sample deterministically', () => {
    const slow = clockSample(1_000, 1_200, 1_150)!;
    const fast = clockSample(2_000, 2_040, 2_070)!;
    expect(slow).toEqual({ roundTripMs: 200, offsetMs: 50, receivedAtMs: 1_200 });
    expect(fast.offsetMs).toBe(50);
    expect(bestClockOffsetMs([slow, fast])).toBe(50);
    expect(projectWatchPartyPosition(playback, 2_000, [fast])).toBeCloseTo(11.05, 5);
  });

  it('produces deterministic no-op, rate, and hard-sync drift plans', () => {
    const common = {
      playback,
      localMedia: playback.media,
      localMode: 'playing' as const,
      localNowMs: 2_000,
      clockSamples: [] as const,
    };
    expect(planWatchPartyDrift({ ...common, localPositionSeconds: 11.1 }).kind).toBe('none');
    const rate = planWatchPartyDrift({ ...common, localPositionSeconds: 10.4 });
    expect(rate.kind).toBe('rate');
    if (rate.kind === 'rate') expect(rate.playbackRate).toBeGreaterThan(1);
    expect(planWatchPartyDrift({ ...common, localPositionSeconds: 8 }).kind).toBe('hard-sync');
    expect(planWatchPartyDrift({ ...common, localPositionSeconds: 11,
      localMedia: { kind: 'movie', mediaId: OTHER_TITLE_ID } })).toMatchObject({ kind: 'hard-sync', reason: 'media' });
  });

  it('uses correction hysteresis and never projects frozen playback', () => {
    const common = {
      playback,
      localMedia: playback.media,
      localMode: 'playing' as const,
      localNowMs: 2_000,
      clockSamples: [] as const,
    };
    expect(planWatchPartyDrift({ ...common, localPositionSeconds: 10.8,
      correctionState: 'stable' })).toMatchObject({ kind: 'none', correctionState: 'stable' });
    expect(planWatchPartyDrift({ ...common, localPositionSeconds: 10.8,
      correctionState: 'correcting' })).toMatchObject({ kind: 'rate', correctionState: 'correcting' });
    expect(planWatchPartyDrift({ ...common, localPositionSeconds: 10.95,
      correctionState: 'correcting' })).toMatchObject({ kind: 'none', correctionState: 'stable' });

    const frozen: WatchPartyPlaybackState = { ...playback, mode: 'frozen',
      freezeReason: 'background', positionSeconds: 12 };
    expect(projectWatchPartyPosition(frozen, 20_000, [])).toBe(12);
    expect(planWatchPartyDrift({ playback: frozen, localMedia: frozen.media, localMode: 'paused',
      localPositionSeconds: 12, localNowMs: 20_000, clockSamples: [] }))
      .toMatchObject({ kind: 'hard-sync', reason: 'status', mode: 'frozen', freezeReason: 'background' });
  });
});
