import type { AuthEmailKind, AuthEmailSender } from "./auth-email";
import { createAuth } from "./auth";

interface RetryRow {
  account_id: string;
  kind: AuthEmailKind;
  attempts: number;
}

export async function processAuthEmailRetry(
  env: Env,
  retryId: string,
  sender?: AuthEmailSender,
): Promise<void> {
  const retry = await env.DB.prepare(
    `UPDATE auth_email_retries
     SET status = 'sending', attempts = attempts + 1,
         available_at = unixepoch() + 300, updated_at = unixepoch()
     WHERE id = ? AND attempts < 5 AND available_at <= unixepoch()
       AND status IN ('pending', 'sending')
     RETURNING account_id, kind, attempts`,
  ).bind(retryId).first<RetryRow>();
  if (!retry) {
    const state = await env.DB.prepare("SELECT status FROM auth_email_retries WHERE id = ?")
      .bind(retryId).first<{ status: string }>();
    if (state?.status === "pending" || state?.status === "sending") {
      throw Object.assign(new Error("Auth email retry is not ready."), { code: "AUTH_RETRY_NOT_READY" });
    }
    return;
  }

  const account = await env.DB.prepare(
    "SELECT email, email_verified, is_suspended FROM accounts WHERE id = ?",
  ).bind(retry.account_id).first<{ email: string; email_verified: number; is_suspended: number }>();
  if (!account || account.is_suspended === 1 || (retry.kind === "verification" && account.email_verified === 1)) {
    await finishRetry(env.DB, retryId, account ? "sent" : "abandoned");
    return;
  }

  try {
    const origin = firstTrustedWebOrigin(env.TRUSTED_WEB_ORIGINS);
    const auth = createAuth(env, undefined, {
      requestId: `email-retry:${retryId}`,
      emailFailureMode: "throw",
      emailSender: sender,
    });
    const path = retry.kind === "verification" ? "/v1/auth/send-verification-email" : "/v1/auth/request-password-reset";
    const body = retry.kind === "verification"
      ? { email: account.email, callbackURL: `${origin}/auth/verified` }
      : { email: account.email, redirectTo: `${origin}/reset-password` };
    const response = await auth.handler(new Request(new URL(path, env.AUTH_BASE_URL), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        "cf-connecting-ip": "127.0.0.1",
      },
      body: JSON.stringify(body),
    }));
    if (!response.ok) throw Object.assign(new Error("Auth email retry was rejected."), { code: "AUTH_RETRY_REJECTED" });
    await finishRetry(env.DB, retryId, "sent");
  } catch (error) {
    const code = safeRetryCode(error);
    if (retry.attempts >= 5) {
      await env.DB.prepare(
        `UPDATE auth_email_retries SET status = 'abandoned', last_error_code = ?, updated_at = unixepoch()
         WHERE id = ?`,
      ).bind(code, retryId).run();
      return;
    }
    const delay = Math.min(3600, 30 * 2 ** retry.attempts);
    await env.DB.prepare(
      `UPDATE auth_email_retries
       SET status = 'pending', available_at = unixepoch() + ?, last_error_code = ?, updated_at = unixepoch()
       WHERE id = ?`,
    ).bind(delay, code, retryId).run();
    throw error;
  }
}

async function finishRetry(db: D1Database, retryId: string, status: "sent" | "abandoned"): Promise<void> {
  await db.prepare(
    "UPDATE auth_email_retries SET status = ?, updated_at = unixepoch() WHERE id = ?",
  ).bind(status, retryId).run();
}

function firstTrustedWebOrigin(value: string): string {
  const origin = value.split(",").map((entry) => entry.trim()).find(Boolean);
  if (!origin) throw Object.assign(new Error("No trusted web origin."), { code: "AUTH_RETRY_ORIGIN_MISSING" });
  return new URL(origin).origin;
}

function safeRetryCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const value = String((error as { code: unknown }).code).toUpperCase().replace(/[^A-Z0-9_]/gu, "_");
    if (value.length >= 1 && value.length <= 64) return value;
  }
  return "EMAIL_RETRY_FAILED";
}
