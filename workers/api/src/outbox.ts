import type { OutboxMessage } from "@lumora/api-contract";
import { processAuthEmailRetry } from "./auth-email-retry";
import { Repository } from "./repository";

export async function publishOutbox(env: Env): Promise<void> {
  const repository = new Repository(env.DB);
  const pending = await repository.pendingOutbox();
  if (pending.length === 0) return;
  const groups = [
    { queue: env.JOBS, messages: pending.filter((message) => message.topic !== "transcode.requested") },
    { queue: env.TRANSCODE_JOBS, messages: pending.filter((message) => message.topic === "transcode.requested") },
  ];
  for (const group of groups) {
    if (group.messages.length === 0) continue;
    try {
      await group.queue.sendBatch(group.messages.map((body) => ({ body })));
      await Promise.all(group.messages.map((message) => repository.markOutboxPublished(message.id)));
    } catch {
      await Promise.all(group.messages.map((message) => repository.markOutboxFailed(message.id)));
    }
  }
}

export async function consumeQueue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  const repository = new Repository(env.DB);
  for (const message of batch.messages) {
    const parsed = parseMessage(message.body);
    if (!parsed) {
      message.ack();
      continue;
    }
    const claimed = await repository.claimProcessedEvent("lumora-api", parsed.id);
    if (!claimed) {
      message.ack();
      continue;
    }
    try {
      await dispatch(parsed, env);
      message.ack();
    } catch {
      await repository.releaseProcessedEvent("lumora-api", parsed.id);
      message.retry({ delaySeconds: Math.min(300, 2 ** Math.min(message.attempts, 8)) });
    }
  }
}

async function dispatch(message: OutboxMessage, env: Env): Promise<void> {
  if (message.topic === "auth.email.retry") {
    const payload = message.payload as { retryId?: unknown };
    if (typeof payload.retryId !== "string" || !/^[0-9a-f-]{36}$/iu.test(payload.retryId)) {
      throw new Error("invalid auth email retry payload");
    }
    await processAuthEmailRetry(env, payload.retryId);
    return;
  }
  if (message.topic === "transcode.requested") {
    // The queue payload carries R2 keys and job metadata only. FFmpeg must run
    // in a separately configured Container/external service, never this Worker.
    throw new Error("external transcoder binding is not configured");
  }
  // Domain events without a Phase 1 side effect are still durably deduplicated.
}

function parseMessage(value: unknown): OutboxMessage | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<OutboxMessage>;
  if (typeof candidate.id !== "string" || typeof candidate.topic !== "string" ||
      typeof candidate.attempt !== "number" || typeof candidate.createdAt !== "string" ||
      candidate.payload === undefined) return null;
  return candidate as OutboxMessage;
}
