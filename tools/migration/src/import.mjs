import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  TABLES, assertDirectory, ensureDirectory, parseArgs, readManifest, readNdjson,
  rejectUnknownOptions, requireOption, sha256, writeManifest,
} from "./common.mjs";

const args = parseArgs(process.argv.slice(2));
rejectUnknownOptions(args, ["input", "output", "write-sql", "apply-local", "database", "confirm-empty-target"]);
const input = await assertDirectory(requireOption(args, "input"));
const sourceManifest = await readManifest(input);
if (sourceManifest.format !== "lumora-d1-ndjson" || sourceManifest.version !== 1) throw new Error("Unsupported transformed manifest.");
const writeSql = args["write-sql"] === true || args["apply-local"] === true;

if (!writeSql) {
  console.log(JSON.stringify({
    mode: "dry-run",
    tables: TABLES.length,
    rows: Object.values(sourceManifest.tables).reduce((sum, table) => sum + table.rows, 0),
    uuidPolicy: sourceManifest.uuidPolicy,
    remoteApplySupported: false,
    next: "Re-run with --write-sql --output <empty-directory> to create deterministic local import SQL.",
  }));
  process.exit(0);
}

const output = await ensureDirectory(requireOption(args, "output"));
const files = [];
const guardTables = TABLES.filter((table) => !["roles", "permissions", "role_permissions", "site_settings"].includes(table));
const occupancy = guardTables.map((table) => `(SELECT count(*) FROM "${table}")`).join(" + ");
const preamble = [
  "-- Generated for an empty, migrated D1 target. Never run against a live database.",
  "CREATE TABLE IF NOT EXISTS _lumora_import_guard (value INTEGER NOT NULL CHECK (value = 0));",
  "DELETE FROM _lumora_import_guard;",
  `INSERT INTO _lumora_import_guard(value) SELECT ${occupancy};`,
  "DELETE FROM _lumora_import_guard;",
  "DELETE FROM role_permissions;",
  "DELETE FROM account_members;",
  "DELETE FROM permissions;",
  "DELETE FROM roles;",
  "DROP TABLE _lumora_import_guard;",
  "",
].join("\n");
const preambleName = "0000_prepare_empty_target.sql";
await writeExclusive(path.join(output, preambleName), preamble);
files.push({ name: preambleName, sha256: sha256(preamble), statements: 9 });

let ordinal = 1;
for (const table of TABLES) {
  const rows = await readNdjson(path.join(input, `${table}.ndjson`));
  const chunks = chunk(rows, 100);
  if (chunks.length === 0) continue;
  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
    const statements = chunks[chunkIndex].map((row) => insertStatement(table, row));
    const text = `${statements.join("\n")}\n`;
    const name = `${String(ordinal).padStart(4, "0")}_${table}_${String(chunkIndex + 1).padStart(4, "0")}.sql`;
    await writeExclusive(path.join(output, name), text);
    files.push({ name, sha256: sha256(text), statements: statements.length });
    ordinal += 1;
  }
}
await writeManifest(output, {
  format: "lumora-d1-import-sql",
  version: 1,
  createdAt: new Date().toISOString(),
  sourceManifest: sourceManifest.tables,
  files,
});
console.log(JSON.stringify({ mode: "sql-written", output, files: files.length }));

if (args["apply-local"] === true) {
  if (args["confirm-empty-target"] !== true) throw new Error("--confirm-empty-target is required for local apply.");
  const database = requireOption(args, "database");
  if (!/(?:local|dev|test)/iu.test(database)) throw new Error("The local database name must contain local, dev, or test.");
  const toolsRoot = path.dirname(fileURLToPath(import.meta.url));
  const workerRoot = path.resolve(toolsRoot, "../../../workers/api");
  const wrangler = path.join(workerRoot, "node_modules", ".bin", process.platform === "win32" ? "wrangler.cmd" : "wrangler");
  for (const file of files) {
    await run(wrangler, ["d1", "execute", database, "--local", "--file", path.join(output, file.name)], workerRoot);
  }
  console.log(JSON.stringify({ mode: "applied-local", database, files: files.length, remote: false }));
}

function insertStatement(table, row) {
  const columns = Object.keys(row).sort();
  if (columns.length === 0) throw new Error(`${table} contains an empty row.`);
  for (const column of columns) {
    if (!/^[a-z][a-z0-9_]*$/u.test(column)) throw new Error(`${table} contains invalid column ${column}.`);
  }
  const verb = table === "site_settings" || table === "feature_flags" ? "INSERT OR REPLACE" : "INSERT OR ABORT";
  return `${verb} INTO "${table}" (${columns.map((column) => `"${column}"`).join(", ")}) VALUES (${columns.map((column) => sqlLiteral(row[column])).join(", ")});`;
}

function sqlLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Non-finite number cannot be imported.");
    return String(value);
  }
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value !== "string") throw new Error("Transform must serialize nested values before import.");
  return `'${value.replaceAll("'", "''")}'`;
}

function chunk(values, size) {
  const output = [];
  for (let index = 0; index < values.length; index += size) output.push(values.slice(index, index + size));
  return output;
}

async function writeExclusive(file, content) {
  await writeFile(file, content, { encoding: "utf8", flag: "wx" });
}

async function run(command, commandArgs, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { cwd, stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`Local Wrangler exited with code ${code}.`)));
  });
}
