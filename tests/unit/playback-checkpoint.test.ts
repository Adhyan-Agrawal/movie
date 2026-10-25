import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  playbackMediaKey,
  markPlaybackCheckpointSynced,
  readPlaybackCheckpoint,
  writePlaybackCheckpoint,
} from '@/features/playback/playback-checkpoint';

const STORAGE_KEY = 'lumora:playback-checkpoints:v1';
const NOW = Date.UTC(2026, 9, 25);
let storage: Map<string, string>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  storage = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('playbackMediaKey', () => {
  it('separates titles, episodes and coordinate fallbacks without delimiter collisions', () => {
    const keys = [
      playbackMediaKey('one'), playbackMediaKey('two'),
      playbackMediaKey('one', 'ep1'), playbackMediaKey('one', 'ep2'),
      playbackMediaKey('two', 'ep1'), playbackMediaKey('one', undefined, 1, 1),
      playbackMediaKey('one', undefined, 1, 2), playbackMediaKey('one', undefined, 2, 1),
      playbackMediaKey('a:b', 'c'), playbackMediaKey('a', 'b:c'),
    ];
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.every(Boolean)).toBe(true);
  });

  it('uses the episode ID regardless of optional display coordinates', () => {
    expect(playbackMediaKey('one', 'ep1', 1, 2)).toBe(playbackMediaKey('one', 'ep1'));
    expect(playbackMediaKey('one', undefined, 0, 1)).not.toBe('');
  });

  it('rejects incomplete or invalid media identities', () => {
    expect(playbackMediaKey('')).toBe('');
    expect(playbackMediaKey('one', '')).toBe('');
    expect(playbackMediaKey('one', undefined, 1)).toBe('');
    expect(playbackMediaKey('one', undefined, Number.NaN, 1)).toBe('');
    expect(playbackMediaKey('one', undefined, -1, 1)).toBe('');
    expect(playbackMediaKey('one', undefined, 1, 0)).toBe('');
  });
});

describe('playback checkpoints', () => {
  it('keeps a newer rewind pending when an older server report is acknowledged', () => {
    const key = playbackMediaKey('one');
    const previous = writePlaybackCheckpoint('account:a', key, 60, 100, true)!;
    const rewind = writePlaybackCheckpoint('account:a', key, 0, 100, true)!;
    markPlaybackCheckpointSynced('account:a', key, previous);
    expect(readPlaybackCheckpoint('account:a', key)).toMatchObject({ positionSeconds: 0, pendingSync: true });
    markPlaybackCheckpointSynced('account:b', key, rewind);
    expect(readPlaybackCheckpoint('account:a', key)?.pendingSync).toBe(true);
    markPlaybackCheckpointSynced('account:a', key, rewind);
    expect(readPlaybackCheckpoint('account:a', key)?.pendingSync).toBeUndefined();
  });

  it('persists unsynced points across reloads and ignores stale-duration acknowledgements', () => {
    const key = playbackMediaKey('one');
    const point = writePlaybackCheckpoint('account:a', key, 12.5, 100, true)!;
    expect(JSON.parse(storage.get(STORAGE_KEY)!)[0].pendingSync).toBe(true);
    markPlaybackCheckpointSynced('account:a', key, { ...point, durationSeconds: 200 });
    expect(readPlaybackCheckpoint('account:a', key)?.pendingSync).toBe(true);
    markPlaybackCheckpointSynced('account:a', key, point);
    expect(readPlaybackCheckpoint('account:a', key)).toEqual({ positionSeconds: 12.5, durationSeconds: 100, updatedAt: NOW });
  });

  it('round-trips exact fractional positions and comparable timestamps synchronously', () => {
    const key = playbackMediaKey('one');
    const point = { positionSeconds: 12.375, durationSeconds: 900, updatedAt: NOW };
    expect(writePlaybackCheckpoint('guest', key, 12.375, 900)).toEqual(point);
    expect(readPlaybackCheckpoint('guest', key)).toEqual(point);
    expect(writePlaybackCheckpoint('guest', key, 0, 0)).toEqual({ positionSeconds: 0, updatedAt: NOW });
    expect(readPlaybackCheckpoint('guest', key)?.positionSeconds).toBe(0);
  });

  it('isolates guests, accounts, profiles and exact episodes', () => {
    const viewers = ['guest', 'account:a', 'account:a:profile:1', 'account:a:profile:2', 'account:b:profile:1'];
    const keys = [playbackMediaKey('one'), playbackMediaKey('one', 'ep1'), playbackMediaKey('one', 'ep2')];
    for (const [viewerIndex, viewer] of viewers.entries()) {
      for (const [mediaIndex, key] of keys.entries()) {
        writePlaybackCheckpoint(viewer, key, 1 + viewerIndex * 10 + mediaIndex);
      }
    }
    for (const [viewerIndex, viewer] of viewers.entries()) {
      for (const [mediaIndex, key] of keys.entries()) {
        expect(readPlaybackCheckpoint(viewer, key)?.positionSeconds).toBe(1 + viewerIndex * 10 + mediaIndex);
      }
    }
    expect(readPlaybackCheckpoint('account:c', keys[0]!)).toBeNull();
    expect(readPlaybackCheckpoint('guest', playbackMediaKey('two'))).toBeNull();
  });

  it.each([Number.NaN, Infinity, -Infinity, -1, Number.MAX_VALUE, '2' as unknown as number])(
    'rejects invalid position or duration %s without damaging the previous point', (value) => {
      const key = playbackMediaKey('one');
      writePlaybackCheckpoint('guest', key, 4);
      expect(writePlaybackCheckpoint('guest', key, value)).toBeNull();
      expect(writePlaybackCheckpoint('guest', key, 8, value)).toBeNull();
      expect(readPlaybackCheckpoint('guest', key)?.positionSeconds).toBe(4);
    },
  );

  it.each(['unavailable', '', 'account:', 'account:a:profile:', 'profile:1', 'account:a:b']) (
    'disables unknown/invalid viewer scope %s instead of falling back to guest', (viewer) => {
      const key = playbackMediaKey('one');
      expect(writePlaybackCheckpoint(viewer, key, 4)).toBeNull();
      expect(readPlaybackCheckpoint(viewer, key)).toBeNull();
      expect(storage.size).toBe(0);
    },
  );

  it('expires old checkpoints and bounds all scopes together to 100 newest points', () => {
    const oldKey = playbackMediaKey('old');
    writePlaybackCheckpoint('guest', oldKey, 8);
    vi.setSystemTime(NOW + 61 * 24 * 60 * 60 * 1000);
    expect(readPlaybackCheckpoint('guest', oldKey)).toBeNull();
    for (let i = 0; i < 105; i += 1) {
      vi.setSystemTime(NOW + 61 * 24 * 60 * 60 * 1000 + i);
      writePlaybackCheckpoint(`account:${i}`, playbackMediaKey('one'), i);
    }
    expect(JSON.parse(storage.get(STORAGE_KEY)!).length).toBe(100);
    expect(readPlaybackCheckpoint('account:0', playbackMediaKey('one'))).toBeNull();
    expect(readPlaybackCheckpoint('account:104', playbackMediaKey('one'))?.positionSeconds).toBe(104);
  });

  it('ignores malformed, oversized, future-dated and invalid stored data', () => {
    const key = playbackMediaKey('one');
    const valid = { viewerKey: 'guest', mediaKey: key, positionSeconds: 5, updatedAt: NOW };
    for (const raw of ['not-json', '{}', ' '.repeat(256_001), JSON.stringify([
      { ...valid, positionSeconds: -1 }, { ...valid, durationSeconds: -1 },
      { ...valid, updatedAt: NOW + 1 }, { ...valid, updatedAt: 'today' },
      { ...valid, viewerKey: 'unavailable' }, null,
    ])]) {
      storage.set(STORAGE_KEY, raw);
      expect(readPlaybackCheckpoint('guest', key)).toBeNull();
    }
  });

  it('is safe in SSR, private mode and quota failures', () => {
    const key = playbackMediaKey('one');
    vi.stubGlobal('localStorage', undefined);
    expect(readPlaybackCheckpoint('guest', key)).toBeNull();
    expect(writePlaybackCheckpoint('guest', key, 5)).toBeNull();
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('quota'); },
    });
    expect(readPlaybackCheckpoint('guest', key)).toBeNull();
    expect(writePlaybackCheckpoint('guest', key, 5)).toBeNull();
  });

  it('does not carry arbitrary stored fields into subsequent writes', () => {
    const key = playbackMediaKey('one');
    storage.set(STORAGE_KEY, JSON.stringify([{
      viewerKey: 'guest', mediaKey: key, positionSeconds: 5, updatedAt: NOW,
      unexpected: 'x'.repeat(100_000),
    }]));
    writePlaybackCheckpoint('account:a', key, 8);
    expect(storage.get(STORAGE_KEY)?.length).toBeLessThan(1_000);
    expect(readPlaybackCheckpoint('guest', key)?.positionSeconds).toBe(5);
  });

  it('bounds encoded storage even for heavily escaped opaque media keys', () => {
    for (let i = 0; i < 100; i += 1) {
      writePlaybackCheckpoint('guest', `\u0000`.repeat(500) + i, i);
    }
    expect(storage.get(STORAGE_KEY)!.length).toBeLessThanOrEqual(256_000);
    expect(readPlaybackCheckpoint('guest', `\u0000`.repeat(500) + 99)?.positionSeconds).toBe(99);
  });
});
