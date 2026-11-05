import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ApiHttpError } from "../src/http";
import { Repository } from "../src/repository";
import { seedAccount } from "./fixtures";

describe("authorization matrix", () => {
  it("preserves viewer and owner permission boundaries", async () => {
    const viewerId = crypto.randomUUID();
    const ownerId = crypto.randomUUID();
    await seedAccount(env.DB, viewerId, "viewer@example.test", { role: "viewer" });
    await seedAccount(env.DB, ownerId, "owner@example.test", { role: "owner" });
    const repository = new Repository(env.DB);

    const viewer = await repository.principal(viewerId);
    const owner = await repository.principal(ownerId);
    expect(viewer.roleKeys.has("viewer")).toBe(true);
    expect(viewer.permissions.size).toBe(0);
    expect(owner.permissions.has("roles.manage")).toBe(true);
    expect(owner.permissions.has("plans.manage")).toBe(true);
    expect(owner.permissions.size).toBe(16);
  });

  it("derives profile ownership from the authenticated account", async () => {
    const first = crypto.randomUUID();
    const second = crypto.randomUUID();
    const profile = crypto.randomUUID();
    await seedAccount(env.DB, first, "first@example.test");
    await seedAccount(env.DB, second, "second@example.test");
    await env.DB.prepare("INSERT INTO profiles(id, account_id, name) VALUES (?, ?, 'First')")
      .bind(profile, first).run();

    const repository = new Repository(env.DB);
    await expect(repository.updateProfile(second, profile, { name: "Stolen" }))
      .rejects.toMatchObject({ status: 404, code: "not_found" } satisfies Partial<ApiHttpError>);
    const stored = await env.DB.prepare("SELECT name FROM profiles WHERE id = ?").bind(profile)
      .first<{ name: string }>();
    expect(stored?.name).toBe("First");
  });

  it("rejects suspended accounts even with an otherwise valid role", async () => {
    const accountId = crypto.randomUUID();
    await seedAccount(env.DB, accountId, "suspended@example.test", { suspended: true, role: "owner" });
    const repository = new Repository(env.DB);
    await expect(repository.principal(accountId))
      .rejects.toMatchObject({ status: 403, code: "session_suspended" } satisfies Partial<ApiHttpError>);
  });

  it("keeps VAST configuration private and redacts its audited URL", async () => {
    const accountId = crypto.randomUUID();
    await seedAccount(env.DB, accountId, "ads-owner@example.test", { role: "owner" });
    const repository = new Repository(env.DB);
    const result = await repository.saveVastSettings(accountId, {
      enabled: true,
      tagUrl: "https://ads.example.test/vast?campaign=sensitive",
      allowedHosts: ["ads.example.test"],
      firstBreakSeconds: 900,
      intervalSeconds: 900,
      maxBreaks: 3,
      allowSkip: true,
      skipAfterSeconds: 5,
      reason: "Enable approved VAST provider",
    }, crypto.randomUUID());
    expect(result).toMatchObject({ enabled: true, tagOrigin: "https://ads.example.test" });
    const setting = await env.DB.prepare(
      "SELECT value, is_public FROM site_settings WHERE key = 'playback_vast'",
    ).first<{ value: string; is_public: number }>();
    expect(setting?.value).toContain("campaign=sensitive");
    expect(setting?.is_public).toBe(0);
    const audit = await env.DB.prepare(
      "SELECT \"after\" FROM audit_logs WHERE action = 'ads.vast.update' ORDER BY created_at DESC LIMIT 1",
    ).first<{ after: string }>();
    expect(audit?.after).not.toContain("sensitive");
    expect(audit?.after).not.toContain("/vast");
  });
});
