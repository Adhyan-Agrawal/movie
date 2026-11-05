import {
  buildPasswordResetEmail,
  buildVerificationEmail,
  sendTransactionalEmail,
  type TransactionalEmail,
} from "./email";

export type AuthEmailKind = "verification" | "password_reset";
export type EmailFailureMode = "queue" | "throw";

export interface AuthEmailTask {
  kind: AuthEmailKind;
  accountId: string;
  url: string;
  email: TransactionalEmail;
}

export type AuthEmailSender = (env: Env, task: AuthEmailTask) => Promise<void>;

export interface AuthEmailRuntime {
  executionContext?: ExecutionContext;
  failureMode: EmailFailureMode;
  requestId?: string;
  sender?: AuthEmailSender;
}

export function verificationTask(accountId: string, email: string, url: string): AuthEmailTask {
  return { kind: "verification", accountId, url, email: buildVerificationEmail(email, url) };
}

export function passwordResetTask(accountId: string, email: string, url: string): AuthEmailTask {
  return { kind: "password_reset", accountId, url, email: buildPasswordResetEmail(email, url) };
}

export async function scheduleAuthEmail(env: Env, task: AuthEmailTask, runtime: AuthEmailRuntime): Promise<void> {
  const delivery = deliverAuthEmail(env, task, runtime);
  if (runtime.executionContext) {
    runtime.executionContext.waitUntil(delivery);
    return;
  }
  await delivery;
}

export function sanitizedEmailErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = String((error as { code: unknown }).code).toUpperCase().replace(/[^A-Z0-9_]/gu, "_");
    if (code.length >= 1 && code.length <= 64) return code;
  }
  return "EMAIL_DELIVERY_FAILED";
}

async function deliverAuthEmail(env: Env, task: AuthEmailTask, runtime: AuthEmailRuntime): Promise<void> {
  try {
    await (runtime.sender ?? defaultAuthEmailSender)(env, task);
  } catch (error) {
    const errorCode = sanitizedEmailErrorCode(error);
    console.log(JSON.stringify({
      event: "auth_email_delivery_failed",
      kind: task.kind,
      errorCode,
      requestId: runtime.requestId,
      retryQueued: runtime.failureMode === "queue",
    }));
    if (runtime.failureMode === "queue") {
      await enqueueAuthEmailRetry(env.DB, task.kind, task.accountId, errorCode);
      return;
    }
    throw error;
  }
}

async function defaultAuthEmailSender(env: Env, task: AuthEmailTask): Promise<void> {
  await sendTransactionalEmail(env, task.email);
}

export async function enqueueAuthEmailRetry(
  db: D1Database,
  kind: AuthEmailKind,
  accountId: string,
  errorCode: string,
): Promise<string> {
  const retryId = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  await db.batch([
    db.prepare(
      `INSERT INTO auth_email_retries(
         id, account_id, kind, status, attempts, available_at, last_error_code
       ) VALUES (?, ?, ?, 'pending', 0, unixepoch() + 30, ?)
       ON CONFLICT(account_id, kind) DO UPDATE SET
         id = excluded.id,
         status = 'pending',
         attempts = 0,
         available_at = excluded.available_at,
         last_error_code = excluded.last_error_code,
         updated_at = unixepoch()`,
    ).bind(retryId, accountId, kind, errorCode),
    db.prepare(
      `INSERT INTO outbox_events(id, topic, aggregate_type, aggregate_id, payload, available_at)
       VALUES (?, 'auth.email.retry', 'auth_email_retry', ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+30 seconds'))`,
    ).bind(eventId, retryId, JSON.stringify({ retryId })),
  ]);
  return retryId;
}
