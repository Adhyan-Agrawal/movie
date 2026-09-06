import { readFileSync } from 'node:fs';
import pg from 'pg';
const raw = readFileSync('.env', 'utf8');
for (const l of raw.split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
const ref = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname.split('.')[0];
const conn = `postgresql://postgres:${encodeURIComponent(process.env.SUPABASE_DB_PASSWORD)}@db.${ref}.supabase.co:5432/postgres`;
const sql = readFileSync('supabase/migrations/0003_playback_engagement.sql', 'utf8');
const c = new pg.Client({ connectionString: conn, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
await c.connect();
try { await c.query(sql); console.log('applied ok'); }
catch (e) {
  console.log('ERROR:', e.message);
  if (e.position) {
    const p = +e.position;
    console.log('position:', p, 'line ~', sql.slice(0, p).split(/\n/).length);
    console.log('--- context ---');
    console.log(sql.slice(Math.max(0, p - 240), p + 140));
  }
} finally { await c.end(); }
