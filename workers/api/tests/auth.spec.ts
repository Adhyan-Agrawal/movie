import { SELF, createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuth } from "../src/auth";
import { processAuthEmailRetry } from "../src/auth-email-retry";
import type { AuthEmailTask } from "../src/auth-email";

const WEB_ORIGIN = "http://localhost:3000";
const API_ORIGIN = "http://localhost:8787";
const TEST_PASSWORD = "Correct-Horse-Battery-Staple-123!";
let signUpIpOctet = 50;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Better Auth D1 integration", () => {
  it("verifies a real captured link before allowing sign-in", async () => {
    const account = await createVerifiedAccount("real-link");
    expect(account.verification.url).toContain("/v1/auth/verify-email?token=");
    expect(account.profileCount).toBe(1);

    const signIn = await signInAccount(account.email, TEST_PASSWORD, "203.0.113.9", "198.51.100.200");
    expect(signIn.response.status).toBe(200);
    expect(signIn.cookie).toContain("lumora.session_token=");
    const sessionRow = await env.DB.prepare(
      "SELECT ip_address FROM auth_sessions WHERE user_id = ?",
    ).bind(account.id).first<{ ip_address: string | null }>();
    expect(sessionRow?.ip_address).toBe("203.0.113.9");
  });

  it("forwards renewal cookies from canonical and protected session reads", async () => {
    const account = await createVerifiedAccount("renewal");
    const signIn = await signInAccount(account.email, TEST_PASSWORD);
    await ageSession(account.id);

    const canonical = await SELF.fetch("http://example.com/v1/session", {
      headers: authHeaders(signIn.cookie),
    });
    expect(canonical.status).toBe(200);
    expect((await canonical.json() as { authenticated: boolean }).authenticated).toBe(true);
    expect(sessionCookieHeaders(canonical).some((cookie) => /Max-Age=2592000/iu.test(cookie))).toBe(true);
    const renewed = await env.DB.prepare(
      "SELECT expires_at FROM auth_sessions WHERE user_id = ?",
    ).bind(account.id).first<{ expires_at: number }>();
    expect(renewed?.expires_at).toBeGreaterThan(Date.now() + 29 * 24 * 60 * 60 * 1000);

    await ageSession(account.id);
    const protectedResponse = await SELF.fetch("http://example.com/v1/account", {
      headers: authHeaders(signIn.cookie),
    });
    expect(protectedResponse.status).toBe(200);
    expect(sessionCookieHeaders(protectedResponse).some((cookie) => /Max-Age=2592000/iu.test(cookie))).toBe(true);
  });

  it("clears expired cookies on canonical and protected responses", async () => {
    const account = await createVerifiedAccount("expiry");
    const signIn = await signInAccount(account.email, TEST_PASSWORD);
    await env.DB.prepare(
      "UPDATE auth_sessions SET expires_at = ? WHERE user_id = ?",
    ).bind(Date.now() - 1_000, account.id).run();

    const canonical = await SELF.fetch("http://example.com/v1/session", {
      headers: authHeaders(signIn.cookie),
    });
    expect(canonical.status).toBe(200);
    expect((await canonical.json() as { authenticated: boolean }).authenticated).toBe(false);
    expect(hasClearingCookie(canonical)).toBe(true);

    const protectedResponse = await SELF.fetch("http://example.com/v1/account", {
      headers: authHeaders(signIn.cookie),
    });
    expect(protectedResponse.status).toBe(401);
    expect(hasClearingCookie(protectedResponse)).toBe(true);
  });

  it("clears logout and suspended sessions", async () => {
    const logoutAccount = await createVerifiedAccount("logout");
    const logoutSignIn = await signInAccount(logoutAccount.email, TEST_PASSWORD);
    const logout = await SELF.fetch("http://example.com/v1/auth/sign-out", {
      method: "POST",
      headers: authHeaders(logoutSignIn.cookie),
    });
    expect(logout.status).toBe(200);
    expect(hasClearingCookie(logout)).toBe(true);
    expect(await sessionCount(logoutAccount.id)).toBe(0);

    const suspendedAccount = await createVerifiedAccount("suspended");
    const suspendedSignIn = await signInAccount(suspendedAccount.email, TEST_PASSWORD);
    await env.DB.prepare("UPDATE accounts SET is_suspended = 1 WHERE id = ?").bind(suspendedAccount.id).run();
    const suspended = await SELF.fetch("http://example.com/v1/account", {
      headers: authHeaders(suspendedSignIn.cookie),
    });
    expect(suspended.status).toBe(403);
    expect(hasClearingCookie(suspended)).toBe(true);
    expect(await sessionCount(suspendedAccount.id)).toBe(0);
  });

  it("returns a generic invalid-credential response for a legacy bcrypt hash", async () => {
    const account = await createVerifiedAccount("legacy");
    const wrongPassword = await signInResponse(account.email, "Incorrect-Password-123!", "203.0.113.20");
    expect(wrongPassword.status).toBe(401);
    const genericError = await wrongPassword.json();

    await env.DB.prepare(
      `UPDATE auth_accounts SET password = ?
       WHERE user_id = ? AND provider_id = 'credential'`,
    ).bind("$2b$12$abcdefghijklmnopqrstuuSxG5QvQ6pQPXmW6nGukdMZtV5ZiL0y", account.id).run();
    const legacy = await signInResponse(account.email, TEST_PASSWORD, "203.0.113.21");
    expect(legacy.status).toBe(401);
    expect(await legacy.json()).toEqual(genericError);
    expect(await sessionCount(account.id)).toBe(0);
  });

  it("keys auth rate limits from CF-Connecting-IP and ignores forwarded IPs", async () => {
    const requestReset = (cfIp: string, forwardedIp: string) => SELF.fetch(
      "http://example.com/v1/auth/request-password-reset",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: WEB_ORIGIN,
          "cf-connecting-ip": cfIp,
          "x-forwarded-for": forwardedIp,
        },
        body: JSON.stringify({
          email: `unknown-${crypto.randomUUID()}@example.test`,
          redirectTo: `${WEB_ORIGIN}/reset-password`,
        }),
      },
    );
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await requestReset("203.0.113.30", `198.51.100.${attempt + 1}`)).status).toBe(200);
    }
    expect((await requestReset("203.0.113.30", "198.51.100.99")).status).toBe(429);
    expect((await requestReset("203.0.113.31", "198.51.100.99")).status).toBe(200);
  });

  it("keeps reset responses generic for known and unknown addresses", async () => {
    const account = await createVerifiedAccount("reset-generic");
    const requestReset = (address: string) => SELF.fetch("http://example.com/v1/auth/request-password-reset", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: WEB_ORIGIN,
        "cf-connecting-ip": "203.0.113.40",
      },
      body: JSON.stringify({ email: address, redirectTo: `${WEB_ORIGIN}/reset-password` }),
    });
    const known = await requestReset(account.email);
    const unknown = await requestReset(`unknown-${crypto.randomUUID()}@example.test`);
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(await known.json()).toEqual(await unknown.json());
  });

  it("queues only an opaque retry ID after a sanitized email failure", async () => {
    const email = `retry-${crypto.randomUUID()}@example.test`;
    const executionContext = createExecutionContext();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const auth = createAuth(env, executionContext, {
      requestId: "email-failure-test",
      emailSender: async (_runtimeEnv, task) => {
        throw Object.assign(new Error(`must-not-log ${task.email.to} ${task.url}`), { code: "provider-temporary" });
      },
    });
    const response = await auth.handler(signUpRequest(email));
    expect(response.status).toBe(200);
    await waitOnExecutionContext(executionContext);

    const account = await env.DB.prepare("SELECT id FROM accounts WHERE email = ?")
      .bind(email).first<{ id: string }>();
    const retry = await env.DB.prepare(
      "SELECT id, status, last_error_code FROM auth_email_retries WHERE account_id = ?",
    ).bind(account?.id).first<{ id: string; status: string; last_error_code: string }>();
    expect(retry).toMatchObject({ status: "pending", last_error_code: "PROVIDER_TEMPORARY" });
    const outbox = await env.DB.prepare(
      "SELECT payload FROM outbox_events WHERE topic = 'auth.email.retry' AND aggregate_id = ?",
    ).bind(retry?.id).first<{ payload: string }>();
    expect(JSON.parse(outbox?.payload ?? "null")).toEqual({ retryId: retry?.id });
    expect(outbox?.payload).not.toContain(email);
    expect(outbox?.payload).not.toContain("token");
    const logs = log.mock.calls.flat().join(" ");
    expect(logs).toContain("PROVIDER_TEMPORARY");
    expect(logs).not.toContain(email);
    expect(logs).not.toContain("token=");
    log.mockRestore();

    await env.DB.prepare("UPDATE auth_email_retries SET available_at = unixepoch() WHERE id = ?")
      .bind(retry?.id).run();
    let replayed: AuthEmailTask | undefined;
    await processAuthEmailRetry(env, retry?.id ?? "", async (_runtimeEnv, task) => { replayed = task; });
    expect(replayed?.kind).toBe("verification");
    expect(replayed?.url).toContain("/v1/auth/verify-email?token=");
    const retryAfter = await env.DB.prepare("SELECT status FROM auth_email_retries WHERE id = ?")
      .bind(retry?.id).first<{ status: string }>();
    expect(retryAfter?.status).toBe("sent");

    const verify = await SELF.fetch(replayed?.url ?? "", { redirect: "manual" });
    expect(verify.status).toBe(302);
    const verified = await env.DB.prepare("SELECT email_verified FROM accounts WHERE id = ?")
      .bind(account?.id).first<{ email_verified: number }>();
    expect(verified?.email_verified).toBe(1);
  });
});

async function createVerifiedAccount(label: string) {
  const email = `${label}-${crypto.randomUUID()}@example.test`;
  let verification: AuthEmailTask | undefined;
  const auth = createAuth(env, undefined, {
    requestId: `verify-${label}`,
    emailFailureMode: "throw",
    emailSender: async (_runtimeEnv, task) => { verification = task; },
  });
  const signUp = await auth.handler(signUpRequest(email));
  expect(signUp.status).toBe(200);
  const account = await env.DB.prepare(
    "SELECT id, email_verified FROM accounts WHERE email = ?",
  ).bind(email).first<{ id: string; email_verified: number }>();
  expect(account?.email_verified).toBe(0);
  expect(verification?.kind).toBe("verification");

  const verify = await SELF.fetch(verification?.url ?? "", { redirect: "manual" });
  expect(verify.status).toBe(302);
  expect(verify.headers.get("location")).toContain(`${WEB_ORIGIN}/auth/verified`);
  const verified = await env.DB.prepare(
    "SELECT email_verified FROM accounts WHERE id = ?",
  ).bind(account?.id).first<{ email_verified: number }>();
  expect(verified?.email_verified).toBe(1);
  const profiles = await env.DB.prepare(
    "SELECT count(*) AS count FROM profiles WHERE account_id = ?",
  ).bind(account?.id).first<{ count: number }>();
  if (!account || !verification) throw new Error("Account verification fixture was not created.");
  return { id: account.id, email, verification, profileCount: profiles?.count ?? 0 };
}

function signUpRequest(email: string): Request {
  signUpIpOctet += 1;
  return new Request(`${API_ORIGIN}/v1/auth/sign-up/email`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: WEB_ORIGIN,
      "cf-connecting-ip": `203.0.113.${signUpIpOctet}`,
    },
    body: JSON.stringify({
      email,
      password: TEST_PASSWORD,
      name: "Auth Viewer",
      callbackURL: `${WEB_ORIGIN}/auth/verified`,
    }),
  });
}

async function signInAccount(email: string, password: string, cfIp = "203.0.113.10", forwardedIp = "198.51.100.10") {
  const response = await signInResponse(email, password, cfIp, forwardedIp);
  const setCookie = sessionCookieHeaders(response).find((cookie) => cookie.includes("lumora.session_token="));
  const cookie = setCookie?.split(";", 1)[0] ?? "";
  return { response, cookie };
}

function signInResponse(email: string, password: string, cfIp: string, forwardedIp = "198.51.100.10") {
  return SELF.fetch("http://example.com/v1/auth/sign-in/email", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: WEB_ORIGIN,
      "cf-connecting-ip": cfIp,
      "x-forwarded-for": forwardedIp,
    },
    body: JSON.stringify({ email, password }),
  });
}

function authHeaders(cookie: string): HeadersInit {
  return {
    cookie,
    origin: WEB_ORIGIN,
    "cf-connecting-ip": "203.0.113.10",
  };
}

function sessionCookieHeaders(response: Response): string[] {
  return response.headers.getSetCookie().filter((cookie) => cookie.includes("lumora.session_token="));
}

function hasClearingCookie(response: Response): boolean {
  return sessionCookieHeaders(response).some((cookie) => /Max-Age=0/iu.test(cookie));
}

async function ageSession(accountId: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE auth_sessions SET expires_at = ?, updated_at = ? WHERE user_id = ?",
  ).bind(Date.now() + 24 * 60 * 60 * 1000, Date.now() - 29 * 24 * 60 * 60 * 1000, accountId).run();
}

async function sessionCount(accountId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT count(*) AS count FROM auth_sessions WHERE user_id = ?")
    .bind(accountId).first<{ count: number }>();
  return row?.count ?? 0;
}
