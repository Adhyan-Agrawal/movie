// Verify a signed-in NON-admin (viewer role / no roles) gets 404 on /admin.
// Creates a throwaway user via the service role, signs in, checks /admin,
// then deletes the throwaway user.
import { readFileSync, writeFileSync } from 'node:fs';
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

const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
const email = `viewer-test-${Date.now()}@lumora.test`;
const password = 'test-viewer-pass-1';

try {
  const { data: created, error: ce } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (ce) throw ce;
  const uid = created.user.id;

  // Sign in as the viewer (no roles assigned).
  const jar = new Map();
  const viewer = createServerClient(url, anonKey, {
    cookies: {
      getAll() { return [...jar.entries()].map(([name, value]) => ({ name, value })); },
      setAll(toSet) { for (const { name, value } of toSet) jar.set(name, value); },
    },
  });
  const { error: sie } = await viewer.auth.signInWithPassword({ email, password });
  if (sie) throw sie;

  const cookieHeader = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');

  const acc = await fetch(`${BASE}/account`, { headers: { cookie: cookieHeader } });
  const accBody = await acc.text();
  console.log(`${acc.status} /account (viewer) -> ${accBody.includes('Signed in as') ? 'session works ✓' : 'session broken ✗'}`);
  writeFileSync('viewer-account-response.html', accBody);
  console.log('  body saved to viewer-account-response.html,', accBody.length, 'bytes');
  console.log('  is-notfound-page:', accBody.includes("We couldn’t find that"), '| 404-mark:', accBody.includes('>404<'));

  const adm = await fetch(`${BASE}/admin`, { headers: { cookie: cookieHeader } });
  console.log(`${adm.status} /admin (viewer) -> ${adm.status === 404 ? '404 (hidden) ✓' : `EXPOSED (${adm.status}) ✗`}`);

  await viewer.auth.signOut();
  await admin.auth.admin.deleteUser(uid);
  console.log('Throwaway viewer user deleted.');
} catch (e) {
  console.error('FAILED:', e.message);
  process.exit(1);
}
