import path from "node:path";
import {
  TABLES, assertDirectory, canonicalJson, parseArgs, primaryKey, readManifest,
  readNdjson, rejectUnknownOptions, requireOption, rowsChecksum,
} from "./common.mjs";

const args = parseArgs(process.argv.slice(2));
rejectUnknownOptions(args, ["source", "target"]);
const source = await assertDirectory(requireOption(args, "source"));
const target = await assertDirectory(requireOption(args, "target"));
const sourceManifest = await readManifest(source);
const targetManifest = await readManifest(target);
if (sourceManifest.format !== "lumora-d1-ndjson" || targetManifest.format !== "lumora-d1-ndjson") {
  throw new Error("Reconcile accepts only offline lumora-d1-ndjson snapshots.");
}

const report = { ok: true, tables: {}, mismatchCount: 0 };
for (const table of TABLES) {
  const sourceRows = await readNdjson(path.join(source, `${table}.ndjson`));
  const targetRows = await readNdjson(path.join(target, `${table}.ndjson`));
  const sourceByKey = new Map(sourceRows.map((row) => [primaryKey(table, row), canonicalJson(row)]));
  const targetByKey = new Map(targetRows.map((row) => [primaryKey(table, row), canonicalJson(row)]));
  const missing = [];
  const changed = [];
  const extra = [];
  for (const [key, value] of sourceByKey) {
    if (!targetByKey.has(key)) missing.push(key);
    else if (targetByKey.get(key) !== value) changed.push(key);
  }
  for (const key of targetByKey.keys()) if (!sourceByKey.has(key)) extra.push(key);
  const mismatchCount = missing.length + changed.length + extra.length;
  report.ok &&= mismatchCount === 0;
  report.mismatchCount += mismatchCount;
  report.tables[table] = {
    sourceRows: sourceRows.length,
    targetRows: targetRows.length,
    sourceSha256: rowsChecksum(sourceRows).sha256,
    targetSha256: rowsChecksum(targetRows).sha256,
    missingKeys: missing.slice(0, 100),
    changedKeys: changed.slice(0, 100),
    extraKeys: extra.slice(0, 100),
    truncated: mismatchCount > 300,
  };
}
console.log(JSON.stringify(report));
if (!report.ok) process.exitCode = 2;
