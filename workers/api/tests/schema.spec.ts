import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const DOMAIN_TABLES = [
  "accounts", "roles", "permissions", "role_permissions", "account_members", "profiles",
  "genres", "titles", "title_genres", "seasons", "episodes", "people", "title_people",
  "collections", "collection_items", "tags", "title_tags", "providers", "media_sources",
  "subtitle_tracks", "audio_tracks", "playback_sessions", "watch_progress", "watchlists",
  "watchlist_items", "ratings", "reviews", "comments", "recent_searches", "notifications",
  "site_settings", "feature_flags", "audit_logs", "imports", "webhook_events", "health_checks",
  "ad_providers", "ad_placements", "ad_campaigns", "ad_creatives", "ad_events", "title_requests",
  "playback_reports", "commerce_plans", "commerce_subscriptions",
] as const;

describe("D1 schema", () => {
  it("contains all 45 translated public tables and generated auth plugin tables", async () => {
    const rows = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all<{ name: string }>();
    const names = new Set(rows.results.map((row) => row.name));
    expect(DOMAIN_TABLES).toHaveLength(45);
    for (const table of DOMAIN_TABLES) expect(names.has(table), table).toBe(true);
    for (const authTable of ["auth_accounts", "auth_sessions", "auth_verifications", "auth_rate_limits", "passkey"]) {
      expect(names.has(authTable), authTable).toBe(true);
    }
  });

  it("has valid foreign keys, deterministic RBAC seeds, and FTS indexes", async () => {
    const foreignKeys = await env.DB.prepare("PRAGMA foreign_key_check").all();
    expect(foreignKeys.results).toEqual([]);
    const permissions = await env.DB.prepare("SELECT count(*) AS count FROM permissions").first<{ count: number }>();
    const roles = await env.DB.prepare("SELECT count(*) AS count FROM roles").first<{ count: number }>();
    expect(permissions?.count).toBe(16);
    expect(roles?.count).toBe(4);
    const fts = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('titles_fts', 'people_fts') ORDER BY name",
    ).all<{ name: string }>();
    expect(fts.results.map((row) => row.name)).toEqual(["people_fts", "titles_fts"]);
  });

  it("keeps audit rows append-only", async () => {
    const id = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO audit_logs(id, action) VALUES (?, 'schema.test')").bind(id).run();
    await expect(env.DB.prepare("UPDATE audit_logs SET action = 'changed' WHERE id = ?").bind(id).run())
      .rejects.toThrow(/append-only/iu);
    await expect(env.DB.prepare("DELETE FROM audit_logs WHERE id = ?").bind(id).run())
      .rejects.toThrow(/append-only/iu);
  });

  it("contains no destructive domain migration statement", () => {
    const migrations = env.TEST_MIGRATIONS.find((migration) => migration.name === "0001_domain.sql");
    expect(migrations).toBeDefined();
    expect(migrations?.queries.join("\n")).not.toMatch(/\bDROP\s+TABLE\b/iu);
  });
});
