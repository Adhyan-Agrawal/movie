import {
  WATCH_PARTY_DRIFT_POLICY,
  WATCH_PARTY_LIMITS,
  WATCH_PARTY_PROTOCOL_VERSION,
  WATCH_PARTY_SUBPROTOCOL,
  normalizeWatchPartyDisplayName,
  normalizeWatchPartyRoomCode,
  parseWatchPartyMediaIdentity,
  type WatchPartyErrorCode,
  type WatchPartyPlatform,
  type WatchPartyTicketRequest,
  type WatchPartyTicketResponse,
} from '@/features/watch-party/protocol';
import {
  generateWatchPartyId,
  generateWatchPartyRoomCode,
  signWatchPartyToken,
  verifyWatchPartyToken,
  watchPartySubprotocols,
  watchPartyTokenBase,
  type WatchPartyConnectTicketClaims,
} from '@/features/watch-party/tickets';
import { watchPartyServerConfig } from './config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_REQUEST_BYTES = 8 * 1024;

function response(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: {
      'Cache-Control': 'private, no-store, max-age=0',
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      Vary: 'Origin',
    },
  });
}

function failure(code: WatchPartyErrorCode, message: string, status: number): Response {
  return response({ v: WATCH_PARTY_PROTOCOL_VERSION, error: { code, message } }, status);
}

async function readBoundedJson(request: Request): Promise<unknown> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    throw new ApiError('INVALID_REQUEST', 'JSON is required.', 415);
  }
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) {
    throw new ApiError('INVALID_REQUEST', 'The request is too large.', 413);
  }
  if (!request.body) throw new ApiError('INVALID_REQUEST', 'A request body is required.', 400);
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_REQUEST_BYTES) {
        await reader.cancel();
        throw new ApiError('INVALID_REQUEST', 'The request is too large.', 413);
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  try { return JSON.parse(text); } catch { throw new ApiError('INVALID_REQUEST', 'The JSON body is invalid.', 400); }
}

class ApiError extends Error {
  constructor(readonly code: WatchPartyErrorCode, message: string, readonly status: number) {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

function parseWatchPartyTicketRequest(value: unknown): WatchPartyTicketRequest {
  if (!isRecord(value)) throw new ApiError('INVALID_REQUEST', 'The request is invalid.', 400);
  if (value.v !== WATCH_PARTY_PROTOCOL_VERSION) {
    throw new ApiError('UNSUPPORTED_VERSION', 'Watch Party protocol v1 is required.', 400);
  }
  if (value.platform !== 'web' && value.platform !== 'android') {
    throw new ApiError('INVALID_REQUEST', 'The client platform is invalid.', 400);
  }
  const platform: WatchPartyPlatform = value.platform;
  if (value.action === 'create') {
    if (!exactKeys(value, ['v', 'action', 'platform', 'displayName', 'media'], ['positionSeconds'])) {
      throw new ApiError('INVALID_REQUEST', 'The create request is invalid.', 400);
    }
    const displayName = normalizeWatchPartyDisplayName(value.displayName);
    const media = parseWatchPartyMediaIdentity(value.media);
    const positionSeconds = value.positionSeconds;
    if (!displayName || !media || (positionSeconds !== undefined
      && (typeof positionSeconds !== 'number' || !Number.isFinite(positionSeconds)
        || positionSeconds < 0 || positionSeconds > 86_400))) {
      throw new ApiError('INVALID_REQUEST', 'The create request is invalid.', 400);
    }
    return { v: 1, action: 'create', platform, displayName, media,
      ...(positionSeconds === undefined ? {} : { positionSeconds }) };
  }
  if (value.action === 'join') {
    if (!exactKeys(value, ['v', 'action', 'platform', 'displayName', 'roomCode'])) {
      throw new ApiError('INVALID_REQUEST', 'The join request is invalid.', 400);
    }
    const displayName = normalizeWatchPartyDisplayName(value.displayName);
    const roomCode = typeof value.roomCode === 'string' ? normalizeWatchPartyRoomCode(value.roomCode) : null;
    if (!displayName || !roomCode) throw new ApiError('INVALID_REQUEST', 'The join request is invalid.', 400);
    return { v: 1, action: 'join', platform, displayName, roomCode };
  }
  if (value.action === 'resume') {
    if (!exactKeys(value, ['v', 'action', 'platform', 'resumeToken']) || typeof value.resumeToken !== 'string'
      || value.resumeToken.length > 4096) {
      throw new ApiError('INVALID_REQUEST', 'The resume request is invalid.', 400);
    }
    return { v: 1, action: 'resume', platform, resumeToken: value.resumeToken };
  }
  throw new ApiError('INVALID_REQUEST', 'The ticket action is invalid.', 400);
}

function enforceClientOrigin(request: Request, platform: WatchPartyPlatform, canonicalAppOrigin: string): void {
  const origin = request.headers.get('Origin');
  if (platform === 'web') {
    if (origin !== canonicalAppOrigin) throw new ApiError('ORIGIN_FORBIDDEN', 'A same-origin request is required.', 403);
    return;
  }
  if (origin !== null) throw new ApiError('ORIGIN_FORBIDDEN', 'Native requests must not carry a browser origin.', 403);
}

export async function GET(): Promise<Response> {
  try {
    const config = watchPartyServerConfig();
    return response({
      v: WATCH_PARTY_PROTOCOL_VERSION,
      websocketUrl: config.websocketUrl,
      subprotocol: WATCH_PARTY_SUBPROTOCOL,
      ticketTtlSeconds: WATCH_PARTY_LIMITS.ticketTtlSeconds,
      limits: WATCH_PARTY_LIMITS,
      drift: WATCH_PARTY_DRIFT_POLICY,
    });
  } catch (error) {
    console.error(JSON.stringify({ event: 'watch_party_config_error',
      error: error instanceof Error ? error.message : 'Unknown configuration error' }));
    return failure('INTERNAL_ERROR', 'Watch Party is unavailable.', 503);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const config = watchPartyServerConfig();
    const input = parseWatchPartyTicketRequest(await readBoundedJson(request));
    enforceClientOrigin(request, input.platform, config.canonicalAppOrigin);
    const now = Date.now();
    let claims: WatchPartyConnectTicketClaims;
    if (input.action === 'create') {
      claims = {
        ...watchPartyTokenBase({
          roomCode: generateWatchPartyRoomCode(),
          roomId: generateWatchPartyId(),
          participantId: generateWatchPartyId(),
          displayName: input.displayName,
          platform: input.platform,
          ttlSeconds: WATCH_PARTY_LIMITS.ticketTtlSeconds,
          nowMs: now,
        }),
        kind: 'connect',
        action: 'create',
        role: 'host',
        media: input.media,
        ...(input.positionSeconds === undefined ? {} : { positionSeconds: input.positionSeconds }),
      };
    } else if (input.action === 'join') {
      claims = {
        ...watchPartyTokenBase({
          roomCode: input.roomCode,
          participantId: generateWatchPartyId(),
          displayName: input.displayName,
          platform: input.platform,
          ttlSeconds: WATCH_PARTY_LIMITS.ticketTtlSeconds,
          nowMs: now,
        }),
        kind: 'connect',
        action: 'join',
        role: 'member',
      };
    } else {
      const resumed = await verifyWatchPartyToken(input.resumeToken, config.secret, { expectedKind: 'resume', nowMs: now });
      if (!resumed.ok) {
        throw new ApiError(resumed.reason === 'expired' ? 'TICKET_EXPIRED' : 'INVALID_TICKET',
          resumed.reason === 'expired' ? 'The resume token has expired.' : 'The resume token is invalid.', 401);
      }
      if (resumed.claims.kind !== 'resume' || resumed.claims.platform !== input.platform) {
        throw new ApiError('INVALID_TICKET', 'The resume token is invalid.', 401);
      }
      claims = {
        ...watchPartyTokenBase({
          roomCode: resumed.claims.roomCode,
          roomId: resumed.claims.roomId,
          participantId: resumed.claims.participantId,
          displayName: resumed.claims.displayName,
          platform: resumed.claims.platform,
          ttlSeconds: WATCH_PARTY_LIMITS.ticketTtlSeconds,
          nowMs: now,
        }),
        kind: 'connect',
        action: 'resume',
        role: 'member',
      };
    }
    const ticket = await signWatchPartyToken(claims, config.secret);
    const body: WatchPartyTicketResponse = {
      v: WATCH_PARTY_PROTOCOL_VERSION,
      ticket,
      ticketExpiresAtMs: claims.exp * 1000,
      roomCode: claims.roomCode,
      participantId: claims.participantId,
      websocketUrl: config.websocketUrl,
      subprotocols: watchPartySubprotocols(ticket),
    };
    return response(body, input.action === 'create' ? 201 : 200);
  } catch (error) {
    if (error instanceof ApiError) return failure(error.code, error.message, error.status);
    console.error(JSON.stringify({ event: 'watch_party_ticket_error',
      error: error instanceof Error ? error.message : 'Unknown ticket error' }));
    return failure('INTERNAL_ERROR', 'Watch Party is unavailable.', 503);
  }
}
