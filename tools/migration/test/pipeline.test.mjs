import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import assert from "node:assert/strict";
import {
  TABLES, normalizeRows, validateForeignKeys, writeManifest, writeNdjson,
} from "../src/common.mjs";

const execute = promisify(execFile);
const toolsRoot = path.resolve(import.meta.dirname, "..");

test("inventory stays fixed at 45 public tables", () => {
  assert.equal(TABLES.length, 45);
  assert.equal(new Set(TABLES).size, 45);
});

test("account transform preserves UUID and normalizes Better Auth columns", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const [row] = normalizeRows("accounts", [{
    id,
    email: "person@example.test",
    display_name: "Person",
    is_suspended: false,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
  }]);
  assert.equal(row.id, id);
  assert.equal(row.is_suspended, 0);
  assert.equal(row.email_verified, 0);
  assert.equal(row.image_url, null);
  assert.equal(row.created_at, 1767225600000);
});

test("foreign-key reconciliation fails closed", () => {
  const dataset = new Map(TABLES.map((table) => [table, []]));
  dataset.set("profiles", [{
    id: "22222222-2222-4222-8222-222222222222",
    account_id: "11111111-1111-4111-8111-111111111111",
  }]);
  assert.throws(() => validateForeignKeys(dataset), /references missing accounts/iu);
});

test("export defaults to a secret-free dry-run", async () => {
  const output = path.join(await mkdtemp(path.join(os.tmpdir(), "lumora-export-test-")), "export");
  const result = await execute(process.execPath, ["./src/export.mjs", "--output", output], {
    cwd: toolsRoot,
    env: { ...process.env, SUPABASE_DATABASE_URL: "must-not-be-read-in-dry-run" },
  });
  const report = JSON.parse(result.stdout.trim());
  assert.equal(report.mode, "dry-run");
  assert.equal(report.secretRead, false);
  assert.equal(report.tables, 45);
});

test("local D1 snapshot also defaults to no access", async () => {
  const output = path.join(await mkdtemp(path.join(os.tmpdir(), "lumora-snapshot-test-")), "snapshot");
  const result = await execute(process.execPath, [
    "./src/snapshot-local.mjs", "--database", "lumora-api-local", "--output", output,
  ], { cwd: toolsRoot });
  const report = JSON.parse(result.stdout.trim());
  assert.equal(report.mode, "dry-run");
  assert.equal(report.remote, false);
  assert.equal(report.tables, 45);
});

test("offline transform and SQL import preserve checksums and IDs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lumora-pipeline-test-"));
  const source = path.join(root, "source");
  const transformed = path.join(root, "transformed");
  const sql = path.join(root, "sql");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(source);
  const manifest = { format: "lumora-supabase-ndjson", version: 1, tables: {} };
  const accountId = "11111111-1111-4111-8111-111111111111";
  for (const table of TABLES) {
    const rows = table === "accounts" ? [{
      id: accountId,
      email: "person@example.test",
      display_name: "Person",
      is_suspended: false,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    }] : [];
    manifest.tables[table] = await writeNdjson(path.join(source, `${table}.ndjson`), rows);
  }
  await writeManifest(source, manifest);

  await execute(process.execPath, ["./src/transform.mjs", "--input", source, "--output", transformed], { cwd: toolsRoot });
  const dryRun = await execute(process.execPath, ["./src/import.mjs", "--input", transformed], { cwd: toolsRoot });
  assert.equal(JSON.parse(dryRun.stdout.trim()).mode, "dry-run");
  await execute(process.execPath, [
    "./src/import.mjs", "--input", transformed, "--output", sql, "--write-sql",
  ], { cwd: toolsRoot });
  const accountSql = await readFile(path.join(sql, "0001_accounts_0001.sql"), "utf8");
  assert.match(accountSql, new RegExp(accountId, "u"));
  assert.match(accountSql, /email_verified/u);
});
