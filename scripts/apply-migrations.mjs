// Applies supabase/migrations/*.sql in order to the remote Postgres, then
// verifies core tables exist. Idempotent: migrations use IF NOT EXISTS / ON
// CONFLICT so re-running is safe.
//
// Usage (pick ONE credential source):
//   SUPABASE_DB_URL="postgresql://postgres:<pwd>@db.<ref>.supabase.co:5432/postgres" node scripts/apply-migrations.mjs
//   SUPABASE_DB_PASSWORD="<pwd>" node scripts/apply-migrations.mjs   (URL derived from NEXT_PUBLIC_SUPABASE_URL)
//
// Reads .env automatically. Never prints secrets.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

/** Minimal .env loader (no override of already-set process.env). */
function loadEnv() {
  try {
    const raw = readFileSync(join(root, '.env'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch {
    /* no .env; rely on real env */
  }
}

function deriveConnectionString() {
  if (process.env.SUPABASE_DB_URL) return process.env.SUPABASE_DB_URL;

  const pwd = process.env.SUPABASE_DB_PASSWORD;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!pwd || !url) return null;

  // https://<ref>.supabase.co  ->  db.<ref>.supabase.co
  const ref = new URL(url).hostname.split('.')[0];
  const enc = encodeURIComponent(pwd);
  return `postgresql://postgres:${enc}@db.${ref}.supabase.co:5432/postgres`;
}

async function main() {
  loadEnv();
  const conn = deriveConnectionString();
  if (!conn) {
    console.error(
      'No DB credential. Set SUPABASE_DB_URL, or SUPABASE_DB_PASSWORD (+ NEXT_PUBLIC_SUPABASE_URL) in .env.\n' +
        'Find the password in Supabase dashboard - Project Settings - Database.',
    );
    process.exit(2);
  }

  const migDir = join(root, 'supabase', 'migrations');
  const files = readdirSync(migDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const client = new pg.Client({
    connectionString: conn,
    ssl: { rejectUnauthorized: false },
    // Fail fast rather than hang if the port is filtered.
    connectionTimeoutMillis: 15000,
    statement_timeout: 120000,
  });

  console.log(`Connecting to Postgres and applying ${files.length} migration(s)...`);
  await client.connect();

  try {
    for (const f of files) {
      const sql = readFileSync(join(migDir, f), 'utf8');
      process.stdout.write(`  - ${f} ... `);
      // Each file is applied in its own transaction so a mid-file failure
      // rolls back that file cleanly and surfaces the real error.
      try {
        await client.query('begin');
        await client.query(sql);
        await client.query('commit');
        console.log('ok');
      } catch (err) {
        await client.query('rollback');
        console.log('FAILED');
        throw err;
      }
    }

    // Verify core tables landed.
    const { rows } = await client.query(
      `select table_name from information_schema.tables
       where table_schema = 'public'
       order by table_name`,
    );
    const names = rows.map((r) => r.table_name);
    const required = ['accounts', 'permissions', 'roles', 'titles', 'providers', 'media_sources', 'watch_progress'];
    const missing = required.filter((t) => !names.includes(t));

    console.log(`\nPublic tables now present (${names.length}): ${names.join(', ')}`);
    if (missing.length) {
      console.error(`\nWARNING: expected tables still missing: ${missing.join(', ')}`);
      process.exit(1);
    }

    // Confirm RBAC seed loaded.
    const perm = await client.query('select count(*)::int as n from public.permissions');
    const roles = await client.query('select count(*)::int as n from public.roles');
    console.log(`Seed check: ${perm.rows[0].n} permissions, ${roles.rows[0].n} roles.`);

    console.log('\nAll migrations applied and verified.');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('\nMigration run failed:', err.message);
  process.exit(1);
});
