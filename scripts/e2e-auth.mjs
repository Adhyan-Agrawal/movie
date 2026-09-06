// End-to-end auth test: performs the same signInWithPassword the server action
// does (via @supabase/ssr), captures the session cookies, then requests
// /account and /admin with them to verify the session gate + admin RBAC work.
// Credentials come from env; nothing is printed.
import { readFileSync } from 'node:fs';
import { createServerClient } from '@supabase/ssr';

const raw = readFileSync('.env', 'utf8');
for (const l of raw.split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const email = process.env.ADMIN_EMAIL;
const password = process.env.ADMIN_PASSWORD;
if (!url || !anonKey || !email || !password) { console.error('missing env'); process.exit(2); }

const BASE = 'http://localhost:3100';
const jar = new Map();

const supabase = createServerClient(url, anonKey, {
  cookies: {
    getAll() { return [...jar.entries()].map(([name, value]) => ({ name, value })); },
    setAll(toSet) { for (const { name, value } of toSet) jar.set(name, value); },
  },
});

const { error } = await supabase.auth.signInWithPassword({ email, password });
if (error) { console.error('sign-in failed:', error.message); process.exit(1); }
console.log('1. signInWithPassword ok — cookies set:', [...jar.keys()].join(', '));

const cookieHeader = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');

async function check(path, mustHave, mustNotHave) {
  const res = await fetch(`${BASE}${path}`, { headers: { cookie: cookieHeader }, redirect: 'manual' });
  const html = await res.text();
  const has = (s) => html.toLowerCase().includes(s.toLowerCase());
  const pass = mustHave.every(has) && !(mustNotHave || []).some(has);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${path} (${res.status})`);
  for (const m of mustHave) if (!has(m)) console.log(`        missing: "${m}"`);
  for (const m of mustNotHave || []) if (has(m)) console.log(`        unexpected: "${m}"`);
  if (!pass) process.exitCode = 1;
}

// Signed-in: account shows the email; admin console renders (admin role), not the unauthorized state.
await check('/account', ['Signed in as', email], ['Sign in to continue']);
await check('/admin', ['Admin', 'Titles', 'Users'], ['Admin access required']);
await check('/api/health', ['status'], []);

// Anonymous: account + admin show their unauthorized states.
console.log('\nAnonymous checks:');
const a1 = await fetch(`${BASE}/account`);
const h1 = await a1.text();
console.log(`${a1.status} /account -> ${h1.includes('Sign in to continue') ? 'unauthorized state ✓' : 'NOT GATED ✗'}`);
const a2 = await fetch(`${BASE}/admin`);
const h2 = await a2.text();
console.log(`${a2.status} /admin -> ${h2.includes('Admin access required') ? 'unauthorized state ✓' : 'NOT GATED ✗'}`);

await supabase.auth.signOut();
console.log('\nDone.');
