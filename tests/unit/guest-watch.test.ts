import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readGuestEntries, recordGuestWatch, updateGuestPosition } from '@/features/playback/guest-watch';

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

describe('guest watch metadata and resume', () => {
  it('refreshes movie metadata without resetting fractional position or progress', () => {
    recordGuestWatch({ slug: 'one', type: 'movie', name: 'Old name' });
    updateGuestPosition('one', 12.375, 100);
    vi.setSystemTime(NOW + 1);
    recordGuestWatch({ slug: 'one', type: 'movie', name: 'New name', posterUrl: '/new.jpg' });
    expect(readGuestEntries()).toEqual([{
      slug: 'one', type: 'movie', name: 'New name', posterUrl: '/new.jpg',
      positionSeconds: 12.375, progress: 0.12375, updatedAt: NOW + 1,
    }]);
  });

  it('preserves progress only on the SAME episode, with ID authoritative over coordinates', () => {
    const entry = { slug: 'one', type: 'tv' as const, name: 'TV', episodeId: 'ep1', seasonNumber: 1, episodeNumber: 1 };
    recordGuestWatch(entry);
    updateGuestPosition('one', 22, 100, { episodeId: 'ep1' });
    recordGuestWatch({ ...entry, name: 'Refreshed' });
    expect(readGuestEntries()[0]).toMatchObject({ name: 'Refreshed', positionSeconds: 22, progress: 0.22, seasonNumber: 1 });
    recordGuestWatch({ ...entry, episodeId: 'ep2', episodeNumber: 2 });
    expect(readGuestEntries()[0]?.positionSeconds).toBeUndefined();
    expect(readGuestEntries()[0]?.progress).toBeUndefined();
    updateGuestPosition('one', 55, 100, { episodeId: 'ep1' });
    expect(readGuestEntries()[0]?.positionSeconds).toBeUndefined();
    updateGuestPosition('one', 7, undefined, { episodeId: 'ep2' });
    expect(readGuestEntries()[0]?.positionSeconds).toBe(7);
    expect(readGuestEntries()[0]?.progress).toBeUndefined();
  });

  it('matches exact fallback season/episode coordinates when no ID exists', () => {
    const entry = { slug: 'one', type: 'tv' as const, name: 'TV', seasonNumber: 1, episodeNumber: 1 };
    recordGuestWatch(entry);
    updateGuestPosition('one', 14, 100, { seasonNumber: 1, episodeNumber: 1 });
    recordGuestWatch(entry);
    expect(readGuestEntries()[0]?.positionSeconds).toBe(14);
    recordGuestWatch({ ...entry, seasonNumber: 2 });
    expect(readGuestEntries()[0]?.positionSeconds).toBeUndefined();
    updateGuestPosition('one', 88, 100);
    expect(readGuestEntries()[0]?.positionSeconds).toBeUndefined();
  });

  it('retains the same episode position when optional metadata loses or changes its ID', () => {
    recordGuestWatch({ slug: 'one', type: 'tv', name: 'TV', episodeId: 'ep1', seasonNumber: 1, episodeNumber: 1 });
    updateGuestPosition('one', 42.25, 100, { episodeId: 'ep1', seasonNumber: 1, episodeNumber: 1 });
    recordGuestWatch({ slug: 'one', type: 'tv', name: 'TV', seasonNumber: 1, episodeNumber: 1 });
    expect(readGuestEntries()[0]?.positionSeconds).toBe(42.25);
    recordGuestWatch({ slug: 'one', type: 'tv', name: 'TV', episodeId: 'imported-ep1', seasonNumber: 1, episodeNumber: 1 });
    expect(readGuestEntries()[0]?.positionSeconds).toBe(42.25);
    recordGuestWatch({ slug: 'one', type: 'tv', name: 'TV', episodeId: 'ep2', seasonNumber: 1, episodeNumber: 2 });
    expect(readGuestEntries()[0]?.positionSeconds).toBeUndefined();
  });

  it('does not transfer progress between movie and TV entries sharing a slug', () => {
    recordGuestWatch({ slug: 'one', type: 'movie', name: 'Movie', positionSeconds: 20, progress: 0.2 });
    recordGuestWatch({ slug: 'one', type: 'tv', name: 'TV', episodeId: 'ep1' });
    expect(readGuestEntries().find((e) => e.type === 'tv')?.positionSeconds).toBeUndefined();
    updateGuestPosition('one', 5, 100, { episodeId: 'ep1' });
    expect(readGuestEntries().find((e) => e.type === 'tv')?.positionSeconds).toBe(5);
    expect(readGuestEntries().find((e) => e.type === 'movie')?.positionSeconds).toBe(20);
  });

  it('allows an explicit reset to zero on the same media', () => {
    recordGuestWatch({ slug: 'one', type: 'movie', name: 'Movie', positionSeconds: 20, progress: 0.2 });
    recordGuestWatch({ slug: 'one', type: 'movie', name: 'Movie', positionSeconds: 0, progress: 0 });
    expect(readGuestEntries()[0]).toMatchObject({ positionSeconds: 0, progress: 0 });
  });

  it('does not preserve an obsolete fraction when a new position is explicitly supplied', () => {
    recordGuestWatch({ slug: 'one', type: 'movie', name: 'Movie', positionSeconds: 20, progress: 0.2 });
    recordGuestWatch({ slug: 'one', type: 'movie', name: 'Movie', positionSeconds: 0 });
    expect(readGuestEntries()[0]?.positionSeconds).toBe(0);
    expect(readGuestEntries()[0]?.progress).toBeUndefined();
  });

  it.each([Number.NaN, Infinity, -1, '4' as unknown as number])('rejects invalid telemetry %s', (value) => {
    recordGuestWatch({ slug: 'one', type: 'movie', name: 'Movie', positionSeconds: 20, progress: 0.2 });
    updateGuestPosition('one', value, 100);
    updateGuestPosition('one', 9, value);
    recordGuestWatch({ slug: 'one', type: 'movie', name: 'Invalid', positionSeconds: value });
    expect(readGuestEntries()[0]).toMatchObject({ name: 'Movie', positionSeconds: 20, progress: 0.2 });
  });

  it('bounds history and expires old or corrupt entries', () => {
    for (let i = 0; i < 25; i += 1) {
      vi.setSystemTime(NOW + i);
      recordGuestWatch({ slug: String(i), type: 'movie', name: String(i) });
    }
    expect(readGuestEntries()).toHaveLength(20);
    expect(readGuestEntries()[0]?.slug).toBe('24');
    vi.setSystemTime(NOW + 61 * 24 * 60 * 60 * 1000);
    expect(readGuestEntries()).toEqual([]);
    storage.set('lumora:guest-continue-watching', JSON.stringify([
      { slug: 'one', type: 'wrong', name: 'Bad', updatedAt: Date.now() }, null,
    ]));
    expect(readGuestEntries()).toEqual([]);
  });

  it('tolerates unavailable local storage', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(() => recordGuestWatch({ slug: 'one', type: 'movie', name: 'Movie' })).not.toThrow();
    expect(() => updateGuestPosition('one', 5, 100)).not.toThrow();
    expect(readGuestEntries()).toEqual([]);
  });
});
