import type { WatchPartyErrorCode } from './protocol';

export interface WatchPartyUiError {
  code: WatchPartyErrorCode | 'NETWORK' | 'PROTOCOL' | 'UNAVAILABLE';
  message: string;
  recoverable: boolean;
  retryAfterMs?: number;
}

const PUBLIC_MESSAGES: Record<WatchPartyErrorCode, string> = {
  INVALID_REQUEST: 'The Watch Party request was not accepted.',
  UNSUPPORTED_VERSION: 'This Watch Party needs a newer version of Lumora.',
  INVALID_TICKET: 'This Watch Party session is no longer valid.',
  TICKET_EXPIRED: 'This Watch Party session has expired.',
  ORIGIN_FORBIDDEN: 'Watch Party could not verify this app.',
  UPGRADE_REQUIRED: 'A secure Watch Party connection could not be opened.',
  ROOM_NOT_FOUND: 'That Watch Party room was not found.',
  ROOM_EXPIRED: 'This Watch Party room has expired.',
  ROOM_FULL: 'This Watch Party room is full.',
  ROOM_CODE_COLLISION: 'A room could not be created. Please try again.',
  TOO_MANY_CONNECTIONS: 'This participant already has too many open connections.',
  INVALID_MESSAGE: 'A Watch Party message could not be processed.',
  MESSAGE_TOO_LARGE: 'That Watch Party message is too large.',
  RATE_LIMITED: 'Too many Watch Party actions were sent. Please wait and try again.',
  HOST_REQUIRED: 'Only the current host can do that.',
  STALE_REVISION: 'The room changed before that action was applied. Synchronizing now.',
  PARTICIPANT_NOT_FOUND: 'That participant is no longer available.',
  ROOM_CLOSED: 'This Watch Party room has closed.',
  INTERNAL_ERROR: 'Watch Party is temporarily unavailable.',
};

const NON_RECOVERABLE = new Set<WatchPartyErrorCode>([
  'UNSUPPORTED_VERSION', 'INVALID_TICKET', 'TICKET_EXPIRED', 'ORIGIN_FORBIDDEN',
  'ROOM_NOT_FOUND', 'ROOM_EXPIRED', 'ROOM_CLOSED',
]);

export function watchPartyError(code: WatchPartyErrorCode, retryAfterMs?: number): WatchPartyUiError {
  return { code, message: PUBLIC_MESSAGES[code], recoverable: !NON_RECOVERABLE.has(code),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs: Math.max(1, Math.min(60_000, retryAfterMs)) }) };
}

export function watchPartyNetworkError(): WatchPartyUiError {
  return { code: 'NETWORK', message: 'The Watch Party connection was interrupted.', recoverable: true };
}

export function watchPartyProtocolError(): WatchPartyUiError {
  return { code: 'PROTOCOL', message: 'The Watch Party server sent an invalid response.', recoverable: false };
}

export function watchPartyUnavailableError(): WatchPartyUiError {
  return { code: 'UNAVAILABLE', message: 'Watch Party is unavailable for this title.', recoverable: true };
}
