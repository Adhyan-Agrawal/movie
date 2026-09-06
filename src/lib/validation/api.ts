/**
 * Standard API envelope (Section 14).
 *
 * Every API/route handler response uses `{ data, error, requestId }`. The
 * `requestId` correlates a client response with structured server logs. Use the
 * {@link ok} / {@link fail} constructors so the shape stays consistent.
 */

export interface ApiError {
  /** Stable machine-readable code, e.g. `not_found`, `forbidden`, `invalid`. */
  code: string;
  /** Human-readable, safe-to-surface message (never leak internals/secrets). */
  message: string;
  /** Optional structured detail (e.g. Zod field issues). */
  details?: unknown;
}

export type ApiResult<T> =
  | { data: T; error: null; requestId: string }
  | { data: null; error: ApiError; requestId: string };

/** Generate a correlation id (uses crypto.randomUUID when available). */
export function newRequestId(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Build a successful envelope. */
export function ok<T>(data: T, requestId: string = newRequestId()): ApiResult<T> {
  return { data, error: null, requestId };
}

/** Build a failed envelope. */
export function fail(error: ApiError, requestId: string = newRequestId()): ApiResult<never> {
  return { data: null, error, requestId };
}

/** Convenience constructor for an {@link ApiError}. */
export function apiError(code: string, message: string, details?: unknown): ApiError {
  return details === undefined ? { code, message } : { code, message, details };
}

/** Narrowing guard: did the call succeed? */
export function isOk<T>(
  result: ApiResult<T>,
): result is { data: T; error: null; requestId: string } {
  return result.error === null;
}
