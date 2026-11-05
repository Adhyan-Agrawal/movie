import { describe, expect, it, vi } from 'vitest';
import { PublicDataCache } from '@/features/catalog/public-data-cache';

function cache(now: () => number, maxEntries = 3) {
  return new PublicDataCache<number[]>({
    maxEntries,
    maxPending: 4,
    positiveTtlMs: 100,
    negativeTtlMs: 20,
    staleTtlMs: 200,
    negativeStaleTtlMs: 30,
    errorRetryMs: 10,
    now,
  });
}

describe('bounded public data cache', () => {
  it('reuses resolved data, coalesces in-flight loads, expires it, and caps LRU entries', async () => {
    let now = 0;
    const subject = cache(() => now, 2);
    const load = vi.fn(async () => [1]);
    const [first, second] = await Promise.all([subject.read('a', load), subject.read('a', load)]);
    expect(second).toBe(first);
    expect(load).toHaveBeenCalledTimes(1);
    now = 99;
    await subject.read('a', load);
    expect(load).toHaveBeenCalledTimes(1);
    now = 100;
    await subject.read('a', load);
    expect(load).toHaveBeenCalledTimes(2);
    await subject.read('b', async () => [2]);
    await subject.read('c', async () => [3]);
    expect(subject.size).toBe(2);
  });

  it('uses a short negative TTL for valid empty data', async () => {
    let now = 0;
    const subject = cache(() => now);
    const load = vi.fn(async () => [] as number[]);
    const options = { isNegative: (value: number[]) => value.length === 0 };
    await subject.read('empty', load, options);
    now = 19;
    await subject.read('empty', load, options);
    expect(load).toHaveBeenCalledTimes(1);
    now = 20;
    await subject.read('empty', load, options);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('serves previously valid stale data on refresh errors without caching the error', async () => {
    let now = 0;
    const subject = cache(() => now);
    await expect(subject.read('title', async () => [1])).resolves.toEqual([1]);
    now = 101;
    const failure = vi.fn(async (): Promise<number[]> => { throw new Error('upstream unavailable'); });
    await expect(subject.read('title', failure)).resolves.toEqual([1]);
    now = 105;
    await expect(subject.read('title', failure)).resolves.toEqual([1]);
    expect(failure).toHaveBeenCalledTimes(1);
    now = 112;
    await expect(subject.read('title', async () => [2])).resolves.toEqual([2]);
  });

  it('never converts an initial loader error into a cached value', async () => {
    let now = 0;
    const subject = cache(() => now);
    await expect(subject.read('missing', async () => { throw new Error('bad response'); })).rejects.toThrow('bad response');
    now = 1;
    await expect(subject.read('missing', async () => [7])).resolves.toEqual([7]);
  });

  it('does not resurrect invalidated data or remove a newer pending read after clear', async () => {
    const subject = cache(() => 0);
    let finishOld!: (value: number[]) => void;
    let finishNew!: (value: number[]) => void;
    const old = subject.read('title', () => new Promise((resolve) => { finishOld = resolve; }));
    await Promise.resolve();
    subject.clear();
    const load = vi.fn(() => new Promise<number[]>((resolve) => { finishNew = resolve; }));
    const fresh = subject.read('title', load);
    await Promise.resolve();
    finishOld([1]);
    await old;
    const shared = subject.read('title', load);
    finishNew([2]);
    await expect(Promise.all([fresh, shared])).resolves.toEqual([[2], [2]]);
    expect(load).toHaveBeenCalledTimes(1);
    await expect(subject.read('title', async () => [3])).resolves.toEqual([2]);
  });
});
