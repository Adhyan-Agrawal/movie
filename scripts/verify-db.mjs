// Verify the live schema: tables, RLS status, policy counts, functions, seed rows.
import { readFileSync } from 'node:fs';
import pg from 'pg';

const raw = readFileSync('.env', 'utf8');
for (const l of raw.split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
const ref = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname.split('.')[0];
const conn = `postgresql://postgres:${encodeURIComponent(process.env.SUPABASE_DB_PASSWORD)}@db.${ref}.supabase.co:5432/postgres`;

const c = new pg.Client({ connectionString: conn, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
await c.connect();
try {
  const tables = await c.query(`
    select t.tablename,
           t.rowsecurity as rls,
           coalesce(p.n, 0) as policies
    from pg_tables t
    left join (select tablename, count(*) n from pg_policies where schemaname='public' group by tablename) p
      on p.tablename = t.tablename
    where t.schemaname='public'
    order by t.tablename`);

  console.log('TABLE                        RLS   POLICIES');
  let rlsOff = [];
  let noPolicy = [];
  for (const r of tables.rows) {
    console.log(`${r.tablename.padEnd(28)} ${String(r.rls).padEnd(5)} ${r.policies}`);
    if (!r.rls) rlsOff.push(r.tablename);
    if (r.rls && Number(r.policies) === 0) noPolicy.push(r.tablename);
  }
  console.log(`\nTotal tables: ${tables.rows.length}`);
  if (rlsOff.length) console.log('RLS DISABLED on:', rlsOff.join(', '));
  if (noPolicy.length) console.log('RLS ENABLED BUT NO POLICIES (locked out):', noPolicy.join(', '));
  if (!rlsOff.length && !noPolicy.length) console.log('RLS: every table has RLS on with >=1 policy.');

  const fns = await c.query(`select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and proname in ('has_permission','title_is_public','handle_new_user') order by proname`);
  console.log('\nFunctions present:', fns.rows.map((r) => r.proname).join(', ') || '(none)');

  const seed = await c.query(`select (select count(*) from public.permissions) as perms, (select count(*) from public.roles) as roles, (select count(*) from public.role_permissions) as grants`);
  console.log(`Seed: ${seed.rows[0].perms} permissions, ${seed.rows[0].roles} roles, ${seed.rows[0].grants} role_permission grants`);

  const enums = await c.query(`select t.typname, count(e.enumlabel) n from pg_type t join pg_enum e on e.enumtypid=t.oid join pg_namespace nsp on nsp.oid=t.typnamespace where nsp.nspname='public' group by t.typname order by t.typname`);
  console.log('Enums:', enums.rows.map((r) => `${r.typname}(${r.n})`).join(', '));
} finally { await c.end(); }
