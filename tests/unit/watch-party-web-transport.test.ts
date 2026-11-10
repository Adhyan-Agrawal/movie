import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WATCH_PARTY_SUBPROTOCOL } from '@/features/watch-party/protocol';
import {
  WatchPartyTransport,
  watchPartyReconnectDelay,
  type WatchPartyTransportEnvironment,
} from '@/features/watch-party/web/transport';

const PARTICIPANT_ID = '10000000-0000-4000-8000-000000000001';

class FakeSocket {
  readyState = 0;
  protocol = WATCH_PARTY_SUBPROTOCOL;
  sent: string[] = [];
  private listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();

  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  removeEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((value) => value !== listener));
  }

  send(value: string): void { this.sent.push(value); }

  close(): void {
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.emit('open');
  }

  networkClose(): void {
    this.readyState = 3;
    this.emit('close');
  }

  message(data: string): void { this.emit('message', { data }); }

  private emit(type: string, event: { data?: unknown } = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function ticket(ticketValue: string, now: number): Response {
  return Response.json({
    v: 1,
    ticket: ticketValue,
    ticketExpiresAtMs: now + 120_000,
    roomCode: 'ABCDE23456',
    participantId: PARTICIPANT_ID,
    websocketUrl: 'wss://party.example/v1/ws',
    subprotocols: [WATCH_PARTY_SUBPROTOCOL, `lumora.ticket.${ticketValue}`],
  });
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function fixture(fetchImpl: typeof fetch) {
  const sockets: FakeSocket[] = [];
  const callbacks = { onStatus: vi.fn(), onMessage: vi.fn(), onError: vi.fn() };
  const transport = new WatchPartyTransport(callbacks, {
    fetch: fetchImpl,
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    setTimeout: (handler, timeoutMs) => setTimeout(handler, timeoutMs),
    clearTimeout: (timer) => clearTimeout(timer),
    now: () => Date.now(),
    random: () => 0,
  });
  const start = () => transport.start({ v: 1, action: 'join', platform: 'web',
    displayName: 'Viewer', roomCode: 'ABCDE23456' });
  return { transport, sockets, callbacks, start };
}

describe('Watch Party web transport', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it('authenticates only through both WebSocket subprotocols and resumes with backoff', async () => {
    const now = Date.now();
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(ticket('wp1.first.signature', now))
      .mockResolvedValueOnce(ticket('wp1.second.signature', now + 500));
    const sockets: FakeSocket[] = [];
    const protocolVectors: string[][] = [];
    const statuses: unknown[] = [];
    const errors: unknown[] = [];
    const environment: WatchPartyTransportEnvironment = {
      fetch: fetchMock,
      createSocket: (_url, protocols) => {
        protocolVectors.push(protocols);
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
      setTimeout: (handler, timeoutMs) => setTimeout(handler, timeoutMs),
      clearTimeout: (timer) => clearTimeout(timer),
      now: () => Date.now(),
      random: () => 0,
    };
    const transport = new WatchPartyTransport({
      onStatus: (status) => statuses.push(status),
      onMessage: vi.fn(),
      onError: (error) => errors.push(error),
    }, environment);
    transport.start({ v: 1, action: 'join', platform: 'web', displayName: 'Viewer', roomCode: 'ABCDE23456' });
    await flushPromises();
    expect(protocolVectors[0]).toEqual([WATCH_PARTY_SUBPROTOCOL, 'lumora.ticket.wp1.first.signature']);
    expect(protocolVectors[0]!.join(',')).not.toContain('https://');
    sockets[0]!.open();
    transport.setResumeToken('wp1.resume.signature');
    sockets[0]!.networkClose();
    expect(statuses).toContainEqual({ phase: 'reconnecting', attempt: 1, retryInMs: 500 });
    await vi.advanceTimersByTimeAsync(500);
    await flushPromises();
    const resumeBody = JSON.parse(String(fetchMock.mock.calls[1]![1]?.body)) as { action: string; resumeToken: string };
    expect(resumeBody).toEqual({ v: 1, action: 'resume', platform: 'web', resumeToken: 'wp1.resume.signature' });
    expect(protocolVectors[1]).toEqual([WATCH_PARTY_SUBPROTOCOL, 'lumora.ticket.wp1.second.signature']);
    expect(errors).toEqual([]);
    transport.disconnect();
  });

  it('uses capped deterministic exponential delays', () => {
    expect(watchPartyReconnectDelay(1, 0)).toBe(500);
    expect(watchPartyReconnectDelay(4, 0)).toBe(4_000);
    expect(watchPartyReconnectDelay(20, 1)).toBe(15_250);
  });

  it('surfaces fixed API errors without server-provided text', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      v: 1,
      error: { code: 'ROOM_FULL', message: 'secret upstream details' },
    }, { status: 409 }));
    const errors: Array<{ message: string }> = [];
    const transport = new WatchPartyTransport({
      onStatus: vi.fn(),
      onMessage: vi.fn(),
      onError: (error) => errors.push(error),
    }, {
      fetch: fetchMock,
      createSocket: () => { throw new Error('not reached'); },
      setTimeout: (handler, timeoutMs) => setTimeout(handler, timeoutMs),
      clearTimeout: (timer) => clearTimeout(timer),
      now: () => Date.now(),
      random: () => 0,
    });
    transport.start({ v: 1, action: 'join', platform: 'web', displayName: 'Viewer', roomCode: 'ABCDE23456' });
    await flushPromises();
    expect(errors[0]?.message).toBe('This Watch Party room is full.');
    expect(errors[0]?.message).not.toContain('upstream');
  });

  it('aborts an in-flight ticket and ignores it after a new attempt', async () => {
    let resolve!: (response: Response) => void;
    const fetchMock = vi.fn<typeof fetch>()
      .mockImplementationOnce(() => new Promise<Response>((done) => { resolve = done; }))
      .mockResolvedValueOnce(ticket('wp1.current.signature', Date.now()));
    const { transport, sockets, callbacks, start } = fixture(fetchMock);
    start();
    const firstSignal = fetchMock.mock.calls[0]![1]!.signal;
    start();
    await flushPromises();
    expect(firstSignal?.aborted).toBe(true);
    resolve(ticket('wp1.stale.signature', Date.now()));
    await flushPromises();
    expect(sockets).toHaveLength(1);
    expect(callbacks.onError).not.toHaveBeenCalled();
    transport.disconnect();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds the complete response body read and cancels it on disconnect', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{')); }, cancel,
    });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
    const { transport, callbacks, start } = fixture(fetchMock);
    start();
    await flushPromises();
    await vi.advanceTimersByTimeAsync(10_001);
    await flushPromises();
    expect(fetchMock.mock.calls[0]![1]!.signal?.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
    expect(callbacks.onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'NETWORK' }), true);
    transport.disconnect();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not surface a stale body parse error from a cancelled attempt', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, cancel });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(body))
      .mockResolvedValueOnce(ticket('wp1.current.signature', Date.now()));
    const { transport, sockets, callbacks, start } = fixture(fetchMock);
    start();
    await flushPromises();
    start();
    await flushPromises();
    if (!cancel.mock.calls.length) { controller.enqueue(new TextEncoder().encode('invalid')); controller.close(); }
    await flushPromises();
    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(sockets).toHaveLength(1);
    transport.disconnect();
  });

  it('closes the previous socket on retry and ignores its late messages', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => ticket('wp1.ticket.signature', Date.now()));
    const { transport, sockets, callbacks, start } = fixture(fetchMock);
    start();
    await flushPromises();
    sockets[0]!.open();
    transport.setResumeToken('wp1.resume.signature');
    transport.retry();
    await flushPromises();
    expect(sockets[0]!.readyState).toBe(3);
    sockets[0]!.message('late');
    expect(callbacks.onMessage).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(2);
    transport.disconnect();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['upgrade', 'snapshot', 'heartbeat'])('reconnects a stalled %s with a bounded timeout', async (stage) => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => ticket('wp1.ticket.signature', Date.now()));
    const { transport, sockets, callbacks, start } = fixture(fetchMock);
    start();
    await flushPromises();
    if (stage !== 'upgrade') sockets[0]!.open();
    if (stage === 'heartbeat') transport.setResumeToken('wp1.resume.signature');
    await vi.advanceTimersByTimeAsync(stage === 'heartbeat' ? 30_001 : 10_001);
    expect(sockets[0]!.readyState).toBe(3);
    expect(callbacks.onStatus).toHaveBeenCalledWith({ phase: 'reconnecting', attempt: 1, retryInMs: 500 });
    transport.disconnect();
    expect(vi.getTimerCount()).toBe(0);
  });
});
