import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  PRIMARY_KEYS, TABLES, ensureDirectory, normalizeRows, parseArgs, rejectUnknownOptions,
  requireOption, writeManifest, writeNdjson,
} from "./common.mjs";

const args = parseArgs(process.argv.slice(2));
rejectUnknownOptions(args, ["database", "output", "execute-local"]);
const database = requireOption(args, "database");
const outputOption = requireOption(args, "output");
if (!/(?:local|dev|test)/iu.test(database)) throw new Error("The local database name must contain local, dev, or test.");
if (args["execute-local"] !== true) {
  console.log(JSON.stringify({ mode: "dry-run", database, output: path.resolve(outputOption), remote: false, tables: TABLES.length }));
  process.exit(0);
}

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const workerRoot = path.resolve(scriptRoot, "../../../workers/api");
const wrangler = path.join(workerRoot, "node_modules", ".bin", process.platform === "win32" ? "wrangler.cmd" : "wrangler");
const output = await ensureDirectory(outputOption);
const manifest = {
  format: "lumora-d1-ndjson",
  version: 1,
  createdAt: new Date().toISOString(),
  source: "wrangler-local-d1",
  uuidPolicy: "preserve",
  tables: {},
};
for (const table of TABLES) {
  const primary = PRIMARY_KEYS[table] ?? ["id"];
  const order = primary.map((column) => `"${column}"`).join(", ");
  const stdout = await run(wrangler, [
    "d1", "execute", database, "--local", "--json", "--command",
    `SELECT * FROM "${table}" ORDER BY ${order}`,
  ], workerRoot);
  const result = JSON.parse(stdout);
  if (!Array.isArray(result) || result.length !== 1 || result[0]?.success !== true || !Array.isArray(result[0]?.results)) {
    throw new Error(`Unexpected Wrangler JSON response for ${table}.`);
  }
  const rows = normalizeRows(table, result[0].results);
  manifest.tables[table] = await writeNdjson(path.join(output, `${table}.ndjson`), rows);
}
await writeManifest(output, manifest);
console.log(JSON.stringify({ mode: "snapshot-local", database, output, remote: false, tables: TABLES.length }));

async function run(command, commandArgs, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { if (stderr.length < 16_384) stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(`Local Wrangler exited with code ${code}: ${stderr.slice(0, 2000)}`)));
  });
}
