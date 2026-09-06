// Inspect (and optionally fix) the Supabase auth config: email confirmation
// requirement blocks sign-ups when SMTP isn't configured — the confirmation
// email never arrives, and the account can never sign in.
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const raw = readFileSync('.env', 'utf8');
for (const l of raw.split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const fix = process.argv.includes('--fix');

const res = await fetch(`${url}/auth/v1/admin/config`, {
  headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
});
if (!res.ok) { console.error('config fetch failed:', res.status, await res.text()); process.exit(1); }
const cfg = await res.json();
console.log('mailer_autoconfirm (email confirmation required):', cfg.mailer_autoconfirm);
console.log('email_signup_enabled:', cfg.email_signup_enabled);
console.log('smtp configured:', Boolean(cfg.smtp_host));

if (fix) {
  const upd = await fetch(`${url}/auth/v1/admin/config`, {
    method: 'PATCH',
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ mailer_autoconfirm: true }),
  });
  console.log('\nPATCH mailer_autoconfirm=true ->', upd.status, upd.ok ? '(ok)' : await upd.text());
}
