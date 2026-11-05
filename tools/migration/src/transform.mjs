import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  TABLES, assertDirectory, assertManifestTable, ensureDirectory, normalizeRows,
  parseArgs, readManifest, rejectUnknownOptions, requireOption, validateForeignKeys,
  writeManifest, writeNdjson,
} from "./common.mjs";

const args = parseArgs(process.argv.slice(2));
rejectUnknownOptions(args, ["input", "output"]);
const input = await assertDirectory(requireOption(args, "input"));
const output = await ensureDirectory(requireOption(args, "output"));
const sourceManifest = await readManifest(input);
if (sourceManifest.format !== "lumora-supabase-ndjson" || sourceManifest.version !== 1) {
  throw new Error("Unsupported source manifest.");
}

const dataset = new Map();
for (const table of TABLES) {
  const text = await readFile(path.join(input, `${table}.ndjson`), "utf8");
  assertManifestTable(sourceManifest, table, text);
  const sourceRows = text.trim() ? text.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line)) : [];
  dataset.set(table, normalizeRows(table, sourceRows));
}
validateForeignKeys(dataset);

const manifest = {
  format: "lumora-d1-ndjson",
  version: 1,
  createdAt: new Date().toISOString(),
  sourceManifestSha256: sourceManifest.tables,
  authCredentialsIncluded: false,
  uuidPolicy: "preserve",
  tables: {},
};
for (const table of TABLES) {
  manifest.tables[table] = await writeNdjson(path.join(output, `${table}.ndjson`), dataset.get(table));
}
await writeManifest(output, manifest);
console.log(JSON.stringify({ mode: "transformed", output, tables: TABLES.length, authCredentialsIncluded: false }));
