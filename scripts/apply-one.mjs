// Apply a single migration file by name. Usage:
//   node scripts/apply-one.mjs 0003_playback_engagement.sql
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

const file = process.argv[2];
if (!file) { console.error('usage: node scripts/apply-one.mjs <file.sql>'); process.exit(2); }

const raw = readFileSync('.env', 'utf8');
for (const l of raw.split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
const ref = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname.split('.')[0];
const conn = `postgresql://postgres:${encodeURIComponent(process.env.SUPABASE_DB_PASSWORD)}@db.${ref}.supabase.co:5432/postgres`;

const sql = readFileSync(join('supabase', 'migrations', file), 'utf8');
const c = new pg.Client({ connectionString: conn, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000, statement_timeout: 120000 });
await c.connect();
try {
  await c.query('begin');
  await c.query(sql);
  await c.query('commit');
  console.log(`${file}: ok`);
} catch (e) {
  await c.query('rollback');
  console.log(`${file}: FAILED — ${e.message}`);
  if (e.position) { const p = +e.position; console.log('near line', sql.slice(0, p).split(/\n/).length + ':', sql.slice(Math.max(0, p - 80), p + 60).replace(/\n/g, ' ')); }
  process.exitCode = 1;
} finally { await c.end(); }
