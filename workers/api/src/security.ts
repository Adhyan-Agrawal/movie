import { API_LIMITS } from "@lumora/api-contract";
import { ApiHttpError } from "./http";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface OriginPolicy {
  trustedOrigins: ReadonlySet<string>;
  requestOrigin: string | null;
}

export function parseExactOrigins(env: Env): ReadonlySet<string> {
  const entries = `${env.TRUSTED_WEB_ORIGINS},${env.TRUSTED_MOBILE_ORIGINS}`
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const origins = new Set<string>();
  for (const entry of entries) {
    if (entry.includes("*")) throw new Error("Trusted origins must not contain wildcards.");
    const parsed = new URL(entry);
    origins.add(parsed.origin === "null" ? entry.replace(/\/$/u, "") : parsed.origin);
  }
  return origins;
}

export function enforceRequestEnvelope(request: Request, trustedOrigins: ReadonlySet<string>): OriginPolicy {
  const url = new URL(request.url);
  if (url.search.length > API_LIMITS.queryCharacters) {
    throw new ApiHttpError(414, "bad_request", "Query string is too long.");
  }

  const rawOrigin = request.headers.get("origin");
  const requestOrigin = rawOrigin ? normalizeOrigin(rawOrigin) : null;
  if (requestOrigin && !trustedOrigins.has(requestOrigin)) {
    throw new ApiHttpError(403, "forbidden", "Origin is not allowed.");
  }

  if (MUTATING_METHODS.has(request.method)) {
    const fetchSite = request.headers.get("sec-fetch-site")?.toLowerCase();
    if (fetchSite === "cross-site") {
      throw new ApiHttpError(403, "forbidden", "Cross-site mutation rejected.");
    }
  }
  return { trustedOrigins, requestOrigin };
}

function normalizeOrigin(raw: string): string {
  if (raw.length > 512) throw new ApiHttpError(403, "forbidden", "Origin is not allowed.");
  try {
    const parsed = new URL(raw);
    return parsed.origin === "null" ? raw.replace(/\/$/u, "") : parsed.origin;
  } catch {
    throw new ApiHttpError(403, "forbidden", "Origin is not allowed.");
  }
}

export function addCors(response: Response, policy: OriginPolicy): Response {
  const headers = new Headers(response.headers);
  headers.append("vary", "Origin");
  if (policy.requestOrigin && policy.trustedOrigins.has(policy.requestOrigin)) {
    headers.set("access-control-allow-origin", policy.requestOrigin);
    headers.set("access-control-allow-credentials", "true");
  }
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function preflight(request: Request, policy: OriginPolicy): Response {
  const requestedMethod = request.headers.get("access-control-request-method")?.toUpperCase();
  if (!requestedMethod || !["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(requestedMethod)) {
    throw new ApiHttpError(400, "bad_request", "Invalid preflight request.");
  }
  const headers = new Headers({
    "access-control-allow-methods": "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
    "access-control-allow-headers": "Content-Type, Cookie, Idempotency-Key, If-Match, Range",
    "access-control-max-age": "600",
  });
  return addCors(new Response(null, { status: 204, headers }), policy);
}

export async function hmacSha256(secret: string, value: Uint8Array | string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  const data = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, data));
}

export async function verifyHmac(secret: string, value: Uint8Array | string, signature: Uint8Array): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const data = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return crypto.subtle.verify("HMAC", key, signature, data);
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function rateLimit(
  env: Env,
  request: Request,
  namespace: string,
  maximum: number,
  windowSeconds = 60,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - (now % windowSeconds);
  const address = trustedClientIp(request) ?? "unavailable";
  const digest = await hmacSha256(env.MEDIA_SIGNING_SECRET, address);
  const identity = [...digest].slice(0, 16).map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const bucket = `${namespace}:${identity}`;
  const row = await env.DB.prepare(
    `INSERT INTO api_rate_limits(bucket, window_start, count, expires_at)
     VALUES (?, ?, 1, ?)
     ON CONFLICT(bucket, window_start) DO UPDATE SET count = count + 1
     RETURNING count`,
  ).bind(bucket, windowStart, windowStart + windowSeconds * 2).first<{ count: number }>();
  if (!row || row.count > maximum) throw new ApiHttpError(429, "rate_limited", "Too many requests.");
}

export function trustedClientIp(request: Request): string | null {
  const value = request.headers.get("cf-connecting-ip")?.trim();
  if (!value || value.length > 64 || value.includes(",")) return null;
  const ipv4 = value.split(".");
  if (ipv4.length === 4 && ipv4.every((part) => /^\d{1,3}$/u.test(part) && Number(part) <= 255)) {
    return ipv4.map((part) => String(Number(part))).join(".");
  }
  if (!value.includes(":")) return null;
  try {
    const hostname = new URL(`http://[${value}]/`).hostname;
    return hostname.length > 2 ? hostname.slice(1, -1).toLowerCase() : null;
  } catch {
    return null;
  }
}

export function requestId(request: Request): string {
  const candidate = request.headers.get("cf-ray");
  return candidate && /^[A-Za-z0-9-]{1,100}$/u.test(candidate) ? candidate : crypto.randomUUID();
}

export function safeLog(event: string, id: string, status: number): void {
  console.log(JSON.stringify({ event, requestId: id, status }));
}
