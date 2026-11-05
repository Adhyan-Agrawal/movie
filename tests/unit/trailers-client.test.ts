import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const NOW = Date.UTC(2026, 10, 4, 12);
const LIMIT = 64 * 1024;
const input = { imdbId: 'tt9000001' };
const info = () => ({ url: `https://imdb-video.media-imdb.com/qa-720p.mp4?Expires=${NOW / 1000 + 600}`, previewUrl: `https://imdb-video.media-imdb.com/qa-480p.mp4?Expires=${NOW / 1000 + 600}`, mime: 'video/mp4', name: 'Synthetic QA trailer', expiresAt: Date.now() + 60_000 });
const json = (trailer: unknown = info()) => new Response(JSON.stringify({ trailer }));
let loadTrailer: typeof import('@/features/trailers/client')['loadTrailer'];
let fetchImpl: ReturnType<typeof vi.fn>;
const load = () => loadTrailer(input, new AbortController().signal);

beforeEach(async () => {
  vi.useFakeTimers(); vi.setSystemTime(NOW); vi.resetModules();
  fetchImpl = vi.fn(); vi.stubGlobal('fetch', fetchImpl);
  ({ loadTrailer } = await import('@/features/trailers/client'));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('intent-driven trailer client', () => {
  it('imports without requesting metadata and ignores invalid or already aborted intent', async () => {
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await loadTrailer({}, new AbortController().signal) === null).toBe(true);
    const controller = new AbortController(); controller.abort();
    expect(await loadTrailer(input, controller.signal) === null).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fetches same-origin metadata with no cookies or private headers and retains direct MP4 URLs', async () => {
    fetchImpl.mockResolvedValueOnce(json());
    const result = await load();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [path, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/trailer?imdbId=tt9000001');
    expect(init.credentials).toBe('omit');
    expect(Array.from(new Headers(init.headers).keys())).toEqual([]);
    expect(new URL(result!.previewUrl).origin).toBe('https://imdb-video.media-imdb.com');
    expect(new URL(result!.previewUrl).pathname).toBe('/qa-480p.mp4');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not automatically follow metadata redirects', async () => {
    fetchImpl.mockResolvedValueOnce(json());
    await load();
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(['manual', 'error'].includes(init.redirect ?? 'follow')).toBe(true);
  });

  it('reuses plain data until its bounded expiry, then refetches', async () => {
    fetchImpl.mockImplementation(async () => json());
    const first = await load();
    vi.setSystemTime(NOW + 59_999);
    expect(await load()).toBe(first);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    vi.setSystemTime(NOW + 60_000);
    expect(Boolean(await load())).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('bounds cached public entries to 32', async () => {
    fetchImpl.mockImplementation(async () => json());
    for (let id = 9_000_001; id <= 9_000_033; id += 1) await loadTrailer({ imdbId: `tt${id}` }, new AbortController().signal);
    await load();
    expect(fetchImpl).toHaveBeenCalledTimes(34);
  });

  it.each([302, 429, 500, 503])('does not cache HTTP %i failures', async (status) => {
    fetchImpl.mockResolvedValueOnce(new Response(null, { status })).mockResolvedValueOnce(json());
    expect(await load() === null).toBe(true);
    expect(Boolean(await load())).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not cache transport errors or malformed JSON', async () => {
    fetchImpl.mockRejectedValueOnce(new Error('Synthetic transport error')).mockResolvedValueOnce(new Response('{')).mockResolvedValueOnce(json());
    expect(await load() === null).toBe(true);
    expect(await load() === null).toBe(true);
    expect(Boolean(await load())).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it.each(['malformed', 'expired'])('does not poison the cache with a %s successful payload', async (kind) => {
    fetchImpl.mockResolvedValueOnce(json(kind === 'malformed' ? { mime: 'text/html' } : { ...info(), expiresAt: NOW - 1 })).mockResolvedValueOnce(json());
    expect(await load() === null).toBe(true);
    expect(Boolean(await load())).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('cancels a declared oversized body before reading it', async () => {
    const cancel = vi.fn(); const pull = vi.fn();
    fetchImpl.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 }), { headers: { 'Content-Length': String(LIMIT + 1) } }));
    expect(await load() === null).toBe(true);
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('stops at the streamed 64 KiB cap rather than reading the response tail', async () => {
    let pulls = 0; const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull(controller) { pulls += 1; controller.enqueue(new Uint8Array(32_769).fill(32)); if (pulls === 3) controller.close(); }, cancel }, { highWaterMark: 0 });
    fetchImpl.mockResolvedValueOnce(new Response(body));
    expect(await load() === null).toBe(true);
    expect(pulls).toBe(2);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('measures UTF-8 response bytes rather than JavaScript character count', async () => {
    const text = JSON.stringify({ trailer: info(), padding: '\u00e9'.repeat(40_000) });
    expect(text.length < LIMIT && new TextEncoder().encode(text).length > LIMIT).toBe(true);
    fetchImpl.mockResolvedValueOnce(new Response(text));
    expect(await load() === null).toBe(true);
  });

  it.each(['caller', 'timeout'])('aborts pending fetch on %s without caching cancellation', async (reason) => {
    fetchImpl.mockImplementationOnce((_path: string, init: RequestInit) => new Promise<Response>((_done, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('Synthetic cancellation', 'AbortError')), { once: true });
    })).mockResolvedValueOnce(json());
    const caller = new AbortController();
    const pending = loadTrailer(input, caller.signal);
    if (reason === 'caller') caller.abort(); else await vi.advanceTimersByTimeAsync(6_500);
    expect(await pending === null).toBe(true);
    expect(Boolean(await load())).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('suppresses a late successful response after the initiating intent is aborted', async () => {
    let finish!: (response: Response) => void;
    fetchImpl.mockImplementationOnce(() => new Promise<Response>((done) => { finish = done; })).mockResolvedValueOnce(json());
    const caller = new AbortController();
    const pending = loadTrailer(input, caller.signal); caller.abort(); finish(json());
    expect(await pending === null).toBe(true);
    expect(Boolean(await load())).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
