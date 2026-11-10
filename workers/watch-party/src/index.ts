import {
  WATCH_PARTY_PROTOCOL_VERSION,
  WATCH_PARTY_SUBPROTOCOL,
  type WatchPartyErrorCode,
} from '../../../src/features/watch-party/protocol';
import {
  ticketFromWatchPartySubprotocol,
  verifyWatchPartyToken,
} from '../../../src/features/watch-party/tickets';

export { WatchPartyRoom } from './room';

function jsonError(code: WatchPartyErrorCode, message: string, status: number): Response {
  return Response.json({ v: WATCH_PARTY_PROTOCOL_VERSION, error: { code, message } }, {
    status,
    headers: {
      'Cache-Control': 'private, no-store, max-age=0',
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function isLocalHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

export function parseAllowedOrigins(value: string): Set<string> | null {
  const origins = new Set<string>();
  for (const part of value.split(',')) {
    const candidate = part.trim();
    if (!candidate) return null;
    try {
      const url = new URL(candidate);
      if (url.origin !== candidate || url.username || url.password || url.pathname !== '/'
        || url.search || url.hash || (url.protocol !== 'https:'
          && !(url.protocol === 'http:' && isLocalHostname(url.hostname)))) return null;
      origins.add(url.origin);
    } catch {
      return null;
    }
  }
  return origins.size ? origins : null;
}

function originPermitted(request: Request, platform: 'web' | 'android', allowedOrigins: Set<string>): boolean {
  const origin = request.headers.get('Origin');
  if (platform === 'web') return origin !== null && allowedOrigins.has(origin);
  // React Native sends an explicit app Origin; its signed ticket still binds the platform.
  return origin === null || allowedOrigins.has(origin);
}

function secureRequest(url: URL): boolean {
  return url.protocol === 'https:' || (url.protocol === 'http:' && isLocalHostname(url.hostname));
}

async function handleWebSocket(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET') return jsonError('INVALID_REQUEST', 'GET is required.', 405);
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return jsonError('UPGRADE_REQUIRED', 'A WebSocket upgrade is required.', 426);
  }
  if (typeof env.WATCH_PARTY_SECRET !== 'string' || env.WATCH_PARTY_SECRET.length < 32
    || /[\r\n\0]/.test(env.WATCH_PARTY_SECRET)) {
    console.error(JSON.stringify({ event: 'watch_party_config_error', binding: 'WATCH_PARTY_SECRET' }));
    return jsonError('INTERNAL_ERROR', 'Watch Party is unavailable.', 503);
  }
  const allowedOrigins = typeof env.ALLOWED_ORIGINS === 'string' ? parseAllowedOrigins(env.ALLOWED_ORIGINS) : null;
  if (!allowedOrigins) {
    console.error(JSON.stringify({ event: 'watch_party_config_error', binding: 'ALLOWED_ORIGINS' }));
    return jsonError('INTERNAL_ERROR', 'Watch Party is unavailable.', 503);
  }
  if (!env.WATCH_PARTY_ROOMS || typeof env.WATCH_PARTY_ROOMS.getByName !== 'function') {
    return jsonError('INTERNAL_ERROR', 'Watch Party is unavailable.', 503);
  }
  const ticket = ticketFromWatchPartySubprotocol(request.headers.get('Sec-WebSocket-Protocol'));
  if (!ticket) return jsonError('INVALID_TICKET', 'A valid connection ticket is required.', 401);
  const verified = await verifyWatchPartyToken(ticket, env.WATCH_PARTY_SECRET, { expectedKind: 'connect' });
  if (!verified.ok) {
    return jsonError(verified.reason === 'expired' ? 'TICKET_EXPIRED' : 'INVALID_TICKET',
      verified.reason === 'expired' ? 'The connection ticket has expired.' : 'The connection ticket is invalid.', 401);
  }
  const claims = verified.claims;
  if (claims.kind !== 'connect') return jsonError('INVALID_TICKET', 'The connection ticket is invalid.', 401);
  if (!originPermitted(request, claims.platform, allowedOrigins)) {
    return jsonError('ORIGIN_FORBIDDEN', 'This origin is not allowed.', 403);
  }
  try {
    const room = env.WATCH_PARTY_ROOMS.getByName(claims.roomCode);
    return await room.fetch(request);
  } catch {
    console.error(JSON.stringify({ event: 'watch_party_room_unavailable' }));
    return jsonError('INTERNAL_ERROR', 'Watch Party is unavailable.', 503);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!secureRequest(url)) return jsonError('INVALID_REQUEST', 'HTTPS is required.', 400);
    if (url.pathname === '/healthz' && request.method === 'GET') {
      return Response.json({ ok: true, protocol: WATCH_PARTY_PROTOCOL_VERSION }, {
        headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
      });
    }
    if (url.pathname === '/v1/ws') return handleWebSocket(request, env);
    return jsonError('INVALID_REQUEST', 'Route not found.', 404);
  },
} satisfies ExportedHandler<Env>;

export const selectedWebSocketSubprotocol = WATCH_PARTY_SUBPROTOCOL;
