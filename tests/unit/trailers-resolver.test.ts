import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTrailerResolver, normalizeBingrTrailer } from '@/features/trailers/resolver';

const NOW = Date.UTC(2026, 10, 4, 12);
const LIMIT = 64 * 1024;
const media = (quality = '720p', seconds = NOW / 1000 + 600) => ({ url: `https://imdb-video.media-imdb.com/qa-${quality}.mp4?Expires=${seconds}`, mime: 'MP4', quality });
const payload = () => ({ provider: 'imdb', contentType: 'Trailer', name: 'Synthetic QA trailer', mp4: media(), all: [media(), media('480p')] });
const json = (value: unknown = payload()) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('Bingr trailer normalization', () => {
  it('keeps 720p for the dialog and selects the actual 480p variant for hover', () => {
    const result = normalizeBingrTrailer(payload(), NOW);
    expect(Boolean(result)).toBe(true);
    expect(new URL(result!.url).pathname).toBe('/qa-720p.mp4');
    expect(new URL(result!.previewUrl).pathname).toBe('/qa-480p.mp4');
    expect(result?.mime).toBe('video/mp4');
    expect(result?.expiresAt).toBe(NOW + 570_000);
  });

  it('uses the earliest selected media expiry minus the safety margin', () => {
    const result = normalizeBingrTrailer({ ...payload(), all: [media('480p', NOW / 1000 + 120)] }, NOW);
    expect(result?.expiresAt).toBe(NOW + 90_000);
    expect(normalizeBingrTrailer({ ...payload(), mp4: media('720p', NOW / 1000 + 30) }, NOW) === null).toBe(true);
  });

  it('caps signed freshness at one hour and unsigned media at five minutes', () => {
    expect(normalizeBingrTrailer({ ...payload(), mp4: media('720p', NOW / 1000 + 10_000), all: [] }, NOW)?.expiresAt).toBe(NOW + 3_600_000);
    expect(normalizeBingrTrailer({ ...payload(), mp4: { ...media(), url: 'https://imdb-video.media-imdb.com/qa.mp4' }, all: [] }, NOW)?.expiresAt).toBe(NOW + 300_000);
  });

  it('accepts 360p as the lower-bandwidth fallback when 480p is absent', () => {
    const result = normalizeBingrTrailer({ ...payload(), all: [media('360p')] }, NOW);
    expect(new URL(result!.previewUrl).pathname).toBe('/qa-360p.mp4');
  });

  it.each([null, [], { provider: 'other' }, { contentType: 'Clip' }, { name: '' }, { name: 'a'.repeat(201) }, { name: 'bad\0name' },
    { all: {} }, { all: Array.from({ length: 17 }, () => media()) }, { mp4: null, all: [] },
  ])('rejects wrong envelopes and bounded metadata violations #%#', (override) => {
    const input = override === null || Array.isArray(override) ? override : { ...payload(), ...override };
    expect(normalizeBingrTrailer(input, NOW) === null).toBe(true);
  });

  it('rejects untrusted video and non-MP4 variants without returning proxy URLs', () => {
    for (const mp4 of [{ ...media(), url: 'https://attacker.invalid/qa.mp4' }, { ...media(), mime: 'HLS' }, { ...media(), url: '/api/vidnest?token=synthetic' }]) {
      expect(normalizeBingrTrailer({ ...payload(), mp4, all: [] }, NOW) === null).toBe(true);
    }
  });

  it('rejects expired and malformed signature timestamps', () => {
    for (const expires of ['0', 'garbage', String(NOW / 1000 - 1)]) {
      expect(normalizeBingrTrailer({ ...payload(), mp4: { ...media(), url: `https://imdb-video.media-imdb.com/qa.mp4?Expires=${expires}` }, all: [] }, NOW) === null).toBe(true);
    }
  });

  it('rejects ambiguous duplicate signature expiry parameters', () => {
    const mp4 = { ...media(), url: `${media().url}&Expires=${NOW / 1000 - 1}` };
    expect(normalizeBingrTrailer({ ...payload(), mp4, all: [] }, NOW) === null).toBe(true);
  });
});

describe('bounded public trailer resolver', () => {
  it('does one public metadata GET and never fetches MP4 bytes or forwards private headers', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => json());
    const resolve = createTrailerResolver({ fetchImpl, now: () => NOW });
    expect(Boolean(await resolve('tt9000001'))).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [input, init] = fetchImpl.mock.calls[0];
    const url = new URL(String(input));
    expect(url.origin).toBe('https://bingr.one');
    expect(url.pathname).toBe('/api/trailer/imdb/tt9000001');
    expect(url.searchParams.get('prefer')).toBe('oldest');
    expect(init?.credentials).toBe('omit');
    expect(init?.redirect).toBe('manual');
    expect(init?.cache).toBe('no-store');
    expect(Array.from(new Headers(init?.headers).keys())).toEqual(['accept']);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reuses plain results only until actual signed expiry', async () => {
    let now = NOW;
    const fetchImpl = vi.fn(async () => json({ ...payload(), mp4: media('720p', NOW / 1000 + 90), all: [] }));
    const resolve = createTrailerResolver({ fetchImpl, now: () => now });
    const first = await resolve('tt9000001');
    now += 59_999;
    expect(await resolve('tt9000001')).toBe(first);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now += 1;
    expect(await resolve('tt9000001') === null).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([302, 307, 308, 401, 429, 500, 503])('does not follow HTTP %i or cache the error', async (status) => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 });
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(body, { status, headers: { Location: 'https://private.invalid/metadata' } })).mockResolvedValueOnce(json());
    const resolve = createTrailerResolver({ fetchImpl, now: () => NOW });
    expect(await resolve('tt9000001') === null).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(Boolean(await resolve('tt9000001'))).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not cache malformed JSON, malformed envelopes, expired video, or transport errors', async () => {
    for (const failure of [new Response('{'), json({ provider: 'other' }), json({ ...payload(), mp4: media('720p', NOW / 1000 - 1), all: [] })]) {
      const fetchImpl = vi.fn().mockResolvedValueOnce(failure).mockResolvedValueOnce(json());
      const resolve = createTrailerResolver({ fetchImpl, now: () => NOW });
      expect(await resolve('tt9000001') === null).toBe(true);
      expect(Boolean(await resolve('tt9000001'))).toBe(true);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    }
    const fetchImpl = vi.fn().mockRejectedValueOnce(new Error('synthetic transport outage')).mockResolvedValueOnce(json());
    const resolve = createTrailerResolver({ fetchImpl, now: () => NOW });
    await resolve('tt9000001');
    expect(Boolean(await resolve('tt9000001'))).toBe(true);
  });

  it('cancels an oversized declared body before reading it', async () => {
    const pull = vi.fn();
    const cancel = vi.fn();
    const fetchImpl = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 }), { headers: { 'Content-Length': String(LIMIT + 1) } }));
    expect(await createTrailerResolver({ fetchImpl })('tt9000001') === null).toBe(true);
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('enforces the streamed byte cap without reading the tail', async () => {
    let pulls = 0;
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { pulls += 1; controller.enqueue(new Uint8Array(32_769).fill(32)); }, cancel }, { highWaterMark: 0 });
    const fetchImpl = vi.fn(async () => new Response(stream));
    expect(await createTrailerResolver({ fetchImpl })('tt9000001') === null).toBe(true);
    expect(pulls).toBe(2);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('accepts exactly 64 KiB of valid metadata including padding', async () => {
    const text = JSON.stringify(payload());
    const fetchImpl = vi.fn(async () => new Response(text.padEnd(LIMIT, ' ')));
    expect(Boolean(await createTrailerResolver({ fetchImpl, now: () => NOW })('tt9000001'))).toBe(true);
  });

  it('rejects invalid IDs and an already aborted caller without any fetch', async () => {
    const fetchImpl = vi.fn();
    const resolve = createTrailerResolver({ fetchImpl });
    expect(await resolve('tt1') === null).toBe(true);
    const controller = new AbortController(); controller.abort();
    expect(await resolve('tt9000001', controller.signal) === null).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(['caller', 'timeout'])('aborts a pending fetch on %s and clears the deadline', async (reason) => {
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_done, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Synthetic cancellation', 'AbortError')), { once: true });
    }));
    const resolve = createTrailerResolver({ fetchImpl });
    const caller = new AbortController();
    const pending = resolve('tt9000001', caller.signal);
    if (reason === 'caller') caller.abort(); else await vi.advanceTimersByTimeAsync(4_500);
    expect(await pending === null).toBe(true);
    expect(fetchImpl.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts and cancels a hanging streamed response body', async () => {
    const cancel = vi.fn();
    const fetchImpl = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 })));
    const caller = new AbortController();
    const pending = createTrailerResolver({ fetchImpl })('tt9000001', caller.signal);
    await Promise.resolve(); await Promise.resolve(); caller.abort();
    expect(await pending === null).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds plain cached entries to 128', async () => {
    const fetchImpl = vi.fn(async () => json());
    const resolve = createTrailerResolver({ fetchImpl, now: () => NOW });
    for (let id = 9_000_001; id <= 9_000_129; id += 1) await resolve(`tt${id}`);
    await resolve('tt9000001');
    expect(fetchImpl).toHaveBeenCalledTimes(130);
  });
});
