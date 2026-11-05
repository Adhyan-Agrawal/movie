import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import {
  PRIMARY_KEYS, TABLES, ensureDirectory, parseArgs, rejectUnknownOptions,
  requireOption, sha256, writeManifest,
} from "./common.mjs";

const args = parseArgs(process.argv.slice(2));
rejectUnknownOptions(args, ["output", "execute", "database-url-env", "allow-network-source", "psql"]);
const outputOption = requireOption(args, "output");
const execute = args.execute === true;
const variableName = typeof args["database-url-env"] === "string" ? args["database-url-env"] : "SUPABASE_DATABASE_URL";

if (!execute) {
  console.log(JSON.stringify({
    mode: "dry-run",
    tables: TABLES.length,
    output: path.resolve(outputOption),
    secretRead: false,
    next: `Re-run with --execute --allow-network-source --database-url-env ${variableName} after approving the source.`,
  }));
  process.exit(0);
}
if (args["allow-network-source"] !== true) throw new Error("--allow-network-source is required for an executed PostgreSQL export.");
if (!/^[A-Z][A-Z0-9_]{2,100}$/u.test(variableName)) throw new Error("--database-url-env must name an uppercase environment variable.");
const connection = process.env[variableName];
if (!connection) throw new Error(`${variableName} is not set. The tool never falls back to another secret.`);
const output = await ensureDirectory(outputOption);
const psql = typeof args.psql === "string" ? args.psql : "psql";
const manifest = {
  format: "lumora-supabase-ndjson",
  version: 1,
  createdAt: new Date().toISOString(),
  source: "postgres-public-schema",
  tables: {},
};

for (const table of TABLES) {
  const primary = PRIMARY_KEYS[table] ?? ["id"];
  const order = primary.map((column) => `"${column}"`).join(", ");
  const query = `SELECT row_to_json(t)::text FROM (SELECT * FROM public."${table}" ORDER BY ${order}) AS t;`;
  const file = path.join(output, `${table}.ndjson`);
  await runPsql(psql, connection, query, file);
  const text = await readFile(file, "utf8");
  const rows = text.trim() ? text.split(/\r?\n/u).filter(Boolean).length : 0;
  manifest.tables[table] = { rows, sha256: sha256(text) };
  console.log(JSON.stringify({ table, rows }));
}
await writeManifest(output, manifest);
console.log(JSON.stringify({ mode: "exported", output, tables: TABLES.length }));

async function runPsql(executable, database, query, destination) {
  await new Promise((resolve, reject) => {
    const outputStream = createWriteStream(destination, { flags: "wx", encoding: "utf8" });
    const child = spawn(executable, ["--no-psqlrc", "--set", "ON_ERROR_STOP=1", "--tuples-only", "--no-align", "--command", query], {
      env: { ...process.env, PGDATABASE: database },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { if (stderr.length < 16_384) stderr += chunk; });
    child.stdout.pipe(outputStream);
    child.once("error", reject);
    child.once("close", async (code) => {
      if (code === 0) return resolve();
      outputStream.destroy();
      await unlink(destination).catch(() => undefined);
      reject(new Error(`psql failed with exit code ${code}: ${stderr.trim().slice(0, 2000)}`));
    });
  });
}
