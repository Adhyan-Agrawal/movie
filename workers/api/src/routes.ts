import type { PermissionKey, SessionDto } from "@lumora/api-contract";
import { AUTH_PREFIX } from "@lumora/api-contract";
import type { ZodType } from "zod";
import { createAuth, type LumoraAuth } from "./auth";
import { ApiHttpError, json, noContent, parseLimit, parseOffsetCursor, readJson } from "./http";
import { createMediaCapability, serveMedia, signedMediaUrlForObject } from "./media";
import { Repository, type Principal } from "./repository";
import { runtimeReadiness } from "./readiness";
import {
  accountUpdateSchema,
  auditedReasonSchema,
  catalogTitleCreateSchema,
  mediaCapabilitySchema,
  planCreateSchema,
  playbackReportSchema,
  playbackSessionSchema,
  profileCreateSchema,
  profileUpdateSchema,
  progressSchema,
  providerCreateSchema,
  ratingSchema,
  settingSchema,
  subscriptionGrantSchema,
  suspensionSchema,
  titleRequestSchema,
  transcodeJobSchema,
  uuidSchema,
  vastSettingsSchema,
} from "./schemas";
import { rateLimit } from "./security";

interface RouteContext {
  request: Request;
  env: Env;
  executionContext: ExecutionContext;
  requestId: string;
  url: URL;
  repository: Repository;
  auth: LumoraAuth;
  authResponseHeaders: Headers;
  sessionPromise?: Promise<AuthSessionSnapshot | null>;
}

interface AuthSessionSnapshot {
  session: { expiresAt: string | Date };
  user: { id: string };
}

export async function routeRequest(
  request: Request,
  env: Env,
  executionContext: ExecutionContext,
  requestId: string,
  authResponseHeaders: Headers,
): Promise<Response> {
  const context: RouteContext = {
    request,
    env,
    executionContext,
    requestId,
    url: new URL(request.url),
    repository: new Repository(env.DB),
    auth: createAuth(env, executionContext, { requestId }),
    authResponseHeaders,
  };
  const path = context.url.pathname;

  if (path === AUTH_PREFIX || path.startsWith(`${AUTH_PREFIX}/`)) {
    return context.auth.handler(request);
  }

  if (path === "/v1/health") {
    onlyMethod(request, "GET");
    await env.DB.prepare("SELECT 1 AS healthy").first();
    return json({ ok: true, version: "v1", ...runtimeReadiness(env) }, {
      headers: { "cache-control": "no-store" },
    });
  }

  if (path === "/v1/session") {
    onlyMethod(request, "GET");
    const session = await getSession(context);
    if (!session) {
      const anonymous: SessionDto = { authenticated: false, account: null, expiresAt: null };
      return json(anonymous, { headers: { "cache-control": "no-store" } });
    }
    const principal = await principalForSession(context, session);
    const result: SessionDto = {
      authenticated: true,
      account: principal.account,
      expiresAt: toIso(session.session.expiresAt),
    };
    return json(result, { headers: { "cache-control": "no-store" } });
  }

  if (path === "/v1/account") {
    if (request.method === "GET") {
      return json((await requirePrincipal(context)).account, { headers: { "cache-control": "no-store" } });
    }
    if (request.method === "PATCH") {
      const principal = await requirePrincipal(context);
      const input = await body(context, accountUpdateSchema);
      return json(await context.repository.updateAccount(principal.account.id, input.displayName));
    }
    throw methodNotAllowed(["GET", "PATCH"]);
  }

  if (path === "/v1/profiles") {
    const principal = await requirePrincipal(context);
    if (request.method === "GET") return json({ data: await context.repository.listProfiles(principal.account.id) });
    if (request.method === "POST") {
      const input = await body(context, profileCreateSchema);
      const result = await env.ACCOUNT_COORDINATOR.getByName(principal.account.id)
        .createProfile(principal.account.id, input);
      if (!result.ok) throw new ApiHttpError(result.status, result.code, result.message);
      return json(result.value, { status: 201 });
    }
    throw methodNotAllowed(["GET", "POST"]);
  }

  let match = /^\/v1\/profiles\/([^/]+)$/u.exec(path);
  if (match?.[1]) {
    const profileId = parseUuid(match[1], "profileId");
    const principal = await requirePrincipal(context);
    if (request.method === "PATCH") {
      const input = await body(context, profileUpdateSchema);
      return json(await context.repository.updateProfile(principal.account.id, profileId, input));
    }
    if (request.method === "DELETE") {
      await env.ACCOUNT_COORDINATOR.getByName(principal.account.id).deleteProfile(principal.account.id, profileId);
      return noContent();
    }
    throw methodNotAllowed(["PATCH", "DELETE"]);
  }

  match = /^\/v1\/profiles\/([^/]+)\/watchlist$/u.exec(path);
  if (match?.[1]) {
    onlyMethod(request, "GET");
    const principal = await requirePrincipal(context);
    const profileId = parseUuid(match[1], "profileId");
    return json(await context.repository.listWatchlist(
      principal.account.id,
      profileId,
      parseOffsetCursor(context.url.searchParams.get("cursor")),
      parseLimit(context.url),
    ));
  }

  match = /^\/v1\/profiles\/([^/]+)\/watchlist\/([^/]+)$/u.exec(path);
  if (match?.[1] && match[2]) {
    const principal = await requirePrincipal(context);
    const profileId = parseUuid(match[1], "profileId");
    const titleId = parseUuid(match[2], "titleId");
    if (request.method === "PUT") {
      return json(await context.repository.addWatchlistTitle(principal.account.id, profileId, titleId));
    }
    if (request.method === "DELETE") {
      await context.repository.removeWatchlistTitle(principal.account.id, profileId, titleId);
      return noContent();
    }
    throw methodNotAllowed(["PUT", "DELETE"]);
  }

  match = /^\/v1\/profiles\/([^/]+)\/progress$/u.exec(path);
  if (match?.[1]) {
    onlyMethod(request, "GET");
    const principal = await requirePrincipal(context);
    return json(await context.repository.listProgress(
      principal.account.id,
      parseUuid(match[1], "profileId"),
      parseOffsetCursor(context.url.searchParams.get("cursor")),
      parseLimit(context.url),
    ));
  }

  match = /^\/v1\/profiles\/([^/]+)\/progress\/([^/]+)$/u.exec(path);
  if (match?.[1] && match[2]) {
    onlyMethod(request, "PUT");
    const principal = await requirePrincipal(context);
    const input = await body(context, progressSchema);
    return json(await context.repository.putProgress(
      principal.account.id,
      parseUuid(match[1], "profileId"),
      parseUuid(match[2], "titleId"),
      input,
    ));
  }

  match = /^\/v1\/profiles\/([^/]+)\/ratings\/([^/]+)$/u.exec(path);
  if (match?.[1] && match[2]) {
    const principal = await requirePrincipal(context);
    const profileId = parseUuid(match[1], "profileId");
    const titleId = parseUuid(match[2], "titleId");
    if (request.method === "PUT") {
      const input = await body(context, ratingSchema);
      return json(await context.repository.putRating(principal.account.id, profileId, titleId, input.value));
    }
    if (request.method === "DELETE") {
      await context.repository.deleteRating(principal.account.id, profileId, titleId);
      return noContent();
    }
    throw methodNotAllowed(["PUT", "DELETE"]);
  }

  if (path === "/v1/catalog/titles") {
    onlyMethod(request, "GET");
    const type = optionalEnum(context.url.searchParams.get("type"), ["movie", "tv"] as const, "type");
    const sort = optionalEnum(context.url.searchParams.get("sort"),
      ["trending", "newest", "oldest", "az", "score"] as const, "sort") ?? "trending";
    const query = boundedQuery(context.url.searchParams.get("query"), 200, "query");
    const genre = boundedQuery(context.url.searchParams.get("genre"), 100, "genre");
    return json(await context.repository.listPublicTitles({
      ...(type ? { type } : {}),
      ...(query ? { query } : {}),
      ...(genre ? { genre } : {}),
      sort,
      offset: parseOffsetCursor(context.url.searchParams.get("cursor")),
      limit: parseLimit(context.url),
    }), { headers: { "cache-control": "public, max-age=30, stale-while-revalidate=120" } });
  }

  match = /^\/v1\/catalog\/titles\/([^/]+)$/u.exec(path);
  if (match?.[1]) {
    onlyMethod(request, "GET");
    return json(await context.repository.publicTitle(parseUuid(match[1], "titleId")), {
      headers: { "cache-control": "public, max-age=60, stale-while-revalidate=300" },
    });
  }

  if (path === "/v1/catalog/genres") {
    onlyMethod(request, "GET");
    return json({ data: await context.repository.listGenres() }, {
      headers: { "cache-control": "public, max-age=300, stale-while-revalidate=3600" },
    });
  }

  if (path === "/v1/playback/resolve") {
    onlyMethod(request, "GET");
    const titleId = parseUuid(context.url.searchParams.get("titleId") ?? "", "titleId");
    const rawEpisodeId = context.url.searchParams.get("episodeId");
    const episodeId = rawEpisodeId ? parseUuid(rawEpisodeId, "episodeId") : null;
    const accountId = (await getSession(context))?.user.id ?? null;
    const [sourceRows, entitlements] = await Promise.all([
      context.repository.playbackSources(titleId, episodeId),
      context.repository.entitlements(accountId),
    ]);
    const sources = await Promise.all(sourceRows.map(async (source) => ({
      id: source.id,
      label: source.label,
      kind: source.kind,
      consentRequired: source.consentRequired,
      ...(source.reference?.startsWith("media/")
        ? { url: await signedMediaUrlForObject(env, accountId, source.reference) }
        : {}),
    })));
    return json({ sources, entitlements }, { headers: { "cache-control": "private, no-store" } });
  }

  if (path === "/v1/playback/sessions") {
    onlyMethod(request, "POST");
    const principal = await requirePrincipal(context);
    const input = await body(context, playbackSessionSchema);
    return json(await context.repository.createPlaybackSession(principal.account.id, input), { status: 201 });
  }

  if (path === "/v1/media/capabilities") {
    onlyMethod(request, "POST");
    const principal = await requirePermission(context, "provider.manage");
    const input = await body(context, mediaCapabilitySchema);
    return json(await createMediaCapability(env, principal.account.id, input.objectPrefix, input.ttlSeconds), { status: 201 });
  }

  match = /^\/v1\/media\/([^/]+)\/(.+)$/u.exec(path);
  if (match?.[1] && match[2]) {
    if (request.method !== "GET" && request.method !== "HEAD") throw methodNotAllowed(["GET", "HEAD"]);
    return serveMedia(request, env, match[1], match[2]);
  }

  if (path === "/v1/requests") {
    const principal = await requirePrincipal(context);
    if (request.method === "GET") {
      const allAccounts = context.url.searchParams.get("scope") === "all";
      if (allAccounts) assertPermission(principal, "catalog.read");
      return json(await context.repository.listRequests(
        principal.account.id,
        parseOffsetCursor(context.url.searchParams.get("cursor")),
        parseLimit(context.url),
        allAccounts,
      ));
    }
    if (request.method === "POST") {
      await rateLimit(env, request, "title-request", 5, 300);
      const input = await body(context, titleRequestSchema);
      return json(await context.repository.createRequest(principal.account.id, input), { status: 201 });
    }
    throw methodNotAllowed(["GET", "POST"]);
  }

  if (path === "/v1/reports/playback") {
    onlyMethod(request, "POST");
    await rateLimit(env, request, "playback-report", 10, 300);
    const accountId = (await getSession(context))?.user.id ?? null;
    const input = await body(context, playbackReportSchema);
    return json(await context.repository.createPlaybackReport(accountId, input), { status: 202 });
  }

  if (path === "/v1/commerce/plans") {
    onlyMethod(request, "GET");
    return json({ data: await context.repository.listPublicPlans() }, {
      headers: { "cache-control": "public, max-age=60, stale-while-revalidate=300" },
    });
  }

  if (path === "/v1/commerce/entitlements") {
    onlyMethod(request, "GET");
    return json(await context.repository.entitlements((await getSession(context))?.user.id ?? null), {
      headers: { "cache-control": "private, no-store" },
    });
  }

  if (path === "/v1/providers") {
    const principal = await requirePermission(context, "provider.manage");
    if (request.method === "GET") return json({ data: await context.repository.listProviders() });
    if (request.method === "POST") {
      const input = await body(context, providerCreateSchema);
      return json(await context.repository.createProvider(principal.account.id, input, requestId), { status: 201 });
    }
    throw methodNotAllowed(["GET", "POST"]);
  }

  if (path === "/v1/settings") {
    onlyMethod(request, "GET");
    return json(await context.repository.publicSettings(), {
      headers: { "cache-control": "public, max-age=60, stale-while-revalidate=300" },
    });
  }

  if (path === "/v1/admin/accounts") {
    onlyMethod(request, "GET");
    await requirePermission(context, "users.read");
    return json(await context.repository.listAccounts(
      parseOffsetCursor(context.url.searchParams.get("cursor")),
      parseLimit(context.url),
    ));
  }

  match = /^\/v1\/admin\/accounts\/([^/]+)\/suspension$/u.exec(path);
  if (match?.[1]) {
    onlyMethod(request, "PUT");
    const principal = await requirePermission(context, "users.suspend");
    const accountId = parseUuid(match[1], "accountId");
    const input = await body(context, suspensionSchema);
    return json(await env.ACCOUNT_COORDINATOR.getByName(accountId).setSuspension(
      principal.account.id, accountId, input.suspended, input.reason, requestId,
    ));
  }

  if (path === "/v1/admin/audit") {
    onlyMethod(request, "GET");
    await requirePermission(context, "audit.read");
    return json(await context.repository.listAudit(
      parseOffsetCursor(context.url.searchParams.get("cursor")),
      parseLimit(context.url),
    ));
  }

  if (path === "/v1/admin/plans") {
    onlyMethod(request, "POST");
    const principal = await requirePermission(context, "plans.manage");
    const input = await body(context, planCreateSchema);
    return json(await env.PLAN_COORDINATOR.getByName(input.slug).createPlan(
      principal.account.id, input, requestId,
    ), { status: 201 });
  }

  match = /^\/v1\/admin\/plans\/([^/]+)\/publish$/u.exec(path);
  if (match?.[1]) {
    onlyMethod(request, "POST");
    const principal = await requirePermission(context, "plans.manage");
    const planId = parseUuid(match[1], "planId");
    const input = await body(context, auditedReasonSchema);
    const slug = await context.repository.planSlug(planId);
    return json(await env.PLAN_COORDINATOR.getByName(slug).publishPlan(
      principal.account.id, slug, planId, input.reason, requestId,
    ));
  }

  if (path === "/v1/admin/subscriptions") {
    onlyMethod(request, "POST");
    const principal = await requirePermission(context, "plans.manage");
    const input = await body(context, subscriptionGrantSchema);
    return json(await env.ACCOUNT_COORDINATOR.getByName(input.accountId).grantSubscription(
      principal.account.id, input.accountId, input.planId, input.accessUntil, input.reason, requestId,
    ), { status: 201 });
  }

  match = /^\/v1\/admin\/subscriptions\/([^/]+)\/revoke$/u.exec(path);
  if (match?.[1]) {
    onlyMethod(request, "POST");
    const principal = await requirePermission(context, "plans.manage");
    const subscriptionId = parseUuid(match[1], "subscriptionId");
    const input = await body(context, auditedReasonSchema);
    const accountId = await context.repository.subscriptionAccountId(subscriptionId);
    return json(await env.ACCOUNT_COORDINATOR.getByName(accountId).revokeSubscription(
      principal.account.id, accountId, subscriptionId, input.reason, requestId,
    ));
  }

  if (path === "/v1/admin/media/transcodes") {
    onlyMethod(request, "POST");
    const principal = await requirePermission(context, "provider.manage");
    const idempotencyKey = context.request.headers.get("idempotency-key")?.trim();
    if (!idempotencyKey || !/^[A-Za-z0-9._:-]{8,128}$/u.test(idempotencyKey)) {
      throw new ApiHttpError(400, "validation_error", "A valid Idempotency-Key header is required.");
    }
    const input = await body(context, transcodeJobSchema);
    return json(await context.repository.createTranscodeJob(
      principal.account.id, input, idempotencyKey, requestId,
    ), { status: 202 });
  }

  if (path === "/v1/admin/ads/vast") {
    onlyMethod(request, "PUT");
    const principal = await requirePermission(context, "ads.manage");
    const input = await body(context, vastSettingsSchema);
    return json(await context.repository.saveVastSettings(principal.account.id, input, requestId));
  }

  match = /^\/v1\/admin\/settings\/([^/]+)$/u.exec(path);
  if (match?.[1]) {
    onlyMethod(request, "PUT");
    const principal = await requirePermission(context, "settings.manage");
    const key = decodeBoundedPath(match[1], 100);
    const input = await body(context, settingSchema);
    return json(await context.repository.saveSetting(principal.account.id, key, input, requestId));
  }

  if (path === "/v1/admin/catalog/titles") {
    onlyMethod(request, "POST");
    const principal = await requirePermission(context, "catalog.create");
    const input = await body(context, catalogTitleCreateSchema);
    if (input.status === "published") assertPermission(principal, "catalog.publish");
    return json(await context.repository.createTitle(principal.account.id, input, requestId), { status: 201 });
  }

  throw new ApiHttpError(404, "not_found", "Route not found.");
}

async function getSession(context: RouteContext) {
  context.sessionPromise ??= resolveSession(context);
  return context.sessionPromise;
}

async function resolveSession(context: RouteContext): Promise<AuthSessionSnapshot | null> {
  const result = await context.auth.api.getSession({
    headers: context.request.headers,
    returnHeaders: true,
  });
  appendSetCookies(context.authResponseHeaders, result.headers);
  if (!result.response && hasSessionCookie(context.request) && result.headers.getSetCookie().length === 0) {
    appendExpiredSessionCookies(context.request, context.authResponseHeaders);
  }
  return result.response;
}

async function requirePrincipal(context: RouteContext): Promise<Principal> {
  const session = await getSession(context);
  if (!session) throw new ApiHttpError(401, "unauthorized", "Authentication required.");
  return principalForSession(context, session);
}

async function principalForSession(context: RouteContext, session: AuthSessionSnapshot): Promise<Principal> {
  try {
    return await context.repository.principal(session.user.id);
  } catch (error) {
    if (error instanceof ApiHttpError && error.code === "session_suspended") {
      await context.env.DB.prepare("DELETE FROM auth_sessions WHERE user_id = ?").bind(session.user.id).run();
      appendExpiredSessionCookies(context.request, context.authResponseHeaders);
    }
    throw error;
  }
}

function appendSetCookies(target: Headers, source: Headers): void {
  for (const cookie of source.getSetCookie()) target.append("set-cookie", cookie);
}

function hasSessionCookie(request: Request): boolean {
  return /(?:^|;\s*)(?:__Secure-)?lumora\.session_token=/u.test(request.headers.get("cookie") ?? "");
}

function appendExpiredSessionCookies(request: Request, target: Headers): void {
  const names = new Set(
    (request.headers.get("cookie") ?? "")
      .split(";")
      .map((part) => part.slice(0, part.indexOf("=")).trim())
      .filter((name) => /^(?:__Secure-)?lumora\.session_token$/u.test(name)),
  );
  for (const name of names) {
    target.append(
      "set-cookie",
      `${name}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; HttpOnly; Secure; SameSite=Lax`,
    );
  }
}

async function requirePermission(context: RouteContext, permission: PermissionKey): Promise<Principal> {
  const principal = await requirePrincipal(context);
  assertPermission(principal, permission);
  return principal;
}

function assertPermission(principal: Principal, permission: PermissionKey): void {
  if (!principal.permissions.has(permission)) throw new ApiHttpError(403, "forbidden", "Permission denied.");
}

async function body<T>(context: RouteContext, schema: ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await readJson(context.request));
  if (parsed.success) return parsed.data;
  const fields: Record<string, string> = {};
  for (const issue of parsed.error.issues.slice(0, 20)) fields[issue.path.join(".") || "body"] = issue.message;
  throw new ApiHttpError(400, "validation_error", "Request validation failed.", fields);
}

function parseUuid(value: string, field: string): string {
  const parsed = uuidSchema.safeParse(decodeBoundedPath(value, 64));
  if (!parsed.success) throw new ApiHttpError(400, "validation_error", `${field} must be a UUID.`);
  return parsed.data;
}

function decodeBoundedPath(value: string, maximum: number): string {
  if (value.length > maximum * 3) throw new ApiHttpError(400, "validation_error", "Path parameter is too long.");
  try {
    const decoded = decodeURIComponent(value);
    if (decoded.length > maximum || decoded.includes("/") || decoded.includes("\\") || decoded.includes("\0")) throw new Error("invalid path");
    return decoded;
  } catch {
    throw new ApiHttpError(400, "validation_error", "Invalid path parameter.");
  }
}

function boundedQuery(value: string | null, maximum: number, field: string): string | undefined {
  if (value === null) return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new ApiHttpError(400, "validation_error", `${field} is invalid.`);
  }
  return normalized;
}

function optionalEnum<const T extends readonly string[]>(value: string | null, values: T, field: string): T[number] | undefined {
  if (value === null) return undefined;
  if (!values.includes(value)) throw new ApiHttpError(400, "validation_error", `${field} is invalid.`);
  return value as T[number];
}

function onlyMethod(request: Request, expected: string): void {
  if (request.method !== expected) throw methodNotAllowed([expected]);
}

function methodNotAllowed(methods: string[]): ApiHttpError {
  return new ApiHttpError(405, "method_not_allowed", `Allowed methods: ${methods.join(", ")}.`);
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
