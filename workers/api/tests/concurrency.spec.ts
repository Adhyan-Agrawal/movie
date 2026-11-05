import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Repository } from "../src/repository";
import { seedAccount } from "./fixtures";

describe("coordination and idempotency", () => {
  it("serializes concurrent profile creation against the free profile limit", async () => {
    const accountId = crypto.randomUUID();
    await seedAccount(env.DB, accountId, "profiles@example.test");
    const coordinator = env.ACCOUNT_COORDINATOR.getByName(accountId);
    const writes = await Promise.all([
      coordinator.createProfile(accountId, { name: "One" }),
      coordinator.createProfile(accountId, { name: "Two" }),
    ]);
    expect(writes.filter((result) => result.ok)).toHaveLength(1);
    expect(writes.filter((result) => !result.ok && result.code === "conflict")).toHaveLength(1);
    const count = await env.DB.prepare("SELECT count(*) AS count FROM profiles WHERE account_id = ?")
      .bind(accountId).first<{ count: number }>();
    expect(count?.count).toBe(1);
  });

  it("allocates monotonic plan versions under concurrent writes", async () => {
    const actorId = crypto.randomUUID();
    await seedAccount(env.DB, actorId, "plans@example.test", { role: "owner" });
    const coordinator = env.PLAN_COORDINATOR.getByName("premium");
    const base = {
      slug: "premium",
      description: "Premium access",
      currency: "USD",
      priceMinor: 999,
      billingInterval: "month" as const,
      adFree: true,
      maxProfiles: 4,
      features: ["ad-free"],
      reason: "Concurrent version allocation test",
    };
    const [first, second] = await Promise.all([
      coordinator.createPlan(actorId, { ...base, name: "Premium A" }, crypto.randomUUID()),
      coordinator.createPlan(actorId, { ...base, name: "Premium B" }, crypto.randomUUID()),
    ]);
    expect([first.version, second.version].sort()).toEqual([1, 2]);
  });

  it("claims an at-least-once Queue event only once", async () => {
    const repository = new Repository(env.DB);
    const eventId = crypto.randomUUID();
    const claims = await Promise.all([
      repository.claimProcessedEvent("test-consumer", eventId),
      repository.claimProcessedEvent("test-consumer", eventId),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const count = await env.DB.prepare(
      "SELECT count(*) AS count FROM processed_events WHERE consumer = ? AND event_id = ?",
    ).bind("test-consumer", eventId).first<{ count: number }>();
    expect(count?.count).toBe(1);
  });

  it("replays an idempotent transcode enqueue without duplicating jobs", async () => {
    const actorId = crypto.randomUUID();
    await seedAccount(env.DB, actorId, "media@example.test", { role: "owner" });
    const repository = new Repository(env.DB);
    const request = {
      inputKey: "media/source/movie.mp4",
      outputPrefix: "media/hls/movie/",
      preset: "hls-adaptive" as const,
      reason: "Prepare adaptive HLS renditions",
    };
    const first = await repository.createTranscodeJob(actorId, request, "transcode-test-1", crypto.randomUUID());
    const replay = await repository.createTranscodeJob(actorId, request, "transcode-test-1", crypto.randomUUID());
    expect(replay.id).toBe(first.id);
    const jobs = await env.DB.prepare("SELECT count(*) AS count FROM transcode_jobs WHERE requested_by = ?")
      .bind(actorId).first<{ count: number }>();
    const events = await env.DB.prepare(
      "SELECT count(*) AS count FROM outbox_events WHERE topic = 'transcode.requested' AND aggregate_id = ?",
    ).bind(first.id).first<{ count: number }>();
    expect(jobs?.count).toBe(1);
    expect(events?.count).toBe(1);
    await expect(repository.createTranscodeJob(
      actorId,
      { ...request, inputKey: "media/source/different.mp4" },
      "transcode-test-1",
      crypto.randomUUID(),
    )).rejects.toMatchObject({ code: "conflict", status: 409 });
  });
});
