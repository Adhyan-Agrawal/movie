import { WATCH_PARTY_CLOUDFLARE_BASE_URL } from './config';
import { WATCH_PARTY_LIMITS, type WatchPartyTicketRequest, type WatchPartyTicketResponse } from './protocol';
import { decodeWatchPartyApiError, decodeWatchPartyTicket } from './codec';
import { watchPartyError, watchPartyNetworkError, watchPartyProtocolError, type WatchPartyUiError } from './errors';

export const WATCH_PARTY_TICKET_ENDPOINT = new URL('/api/watch-party', `${WATCH_PARTY_CLOUDFLARE_BASE_URL}/`).href;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RECONNECT_ATTEMPTS = 8;
const MAX_RESPONSE_BYTES = 16 * 1024;
const MAX_SERVER_MESSAGE_BYTES = 128 * 1024;

export type WatchPartyTransportStatus =
  | { phase: 'ticketing' }
  | { phase: 'connecting' }
  | { phase: 'connected' }
  | { phase: 'reconnecting'; attempt: number; retryInMs: number };

export interface WatchPartyTransportCallbacks {
  onStatus: (status: WatchPartyTransportStatus) => void;
  onMessage: (raw: string, receivedAtMs: number) => void;
  onError: (error: WatchPartyUiError, fatal: boolean) => void;
}

export interface WatchPartyTransportEnvironment {
  fetch: typeof fetch;
  createSocket: (url: string, protocols: string[], options: { headers: Record<string, string> }) => WebSocket;
  setTimeout: (handler: () => void, timeoutMs: number) => ReturnType<typeof globalThis.setTimeout>;
  clearTimeout: (timer: ReturnType<typeof globalThis.setTimeout>) => void;
  now: () => number;
  random: () => number;
}

type NativeWebSocketConstructor = new (url: string, protocols?: string | string[] | null,
  options?: { headers: Record<string, string> } | null) => WebSocket;

const DEFAULT_ENVIRONMENT: WatchPartyTransportEnvironment = {
  fetch: (...args) => fetch(...args),
  createSocket: (url, protocols, options) => new (WebSocket as unknown as NativeWebSocketConstructor)(url, protocols, options),
  setTimeout: (handler, timeoutMs) => globalThis.setTimeout(handler, timeoutMs),
  clearTimeout: (timer) => globalThis.clearTimeout(timer),
  now: () => Date.now(),
  random: () => Math.random(),
};

function utf8Length(value: string): number { return new TextEncoder().encode(value).byteLength; }

export function watchPartyReconnectDelay(attempt: number, randomValue = Math.random()): number {
  const exponential = Math.min(15_000, 500 * 2 ** Math.max(0, attempt - 1));
  const jitter = Math.floor(Math.max(0, Math.min(1, randomValue)) * 250);
  return exponential + jitter;
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error('response-too-large');
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let text = '';
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error('response-too-large'); }
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
      return JSON.parse(text);
    } finally { reader.releaseLock(); }
  }
  const text = await response.text();
  if (utf8Length(text) > MAX_RESPONSE_BYTES) throw new Error('response-too-large');
  return JSON.parse(text);
}

function terminalReconnectCode(code: WatchPartyUiError['code']): boolean {
  return code === 'INVALID_TICKET' || code === 'TICKET_EXPIRED' || code === 'ORIGIN_FORBIDDEN'
    || code === 'ROOM_NOT_FOUND' || code === 'ROOM_EXPIRED' || code === 'ROOM_CLOSED'
    || code === 'PARTICIPANT_NOT_FOUND' || code === 'UNSUPPORTED_VERSION';
}

function ticketIsOnlyInSubprotocol(ticket: WatchPartyTicketResponse): boolean {
  try {
    const socketUrl = new URL(ticket.websocketUrl);
    return socketUrl.search === '' && !decodeURIComponent(socketUrl.href).includes(ticket.ticket);
  } catch { return false; }
}

export class WatchPartyTransport {
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private generation = 0;
  private intentionalClose = false;
  private reconnectAttempt = 0;
  private startRequest: WatchPartyTicketRequest | null = null;
  private resumeToken: string | null = null;
  private lastTicket: WatchPartyTicketResponse | null = null;

  constructor(private readonly callbacks: WatchPartyTransportCallbacks,
    private readonly environment: WatchPartyTransportEnvironment = DEFAULT_ENVIRONMENT) {}

  start(request: WatchPartyTicketRequest): void {
    this.disconnect();
    this.intentionalClose = false;
    this.generation += 1;
    this.startRequest = request;
    this.resumeToken = request.action === 'resume' ? request.resumeToken : null;
    this.lastTicket = null;
    this.reconnectAttempt = 0;
    const generation = this.generation;
    this.callbacks.onStatus({ phase: 'ticketing' });
    void this.requestTicket(request, generation, false);
  }

  setResumeToken(token: string): void { this.resumeToken = token; this.reconnectAttempt = 0; }

  send(message: object): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    const serialized = JSON.stringify(message);
    if (utf8Length(serialized) > WATCH_PARTY_LIMITS.maxMessageBytes) return false;
    try { this.socket.send(serialized); return true; } catch { return false; }
  }

  retry(): void {
    if (!this.startRequest) return;
    this.cancelReconnect();
    this.intentionalClose = false;
    this.reconnectAttempt = 0;
    this.generation += 1;
    const generation = this.generation;
    this.callbacks.onStatus({ phase: 'ticketing' });
    if (this.resumeToken) {
      void this.requestTicket({ v: 1, action: 'resume', platform: 'android', resumeToken: this.resumeToken }, generation, false);
    } else void this.requestTicket(this.startRequest, generation, false);
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.cancelReconnect();
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState < WebSocket.CLOSING) {
      try { socket.close(1000, 'Client closed'); } catch { /* Already closed. */ }
    }
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer !== null) this.environment.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private async requestTicket(request: WatchPartyTicketRequest, generation: number, reconnecting: boolean): Promise<void> {
    const controller = new AbortController();
    const timeout = this.environment.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.environment.fetch(WATCH_PARTY_TICKET_ENDPOINT, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request),
        credentials: 'omit', cache: 'no-store', redirect: 'error', signal: controller.signal,
      });
    } catch {
      if (generation !== this.generation || this.intentionalClose) return;
      if (reconnecting) this.scheduleReconnect();
      else this.callbacks.onError(watchPartyNetworkError(), true);
      return;
    } finally { this.environment.clearTimeout(timeout); }
    if (generation !== this.generation || this.intentionalClose) return;
    let body: unknown;
    try { body = await boundedJson(response); } catch {
      this.callbacks.onError(watchPartyProtocolError(), true);
      return;
    }
    if (!response.ok) {
      const code = decodeWatchPartyApiError(body);
      const error = code ? watchPartyError(code) : watchPartyNetworkError();
      if (reconnecting && !terminalReconnectCode(error.code)) this.scheduleReconnect();
      else this.callbacks.onError(error, true);
      return;
    }
    const decoded = decodeWatchPartyTicket(body, this.environment.now());
    if (!decoded.ok || !ticketIsOnlyInSubprotocol(decoded.value)) {
      this.callbacks.onError(watchPartyProtocolError(), true);
      return;
    }
    this.lastTicket = decoded.value;
    this.openSocket(decoded.value, generation);
  }

  private openSocket(ticket: WatchPartyTicketResponse, generation: number): void {
    if (generation !== this.generation || this.intentionalClose) return;
    this.callbacks.onStatus({ phase: 'connecting' });
    let socket: WebSocket;
    try {
      socket = this.environment.createSocket(ticket.websocketUrl, [...ticket.subprotocols],
        { headers: { Origin: WATCH_PARTY_CLOUDFLARE_BASE_URL } });
    } catch {
      this.callbacks.onError(watchPartyNetworkError(), true);
      return;
    }
    this.socket = socket;
    socket.addEventListener('open', () => {
      if (generation !== this.generation || this.intentionalClose || socket !== this.socket) return;
      if (socket.protocol !== ticket.subprotocols[0]) {
        this.callbacks.onError(watchPartyProtocolError(), true);
        this.intentionalClose = true;
        try { socket.close(1002, 'Subprotocol mismatch'); } catch { /* Already closed. */ }
        return;
      }
      this.callbacks.onStatus({ phase: 'connected' });
    });
    socket.addEventListener('message', (event) => {
      if (generation !== this.generation || this.intentionalClose || socket !== this.socket) return;
      if (typeof event.data !== 'string' || utf8Length(event.data) > MAX_SERVER_MESSAGE_BYTES) {
        this.callbacks.onError(watchPartyProtocolError(), true);
        this.intentionalClose = true;
        try { socket.close(1002, 'Invalid message'); } catch { /* Already closed. */ }
        return;
      }
      this.callbacks.onMessage(event.data, this.environment.now());
    });
    socket.addEventListener('close', () => {
      if (generation !== this.generation || socket !== this.socket) return;
      this.socket = null;
      if (!this.intentionalClose) this.scheduleReconnect();
    });
    socket.addEventListener('error', () => { /* close drives bounded reconnect. */ });
  }

  private scheduleReconnect(): void {
    if (this.intentionalClose || this.reconnectTimer !== null) return;
    this.reconnectAttempt += 1;
    if (this.reconnectAttempt > MAX_RECONNECT_ATTEMPTS) {
      this.callbacks.onError(watchPartyNetworkError(), true);
      return;
    }
    const delay = watchPartyReconnectDelay(this.reconnectAttempt, this.environment.random());
    this.callbacks.onStatus({ phase: 'reconnecting', attempt: this.reconnectAttempt, retryInMs: delay });
    const generation = this.generation;
    this.reconnectTimer = this.environment.setTimeout(() => {
      this.reconnectTimer = null;
      if (generation !== this.generation || this.intentionalClose) return;
      if (this.resumeToken) {
        void this.requestTicket({ v: 1, action: 'resume', platform: 'android', resumeToken: this.resumeToken }, generation, true);
      } else if (this.lastTicket && this.lastTicket.ticketExpiresAtMs > this.environment.now() + 1_000) {
        this.openSocket(this.lastTicket, generation);
      } else this.callbacks.onError(watchPartyNetworkError(), true);
    }, delay);
  }
}
