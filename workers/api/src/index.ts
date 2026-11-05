import { AccountCoordinator, PlanCoordinator } from "./durable-objects";
import { ApiHttpError, errorResponse, json } from "./http";
import { consumeQueue, publishOutbox } from "./outbox";
import { assertRuntimeReady } from "./readiness";
import { routeRequest } from "./routes";
import { addCors, enforceRequestEnvelope, parseExactOrigins, preflight, requestId, safeLog } from "./security";

export { AccountCoordinator, PlanCoordinator };

export default {
  async fetch(request, env, executionContext): Promise<Response> {
    const id = requestId(request);
    const authResponseHeaders = new Headers();
    let policy;
    try {
      policy = enforceRequestEnvelope(request, parseExactOrigins(env));
      if (request.method === "OPTIONS") return preflight(request, policy);
      if (new URL(request.url).pathname !== "/v1/health") assertRuntimeReady(env);
      const response = await routeRequest(request, env, executionContext, id, authResponseHeaders);
      if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
        executionContext.waitUntil(publishOutbox(env));
      }
      const headers = new Headers(response.headers);
      appendSetCookies(headers, authResponseHeaders);
      if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
      const secured = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
      safeLog("api_request", id, response.status);
      return addCors(secured, policy);
    } catch (error) {
      const response = error instanceof ApiHttpError
        ? errorResponse(error, id)
        : json({ error: { code: "internal_error", message: "Internal server error.", requestId: id } }, { status: 500 });
      const headers = new Headers(response.headers);
      appendSetCookies(headers, authResponseHeaders);
      const responseWithAuthHeaders = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
      safeLog("api_request_failed", id, response.status);
      return policy ? addCors(responseWithAuthHeaders, policy) : responseWithAuthHeaders;
    }
  },

  async queue(batch, env): Promise<void> {
    await consumeQueue(batch, env);
  },

  async scheduled(_controller, env, executionContext): Promise<void> {
    executionContext.waitUntil(Promise.all([
      publishOutbox(env),
      env.DB.prepare("DELETE FROM api_rate_limits WHERE expires_at < unixepoch()").run(),
      env.DB.prepare("DELETE FROM api_idempotency WHERE expires_at < unixepoch()").run(),
      env.DB.prepare("DELETE FROM media_capabilities WHERE expires_at < unixepoch()").run(),
      env.DB.prepare(
        `DELETE FROM auth_email_retries
         WHERE (status = 'sent' AND updated_at < unixepoch() - 2592000)
            OR (status = 'abandoned' AND updated_at < unixepoch() - 7776000)`,
      ).run(),
    ]).then(() => undefined));
  },
} satisfies ExportedHandler<Env>;

function appendSetCookies(target: Headers, source: Headers): void {
  for (const cookie of source.getSetCookie()) target.append("set-cookie", cookie);
}
