// Verify 0004 hardening landed: policies, audit insert gone, FK on-delete,
// publish trigger, account_id indexes.
import { readFileSync } from 'node:fs';
import pg from 'pg';

const raw = readFileSync('.env', 'utf8');
for (const l of raw.split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
const ref = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname.split('.')[0];
const conn = `postgresql://postgres:${encodeURIComponent(process.env.SUPABASE_DB_PASSWORD)}@db.${ref}.supabase.co:5432/postgres`;

const c = new pg.Client({ connectionString: conn, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
await c.connect();
try {
  const pol = await c.query(`select tablename, policyname, cmd from pg_policies where schemaname='public' and tablename in ('titles','reviews','accounts','audit_logs') order by tablename, policyname`);
  console.log('POLICIES (titles/reviews/accounts/audit_logs):');
  for (const r of pol.rows) console.log(`  ${r.tablename.padEnd(12)} ${r.policyname.padEnd(26)} ${r.cmd}`);

  const auditInsert = pol.rows.find((r) => r.tablename === 'audit_logs' && r.cmd === 'INSERT');
  console.log(`\naudit_logs INSERT policy present: ${auditInsert ? 'YES (BAD)' : 'no (correct — service-role only)'}`);

  const fks = await c.query(`
    select cls.relname as tbl, con.conname, con.confdeltype
    from pg_constraint con
    join pg_class cls on cls.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = cls.relnamespace
    where nsp.nspname='public' and con.contype='f'
      and con.conname like any (array['%created_by_fkey','%updated_by_fkey'])
    order by cls.relname`);
  console.log('\nCREATOR/UPDATER FKs (n = SET NULL, a = NO ACTION):');
  for (const r of fks.rows) console.log(`  ${r.tbl.padEnd(14)} ${r.conname.padEnd(30)} confdeltype=${r.confdeltype}${r.confdeltype === 'n' ? ' ✓' : ' ✗'}`);

  const trg = await c.query(`select tgname from pg_trigger where tgname='titles_enforce_publish'`);
  console.log(`\nPublish trigger present: ${trg.rows.length ? 'YES ✓' : 'NO ✗'}`);

  const fn = await c.query(`select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and proname='enforce_catalog_publish'`);
  console.log(`enforce_catalog_publish function: ${fn.rows.length ? 'YES ✓' : 'NO ✗'}`);

  const idx = await c.query(`select indexname from pg_indexes where schemaname='public' and indexname in ('watch_progress_account_idx','ratings_account_idx','reviews_account_idx','comments_account_idx','recent_searches_account_idx') order by indexname`);
  console.log(`\naccount_id indexes present: ${idx.rows.length}/5 — ${idx.rows.map((r) => r.indexname).join(', ')}`);
} finally { await c.end(); }
