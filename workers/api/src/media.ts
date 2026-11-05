import type { MediaCapabilityDto } from "@lumora/api-contract";
import { ApiHttpError, base64UrlDecode, base64UrlEncode } from "./http";
import { hmacSha256, sha256Hex, verifyHmac } from "./security";

interface CapabilityPayload {
  v: 1;
  id: string;
  prefix: string;
  exp: number;
  accountId: string | null;
  nonce: string;
}

export async function createMediaCapability(
  env: Env,
  accountId: string | null,
  objectPrefix: string,
  requestedTtl?: number,
): Promise<MediaCapabilityDto> {
  validatePrefix(objectPrefix);
  const configuredTtl = Number(env.MEDIA_CAPABILITY_TTL_SECONDS);
  const ttl = Math.min(requestedTtl ?? configuredTtl, configuredTtl, 900);
  if (!Number.isInteger(ttl) || ttl < 30) throw new ApiHttpError(500, "internal_error", "Media capability configuration is invalid.");
  const id = crypto.randomUUID();
  const nonce = crypto.randomUUID();
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const payload: CapabilityPayload = { v: 1, id, prefix: objectPrefix, exp, accountId, nonce };
  const encoded = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = base64UrlEncode(await hmacSha256(env.MEDIA_SIGNING_SECRET, encoded));
  await env.DB.prepare(
    `INSERT INTO media_capabilities(id, account_id, object_prefix, expires_at, nonce_hash)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind(id, accountId, objectPrefix, exp, await sha256Hex(nonce)).run();
  return {
    url: new URL(`/v1/media/${encoded}.${signature}/`, env.AUTH_BASE_URL).href,
    prefix: objectPrefix,
    expiresAt: new Date(exp * 1000).toISOString(),
    rangeSupported: true,
  };
}

export async function signedMediaUrlForObject(env: Env, accountId: string | null, objectKey: string): Promise<string> {
  validateObjectKey(objectKey);
  const slash = objectKey.lastIndexOf("/");
  if (slash < 0) throw new ApiHttpError(500, "internal_error", "Media object metadata is invalid.");
  const prefix = objectKey.slice(0, slash + 1);
  const filename = objectKey.slice(slash + 1);
  const capability = await createMediaCapability(env, accountId, prefix);
  return `${capability.url}${encodeURIComponent(filename)}`;
}

export async function serveMedia(
  request: Request,
  env: Env,
  capability: string,
  rawPath: string,
): Promise<Response> {
  const payload = await verifyCapability(env, capability);
  const relativePath = decodeMediaPath(rawPath);
  const key = `${payload.prefix}${relativePath}`;
  validateObjectKey(key);
  if (!key.startsWith(payload.prefix)) throw new ApiHttpError(403, "forbidden", "Invalid media path.");

  if (request.method === "HEAD") {
    const object = await env.MEDIA.head(key);
    if (!object) throw new ApiHttpError(404, "not_found", "Media object not found.");
    const headers = mediaHeaders(object);
    headers.set("content-length", String(object.size));
    return new Response(null, { status: 200, headers });
  }

  let object: R2ObjectBody | R2Object | null;
  try {
    object = await env.MEDIA.get(key, { onlyIf: request.headers, range: request.headers });
  } catch {
    throw new ApiHttpError(416, "bad_request", "Requested byte range is not satisfiable.");
  }
  if (!object) throw new ApiHttpError(404, "not_found", "Media object not found.");
  const headers = mediaHeaders(object);
  if (!("body" in object) || !object.body) return new Response(null, { status: 304, headers });

  let status = 200;
  if (object.range) {
    const range = object.range as { offset: number; length: number };
    status = 206;
    headers.set("content-range", `bytes ${range.offset}-${range.offset + range.length - 1}/${object.size}`);
    headers.set("content-length", String(range.length));
  } else {
    headers.set("content-length", String(object.size));
  }
  return new Response(object.body, { status, headers });
}

async function verifyCapability(env: Env, token: string): Promise<CapabilityPayload> {
  if (token.length > 4096) throw new ApiHttpError(403, "forbidden", "Invalid media capability.");
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new ApiHttpError(403, "forbidden", "Invalid media capability.");
  const signature = base64UrlDecode(parts[1]);
  if (!(await verifyHmac(env.MEDIA_SIGNING_SECRET, parts[0], signature))) {
    throw new ApiHttpError(403, "forbidden", "Invalid media capability.");
  }
  let payload: CapabilityPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[0]))) as CapabilityPayload;
  } catch {
    throw new ApiHttpError(403, "forbidden", "Invalid media capability.");
  }
  if (payload.v !== 1 || !isUuid(payload.id) || !isUuid(payload.nonce) || !Number.isInteger(payload.exp)) {
    throw new ApiHttpError(403, "forbidden", "Invalid media capability.");
  }
  validatePrefix(payload.prefix);
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp <= now) throw new ApiHttpError(403, "forbidden", "Media capability has expired.");
  const stored = await env.DB.prepare(
    `SELECT expires_at, nonce_hash FROM media_capabilities
     WHERE id = ? AND object_prefix = ? AND expires_at > ?`,
  ).bind(payload.id, payload.prefix, now).first<{ expires_at: number; nonce_hash: string }>();
  if (!stored || stored.expires_at !== payload.exp || stored.nonce_hash !== await sha256Hex(payload.nonce)) {
    throw new ApiHttpError(403, "forbidden", "Invalid media capability.");
  }
  return payload;
}

function mediaHeaders(object: R2Object): Headers {
  const headers = new Headers({
    "accept-ranges": "bytes",
    "cache-control": "private, no-store",
    "content-security-policy": "default-src 'none'",
    etag: object.httpEtag,
    "x-content-type-options": "nosniff",
  });
  object.writeHttpMetadata(headers);
  return headers;
}

function decodeMediaPath(rawPath: string): string {
  if (rawPath.length < 1 || rawPath.length > 1024 || /%2f|%5c/iu.test(rawPath)) {
    throw new ApiHttpError(400, "validation_error", "Invalid media path.");
  }
  try {
    const decoded = rawPath.split("/").map((segment) => decodeURIComponent(segment)).join("/");
    validateObjectKey(decoded);
    return decoded;
  } catch (error) {
    if (error instanceof ApiHttpError) throw error;
    throw new ApiHttpError(400, "validation_error", "Invalid media path.");
  }
}

function validatePrefix(prefix: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,1022}\/$/u.test(prefix)) {
    throw new ApiHttpError(400, "validation_error", "Invalid media prefix.");
  }
  validateObjectKey(prefix);
}

function validateObjectKey(key: string): void {
  if (key.length < 1 || key.length > 1024 || key.includes("\\") || key.includes("\0")) {
    throw new ApiHttpError(400, "validation_error", "Invalid media path.");
  }
  const segments = key.split("/");
  if (segments.some((segment) => segment === ".." || segment === ".")) {
    throw new ApiHttpError(400, "validation_error", "Invalid media path.");
  }
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}
