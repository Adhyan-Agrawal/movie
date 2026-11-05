import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Repository } from "../src/repository";
import { seedAccount } from "./fixtures";

describe("serialized commerce RPC replacements", () => {
  it("publishes one immutable plan version and grants/revokes access", async () => {
    const actorId = crypto.randomUUID();
    const accountId = crypto.randomUUID();
    await seedAccount(env.DB, actorId, "commerce-owner@example.test", { role: "owner" });
    await seedAccount(env.DB, accountId, "commerce-viewer@example.test");
    const planCoordinator = env.PLAN_COORDINATOR.getByName("premium-commerce");
    const draft = await planCoordinator.createPlan(actorId, {
      slug: "premium-commerce",
      name: "Premium",
      description: "Premium access",
      currency: "USD",
      priceMinor: 999,
      billingInterval: "month",
      adFree: true,
      maxProfiles: 4,
      features: ["ad-free"],
      reason: "Create verified commerce plan",
    }, crypto.randomUUID());
    const published = await planCoordinator.publishPlan(
      actorId, "premium-commerce", draft.id, "Publish verified commerce plan", crypto.randomUUID(),
    );
    expect(published.status).toBe("published");

    const accountCoordinator = env.ACCOUNT_COORDINATOR.getByName(accountId);
    const grant = await accountCoordinator.grantSubscription(
      actorId,
      accountId,
      draft.id,
      new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      "Grant test premium access",
      crypto.randomUUID(),
    );
    const repository = new Repository(env.DB);
    expect(await repository.entitlements(accountId)).toMatchObject({
      resolved: true,
      status: "active",
      adFree: true,
      maxProfiles: 4,
      planId: draft.id,
    });
    await accountCoordinator.revokeSubscription(
      actorId, accountId, grant.id, "Revoke test premium access", crypto.randomUUID(),
    );
    expect(await repository.entitlements(accountId)).toMatchObject({
      resolved: true,
      status: "free",
      adFree: false,
      maxProfiles: 1,
    });
  });
});
