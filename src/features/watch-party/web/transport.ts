import {
  WATCH_PARTY_LIMITS,
  type WatchPartyServerMessage,
  type WatchPartyTicketRequest,
  type WatchPartyTicketResponse,
} from '../protocol';
import {
  decodeWatchPartyApiError,
  decodeWatchPartyServerMessage,
  decodeWatchPartyTicket,
} from './codec';
import {
  watchPartyError,
  watchPartyNetworkError,
  watchPartyProtocolError,
  type WatchPartyUiError,
} from './errors';

const TICKET_ENDPOINT = '/api/watch-party';
const REQUEST_TIMEOUT_MS = 10_000;
const SOCKET_IDLE_TIMEOUT_MS = 30_000;
const MAX_RECONNECT_ATTEMPTS = 8;
const MAX_RESPONSE_BYTES = 16 * 1024;

export type WatchPartyTransportStatus =
  | { phase: 'ticketing' }
  | { phase: 'connecting' }
  | { phase: 'connected' }
  | { phase: 'reconnecting'; attempt: number; retryInMs: number };

export interface WatchPartyTransportCallbacks {
  onStatus: (status: WatchPartyTransportStatus) => void;
  onMessage: (message: WatchPartyServerMessage, receivedAtMs: number) => void;
  onError: (error: WatchPartyUiError, fatal: boolean) => void;
}

export interface WatchPartyTransportEnvironment {
  fetch: typeof fetch;
  createSocket: (url: string, protocols: string[]) => WebSocket;
  setTimeout: (handler: () => void, timeoutMs: number) => ReturnType<typeof globalThis.setTimeout>;
  clearTimeout: (timer: ReturnType<typeof globalThis.setTimeout>) => void;
  now: () => number;
  random: () => number;
}

const DEFAULT_ENVIRONMENT: WatchPartyTransportEnvironment = {
  fetch: (...args) => fetch(...args),
  createSocket: (url, protocols) => new WebSocket(url, protocols),
  setTimeout: (handler, timeoutMs) => globalThis.setTimeout(handler, timeoutMs),
  clearTimeout: (timer) => globalThis.clearTimeout(timer),
  now: () => Date.now(),
  random: () => Math.random(),
};

export function watchPartyReconnectDelay(attempt: number, randomValue = Math.random()): number {
  const exponential = Math.min(15_000, 500 * 2 ** Math.max(0, attempt - 1));
  const jitter = Math.floor(Math.max(0, Math.min(1, randomValue)) * 250);
  return exponential + jitter;
}

async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error('response-too-large');
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('response-too-large');
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

function terminalReconnectCode(code: WatchPartyUiError['code']): boolean {
  return code === 'INVALID_TICKET' || code === 'TICKET_EXPIRED' || code === 'ORIGIN_FORBIDDEN'
    || code === 'ROOM_NOT_FOUND' || code === 'ROOM_EXPIRED' || code === 'ROOM_CLOSED'
    || code === 'PARTICIPANT_NOT_FOUND' || code === 'UNSUPPORTED_VERSION';
}

export class WatchPartyTransport {
  private socket: WebSocket | null = null;
  private socketCleanup: (() => void) | null = null;
  private socketTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private ticketController: AbortController | null = null;
  private ticketTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
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
    this.startRequest = request;
    this.resumeToken = request.action === 'resume' ? request.resumeToken : null;
    this.lastTicket = null;
    this.reconnectAttempt = 0;
    const generation = this.generation;
    this.callbacks.onStatus({ phase: 'ticketing' });
    void this.requestTicket(request, generation, false);
  }

  setResumeToken(token: string): void {
    if (this.intentionalClose) return;
    this.resumeToken = token;
    this.reconnectAttempt = 0;
    this.armSocketTimeout(SOCKET_IDLE_TIMEOUT_MS);
  }

  send(message: object): boolean {
    if (!this.socket || this.socket.readyState !== 1) return false;
    const serialized = JSON.stringify(message);
    if (new TextEncoder().encode(serialized).byteLength > WATCH_PARTY_LIMITS.maxMessageBytes) return false;
    try {
      this.socket.send(serialized);
      return true;
    } catch {
      return false;
    }
  }

  retry(): void {
    if (!this.startRequest) return;
    this.disconnect();
    this.intentionalClose = false;
    this.reconnectAttempt = 0;
    const generation = this.generation;
    if (this.resumeToken) {
      this.callbacks.onStatus({ phase: 'ticketing' });
      void this.requestTicket({ v: 1, action: 'resume', platform: 'web', resumeToken: this.resumeToken },
        generation, false);
      return;
    }
    this.callbacks.onStatus({ phase: 'ticketing' });
    void this.requestTicket(this.startRequest, generation, false);
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.generation += 1;
    this.cancelReconnect();
    this.ticketController?.abort();
    this.ticketController = null;
    if (this.ticketTimer !== null) this.environment.clearTimeout(this.ticketTimer);
    this.ticketTimer = null;
    this.closeSocket();
  }

  private closeSocket(): void {
    if (this.socketTimer !== null) this.environment.clearTimeout(this.socketTimer);
    this.socketTimer = null;
    this.socketCleanup?.();
    this.socketCleanup = null;
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState < 2) {
      try { socket.close(1000, 'Client closed'); } catch { /* Already closed. */ }
    }
  }

  private armSocketTimeout(timeoutMs: number): void {
    if (this.socketTimer !== null) this.environment.clearTimeout(this.socketTimer);
    if (!this.socket || this.intentionalClose) return;
    const generation = this.generation;
    this.socketTimer = this.environment.setTimeout(() => {
      this.socketTimer = null;
      if (generation !== this.generation || this.intentionalClose) return;
      this.closeSocket();
      this.scheduleReconnect();
    }, timeoutMs);
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer !== null) this.environment.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private async requestTicket(request: WatchPartyTicketRequest, generation: number,
    reconnecting: boolean): Promise<void> {
    const controller = new AbortController();
    const timeout = this.environment.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    this.ticketController = controller;
    this.ticketTimer = timeout;
    try {
      const response = await this.environment.fetch(TICKET_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        signal: controller.signal,
      });
      if (generation !== this.generation || this.intentionalClose) {
        await response.body?.cancel();
        return;
      }
      let body: unknown;
      try {
        body = await boundedJson(response, controller.signal);
      } catch {
        if (generation !== this.generation || this.intentionalClose) return;
        if (controller.signal.aborted) throw new Error('Ticket request timed out.');
        this.callbacks.onError(watchPartyProtocolError(), true);
        return;
      }
      if (generation !== this.generation || this.intentionalClose) return;
      if (!response.ok) {
        const code = decodeWatchPartyApiError(body);
        const error = code ? watchPartyError(code) : watchPartyNetworkError();
        if (reconnecting && !terminalReconnectCode(error.code)) this.scheduleReconnect();
        else this.callbacks.onError(error, true);
        return;
      }
      const decoded = decodeWatchPartyTicket(body, this.environment.now());
      if (!decoded.ok) {
        this.callbacks.onError(watchPartyProtocolError(), true);
        return;
      }
      this.lastTicket = decoded.value;
      this.openSocket(decoded.value, generation);
    } catch {
      if (generation !== this.generation || this.intentionalClose) return;
      if (reconnecting) this.scheduleReconnect();
      else this.callbacks.onError(watchPartyNetworkError(), true);
      return;
    } finally {
      this.environment.clearTimeout(timeout);
      if (this.ticketController === controller) {
        this.ticketController = null;
        this.ticketTimer = null;
      }
    }
  }

  private openSocket(ticket: WatchPartyTicketResponse, generation: number): void {
    if (generation !== this.generation || this.intentionalClose) return;
    this.closeSocket();
    this.callbacks.onStatus({ phase: 'connecting' });
    let socket: WebSocket;
    try {
      socket = this.environment.createSocket(ticket.websocketUrl, [...ticket.subprotocols]);
    } catch {
      this.callbacks.onError(watchPartyNetworkError(), true);
      return;
    }
    this.socket = socket;
    const onOpen = () => {
      if (generation !== this.generation || this.intentionalClose || socket !== this.socket) return;
      if (socket.protocol !== ticket.subprotocols[0]) {
        this.disconnect();
        this.callbacks.onError(watchPartyProtocolError(), true);
        return;
      }
      this.callbacks.onStatus({ phase: 'connected' });
    };
    const onMessage = (event: MessageEvent) => {
      if (generation !== this.generation || this.intentionalClose || socket !== this.socket) return;
      if (typeof event.data !== 'string'
        || new TextEncoder().encode(event.data).byteLength > WATCH_PARTY_LIMITS.maxServerMessageBytes) {
        this.disconnect();
        this.callbacks.onError(watchPartyProtocolError(), true);
        return;
      }
      let value: unknown;
      try { value = JSON.parse(event.data); } catch { /* Rejected by the decoder below. */ }
      const decoded = decodeWatchPartyServerMessage(value);
      if (!decoded.ok || (decoded.value.type === 'room.snapshot'
        && (decoded.value.room.roomCode !== ticket.roomCode || decoded.value.self.participantId !== ticket.participantId))) {
        this.disconnect();
        this.callbacks.onError(watchPartyProtocolError(), true);
        return;
      }
      if (this.resumeToken) this.armSocketTimeout(SOCKET_IDLE_TIMEOUT_MS);
      this.callbacks.onMessage(decoded.value, this.environment.now());
    };
    const onClose = () => {
      if (generation !== this.generation || socket !== this.socket) return;
      this.closeSocket();
      if (!this.intentionalClose) this.scheduleReconnect();
    };
    socket.addEventListener('open', onOpen);
    socket.addEventListener('message', onMessage);
    socket.addEventListener('close', onClose);
    socket.addEventListener('error', onClose);
    this.socketCleanup = () => {
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('message', onMessage);
      socket.removeEventListener('close', onClose);
      socket.removeEventListener('error', onClose);
    };
    this.armSocketTimeout(REQUEST_TIMEOUT_MS);
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
        void this.requestTicket({ v: 1, action: 'resume', platform: 'web', resumeToken: this.resumeToken },
          generation, true);
        return;
      }
      if (this.lastTicket && this.lastTicket.ticketExpiresAtMs > this.environment.now() + 1_000) {
        this.openSocket(this.lastTicket, generation);
        return;
      }
      this.callbacks.onError(watchPartyNetworkError(), true);
    }, delay);
  }
}
