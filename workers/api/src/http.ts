import type { ApiError, ApiErrorCode } from "@lumora/api-contract";
import { API_LIMITS } from "@lumora/api-contract";

export class ApiHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
  }
}

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("x-content-type-options", "nosniff");
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function noContent(headers?: HeadersInit): Response {
  return new Response(null, { status: 204, headers });
}

export function errorResponse(error: ApiHttpError, requestId: string): Response {
  const body: ApiError = {
    error: {
      code: error.code,
      message: error.message,
      requestId,
      ...(error.fields ? { fields: error.fields } : {}),
    },
  };
  const headers = error.status === 429 ? { "retry-after": "60" } : undefined;
  return json(body, { status: error.status, headers });
}

export async function readJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new ApiHttpError(415, "bad_request", "Expected an application/json request body.");
  }

  const announcedLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(announcedLength) && announcedLength > API_LIMITS.bodyBytes) {
    throw new ApiHttpError(413, "body_too_large", "Request body is too large.");
  }
  if (!request.body) throw new ApiHttpError(400, "bad_request", "A request body is required.");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > API_LIMITS.bodyBytes) {
        await reader.cancel("body limit exceeded");
        throw new ApiHttpError(413, "body_too_large", "Request body is too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ApiHttpError(400, "bad_request", "Malformed JSON request body.");
  }
}

export function parseLimit(url: URL): number {
  const raw = url.searchParams.get("limit");
  if (raw === null) return API_LIMITS.pageSizeDefault;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > API_LIMITS.pageSizeMaximum) {
    throw new ApiHttpError(400, "validation_error", `limit must be between 1 and ${API_LIMITS.pageSizeMaximum}.`);
  }
  return value;
}

export function parseOffsetCursor(raw: string | null): number {
  if (!raw) return 0;
  if (raw.length > 512) throw new ApiHttpError(400, "validation_error", "Invalid pagination cursor.");
  try {
    const decoded = JSON.parse(new TextDecoder().decode(base64UrlDecode(raw))) as { offset?: unknown };
    if (!Number.isInteger(decoded.offset) || Number(decoded.offset) < 0 || Number(decoded.offset) > 100_000) {
      throw new Error("invalid offset");
    }
    return Number(decoded.offset);
  } catch {
    throw new ApiHttpError(400, "validation_error", "Invalid pagination cursor.");
  }
}

export function offsetCursor(offset: number): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify({ offset })));
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("invalid base64url");
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function asIsoDate(value: number | string): string {
  return typeof value === "number" ? new Date(value).toISOString() : value;
}

export function booleanValue(value: number | boolean): boolean {
  return value === true || value === 1;
}
