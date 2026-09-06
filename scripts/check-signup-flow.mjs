// End-to-end test of the SMTP-free sign-up flow — the exact sequence
// signUpAction performs: anon signUp (no session expected, no SMTP) →
// service-role email confirm → anon signIn → session works.
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';

const raw = readFileSync('.env', 'utf8');
for (const l of raw.split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BASE = 'http://localhost:3100';

const email = `signup-flow-${Date.now()}@gmail.com`;
const password = 'signup-test-pass-1';

// 1. Anon signUp (what the browser form does first).
const anon = createClient(url, anonKey, { auth: { persistSession: false } });
const { data: signup, error: se } = await anon.auth.signUp({ email, password });
if (se) { console.error('FAIL signUp:', se.message); process.exit(1); }
console.log(`1. anon signUp ok — session: ${signup.session ? 'present' : 'none (email confirmation pending — expected without SMTP)'}`);

// 2. Service-role confirm (what confirmEmailAndSignIn does).
const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
const user = (list?.users ?? []).find((u) => u.email === email);
if (!user) { console.error('FAIL: user not found after signUp'); process.exit(1); }
const { error: ce } = await admin.auth.admin.updateUserById(user.id, { email_confirm: true });
if (ce) { console.error('FAIL confirm:', ce.message); process.exit(1); }
console.log('2. service-role email confirm ok');

// 3. Sign in via the SSR pattern (what the action does) and hit /account.
const jar = new Map();
const ssr = createServerClient(url, anonKey, {
  cookies: {
    getAll() { return [...jar.entries()].map(([name, value]) => ({ name, value })); },
    setAll(toSet) { for (const { name, value } of toSet) jar.set(name, value); },
  },
});
const { error: ie } = await ssr.auth.signInWithPassword({ email, password });
if (ie) { console.error('FAIL signIn:', ie.message); process.exit(1); }
const cookieHeader = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
const res = await fetch(`${BASE}/account`, { headers: { cookie: cookieHeader } });
const body = await res.text();
console.log(`3. signIn + /account (${res.status}) -> ${body.includes('Signed in as') ? 'session works ✓' : 'session broken ✗'}`);

// 4. handle_new_user trigger created the account row?
const { data: account } = await admin.from('accounts').select('id').eq('id', user.id).maybeSingle();
console.log(`4. accounts row created by trigger: ${account ? 'yes ✓' : 'NO ✗'}`);

// 5. Cleanup: remove the throwaway user (cascades to accounts/profiles).
await admin.auth.admin.deleteUser(user.id);
console.log('5. throwaway user deleted');
