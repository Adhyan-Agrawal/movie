import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const TABLES = [
  "accounts", "roles", "permissions", "role_permissions", "account_members", "profiles",
  "genres", "titles", "title_genres", "seasons", "episodes", "people", "title_people",
  "collections", "collection_items", "tags", "title_tags", "providers", "media_sources",
  "subtitle_tracks", "audio_tracks", "playback_sessions", "watch_progress", "watchlists",
  "watchlist_items", "ratings", "reviews", "comments", "recent_searches", "notifications",
  "site_settings", "feature_flags", "audit_logs", "imports", "webhook_events", "health_checks",
  "ad_providers", "ad_placements", "ad_campaigns", "ad_creatives", "ad_events", "title_requests",
  "playback_reports", "commerce_plans", "commerce_subscriptions",
];

export const PRIMARY_KEYS = {
  role_permissions: ["role_id", "permission_id"],
  account_members: ["account_id", "role_id"],
  title_genres: ["title_id", "genre_id"],
  collection_items: ["collection_id", "title_id"],
  title_tags: ["title_id", "tag_id"],
  watchlist_items: ["watchlist_id", "title_id"],
  site_settings: ["key"],
  feature_flags: ["key"],
};

export const BOOLEAN_COLUMNS = {
  accounts: ["is_suspended", "email_verified"],
  profiles: ["is_kids"],
  titles: ["featured"],
  collections: ["is_public"],
  providers: ["enabled", "consent_required"],
  media_sources: ["is_default", "enabled", "consent_required"],
  subtitle_tracks: ["is_default"],
  audio_tracks: ["is_default"],
  watch_progress: ["completed"],
  watchlists: ["is_default"],
  site_settings: ["is_public"],
  feature_flags: ["enabled", "is_public"],
  imports: ["dry_run"],
  ad_providers: ["enabled"],
  ad_placements: ["enabled"],
  ad_campaigns: ["enabled", "consent_required", "kill_switch"],
  ad_creatives: ["enabled"],
  commerce_plans: ["ad_free"],
};

export const JSON_COLUMNS = {
  providers: ["allowed_domains", "enabled_regions", "config"],
  media_sources: ["geo_policy", "safe_headers"],
  notifications: ["data"],
  site_settings: ["value"],
  feature_flags: ["rollout"],
  audit_logs: ["before", "after"],
  imports: ["mapping", "error_report"],
  webhook_events: ["payload"],
  health_checks: ["detail"],
  ad_providers: ["config"],
  ad_placements: ["device_targeting"],
  ad_campaigns: ["revenue_meta"],
  ad_events: ["meta"],
  commerce_plans: ["features"],
};

export const FOREIGN_KEYS = [
  ["role_permissions", "role_id", "roles", "id"],
  ["role_permissions", "permission_id", "permissions", "id"],
  ["account_members", "account_id", "accounts", "id"],
  ["account_members", "role_id", "roles", "id"],
  ["profiles", "account_id", "accounts", "id"],
  ["title_genres", "title_id", "titles", "id"],
  ["title_genres", "genre_id", "genres", "id"],
  ["titles", "created_by", "accounts", "id"],
  ["seasons", "title_id", "titles", "id"],
  ["episodes", "title_id", "titles", "id"],
  ["episodes", "season_id", "seasons", "id"],
  ["title_people", "title_id", "titles", "id"],
  ["title_people", "person_id", "people", "id"],
  ["collections", "created_by", "accounts", "id"],
  ["collection_items", "collection_id", "collections", "id"],
  ["collection_items", "title_id", "titles", "id"],
  ["title_tags", "title_id", "titles", "id"],
  ["title_tags", "tag_id", "tags", "id"],
  ["media_sources", "title_id", "titles", "id"],
  ["media_sources", "episode_id", "episodes", "id"],
  ["media_sources", "provider_id", "providers", "id"],
  ["providers", "created_by", "accounts", "id"],
  ["media_sources", "created_by", "accounts", "id"],
  ["subtitle_tracks", "source_id", "media_sources", "id"],
  ["subtitle_tracks", "title_id", "titles", "id"],
  ["audio_tracks", "source_id", "media_sources", "id"],
  ["audio_tracks", "title_id", "titles", "id"],
  ["playback_sessions", "account_id", "accounts", "id"],
  ["playback_sessions", "profile_id", "profiles", "id"],
  ["playback_sessions", "title_id", "titles", "id"],
  ["playback_sessions", "episode_id", "episodes", "id"],
  ["playback_sessions", "source_id", "media_sources", "id"],
  ["playback_sessions", "provider_id", "providers", "id"],
  ["watch_progress", "profile_id", "profiles", "id"],
  ["watch_progress", "account_id", "accounts", "id"],
  ["watch_progress", "title_id", "titles", "id"],
  ["watch_progress", "episode_id", "episodes", "id"],
  ["watchlists", "profile_id", "profiles", "id"],
  ["watchlists", "account_id", "accounts", "id"],
  ["watchlist_items", "watchlist_id", "watchlists", "id"],
  ["watchlist_items", "title_id", "titles", "id"],
  ["ratings", "profile_id", "profiles", "id"],
  ["ratings", "account_id", "accounts", "id"],
  ["ratings", "title_id", "titles", "id"],
  ["reviews", "profile_id", "profiles", "id"],
  ["reviews", "account_id", "accounts", "id"],
  ["reviews", "title_id", "titles", "id"],
  ["comments", "profile_id", "profiles", "id"],
  ["comments", "account_id", "accounts", "id"],
  ["comments", "title_id", "titles", "id"],
  ["comments", "parent_id", "comments", "id"],
  ["recent_searches", "profile_id", "profiles", "id"],
  ["recent_searches", "account_id", "accounts", "id"],
  ["notifications", "account_id", "accounts", "id"],
  ["notifications", "profile_id", "profiles", "id"],
  ["site_settings", "updated_by", "accounts", "id"],
  ["feature_flags", "updated_by", "accounts", "id"],
  ["audit_logs", "actor_account_id", "accounts", "id"],
  ["imports", "created_by", "accounts", "id"],
  ["ad_providers", "created_by", "accounts", "id"],
  ["ad_campaigns", "provider_id", "ad_providers", "id"],
  ["ad_campaigns", "created_by", "accounts", "id"],
  ["ad_creatives", "campaign_id", "ad_campaigns", "id"],
  ["ad_creatives", "placement_id", "ad_placements", "id"],
  ["ad_events", "creative_id", "ad_creatives", "id"],
  ["ad_events", "placement_id", "ad_placements", "id"],
  ["ad_events", "campaign_id", "ad_campaigns", "id"],
  ["ad_events", "account_id", "accounts", "id"],
  ["ad_events", "profile_id", "profiles", "id"],
  ["title_requests", "account_id", "accounts", "id"],
  ["playback_reports", "account_id", "accounts", "id"],
  ["playback_reports", "title_id", "titles", "id"],
  ["playback_reports", "episode_id", "episodes", "id"],
  ["commerce_subscriptions", "account_id", "accounts", "id"],
  ["commerce_subscriptions", "plan_id", "commerce_plans", "id"],
  ["commerce_subscriptions", "granted_by", "accounts", "id"],
  ["commerce_subscriptions", "revoked_by", "accounts", "id"],
];

const UUID_EXCEPTIONS = new Set([
  "titles.tmdb_id", "titles.imdb_id", "episodes.tmdb_id", "people.tmdb_id",
  "providers.test_title_id", "audit_logs.entity_id", "audit_logs.request_id",
  "webhook_events.event_id",
]);

export function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    if (!key || Object.hasOwn(args, key)) throw new Error(`Invalid or duplicate option: ${token}`);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      index += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

export function requireOption(args, name) {
  const value = args[name];
  if (typeof value !== "string" || !value.trim()) throw new Error(`--${name} is required.`);
  return value;
}

export function rejectUnknownOptions(args, allowed) {
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) throw new Error(`Unknown option: --${key}`);
  }
}

export async function ensureDirectory(directory) {
  await mkdir(path.resolve(directory), { recursive: true });
  return path.resolve(directory);
}

export async function assertDirectory(directory) {
  const resolved = path.resolve(directory);
  if (!(await stat(resolved)).isDirectory()) throw new Error(`Not a directory: ${resolved}`);
  return resolved;
}

export function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
  }
  return value;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function primaryKey(table, row) {
  const columns = PRIMARY_KEYS[table] ?? ["id"];
  const values = columns.map((column) => row[column]);
  if (values.some((value) => value === null || value === undefined)) {
    throw new Error(`${table} row is missing primary key ${columns.join(",")}.`);
  }
  return canonicalJson(values);
}

export function normalizeRows(table, rows) {
  const booleans = new Set(BOOLEAN_COLUMNS[table] ?? []);
  const jsonColumns = new Set(JSON_COLUMNS[table] ?? []);
  const normalized = rows.map((source) => {
    if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error(`${table} contains a non-object row.`);
    const row = { ...source };
    for (const column of booleans) {
      if (row[column] !== null && row[column] !== undefined) row[column] = row[column] === true || row[column] === 1 ? 1 : 0;
    }
    for (const column of jsonColumns) {
      if (row[column] === null || row[column] === undefined) continue;
      const parsed = typeof row[column] === "string" ? JSON.parse(row[column]) : row[column];
      row[column] = canonicalJson(parsed);
    }
    if (table === "accounts") {
      row.email_verified ??= 0;
      row.image_url ??= null;
      for (const column of ["created_at", "updated_at"]) {
        if (typeof row[column] === "string") {
          const milliseconds = Date.parse(row[column]);
          if (!Number.isFinite(milliseconds)) throw new Error(`accounts.${column} is not an ISO timestamp.`);
          row[column] = milliseconds;
        }
      }
    }
    validateUuidColumns(table, row);
    return row;
  });
  normalized.sort((left, right) => primaryKey(table, left).localeCompare(primaryKey(table, right)));
  const keys = new Set();
  for (const row of normalized) {
    const key = primaryKey(table, row);
    if (keys.has(key)) throw new Error(`${table} contains duplicate primary key ${key}.`);
    keys.add(key);
  }
  return normalized;
}

function validateUuidColumns(table, row) {
  for (const [column, value] of Object.entries(row)) {
    if (value === null || value === undefined) continue;
    if (column !== "id" && !column.endsWith("_id")) continue;
    if (UUID_EXCEPTIONS.has(`${table}.${column}`)) continue;
    if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
      throw new Error(`${table}.${column} is not a UUID.`);
    }
  }
}

export function validateForeignKeys(dataset) {
  const lookup = new Map();
  for (const table of TABLES) {
    lookup.set(table, new Set((dataset.get(table) ?? []).map((row) => row.id).filter(Boolean)));
  }
  for (const [fromTable, fromColumn, toTable, toColumn] of FOREIGN_KEYS) {
    if (toColumn !== "id") throw new Error("Only id foreign keys are supported by this validator.");
    const targets = lookup.get(toTable) ?? new Set();
    for (const row of dataset.get(fromTable) ?? []) {
      const value = row[fromColumn];
      if (value !== null && value !== undefined && !targets.has(value)) {
        throw new Error(`${fromTable}.${fromColumn} references missing ${toTable}.${toColumn} ${value}.`);
      }
    }
  }
}

export async function readNdjson(file) {
  const text = await readFile(file, "utf8");
  if (!text.trim()) return [];
  return text.split(/\r?\n/u).filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(`${file}:${index + 1} contains invalid JSON.`);
    }
  });
}

export async function writeNdjson(file, rows) {
  const text = rows.map(canonicalJson).join("\n") + (rows.length ? "\n" : "");
  await writeFile(file, text, { encoding: "utf8", flag: "wx" });
  return { rows: rows.length, sha256: sha256(text) };
}

export async function readManifest(directory) {
  const content = await readFile(path.join(directory, "manifest.json"), "utf8");
  return JSON.parse(content);
}

export async function writeManifest(directory, manifest) {
  await writeFile(path.join(directory, "manifest.json"), `${canonicalJson(manifest)}\n`, { encoding: "utf8", flag: "wx" });
}

export function assertManifestTable(manifest, table, text) {
  const expected = manifest.tables?.[table];
  if (!expected || expected.sha256 !== sha256(text)) throw new Error(`${table} checksum does not match its manifest.`);
}

export function rowsChecksum(rows) {
  const text = rows.map(canonicalJson).join("\n") + (rows.length ? "\n" : "");
  return { text, sha256: sha256(text) };
}
