// Create (or update) an admin auth user and grant a role (Spec Section 8).
//
// Uses the service-role admin API: creates the auth user with email_confirmed
// (SMTP isn't configured on this project, so we confirm server-side), then
// grants the requested role (default 'admin') via account_members. The
// handle_new_user() trigger creates the accounts/profiles rows automatically on
// user creation. Idempotent: re-running updates the password and re-grants.
//
// The password is read from the ADMIN_PASSWORD env var (or .env) and is never
// printed.
//
// Usage:
//   ADMIN_EMAIL=… ADMIN_PASSWORD=… node scripts/create-admin.mjs [role]
//   node scripts/create-admin.mjs            # reads ADMIN_EMAIL/PASSWORD from .env

import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const raw = readFileSync('.env', 'utf8');
for (const l of raw.split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const email = process.env.ADMIN_EMAIL;
const password = process.env.ADMIN_PASSWORD;
const roleKey = process.argv.find((a) => !a.endsWith('.mjs') && /^[a-z]+$/.test(a)) || 'admin';

if (!url || !serviceKey || !email || !password) {
  console.error('Need NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ADMIN_EMAIL, ADMIN_PASSWORD.');
  process.exit(2);
}

const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

async function main() {
  // 1. Does the user already exist? (listUsersByEmail equivalent)
  const { data: existing } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const found = (existing?.users ?? []).find((u) => u.email === email);

  let userId;
  if (found) {
    // Update password + confirm email (idempotent re-run path).
    const { data, error } = await db.auth.admin.updateUserById(found.id, { password, email_confirm: true });
    if (error) throw new Error(`updateUser: ${error.message}`);
    userId = data.user.id;
    console.log(`Updated existing user ${email} (password reset, email confirmed).`);
  } else {
    const { data, error } = await db.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (error) throw new Error(`createUser: ${error.message}`);
    userId = data.user.id;
    console.log(`Created user ${email}.`);
  }

  // 2. The handle_new_user() trigger creates the accounts/profiles rows; verify.
  const { data: account, error: accErr } = await db.from('accounts').select('id').eq('id', userId).maybeSingle();
  if (accErr) throw new Error(`accounts lookup: ${accErr.message}`);
  if (!account) {
    // Trigger missed (e.g. created before migration) — create the rows directly.
    const { error: insErr } = await db.from('accounts').upsert(
      { id: userId, display_name: 'Admin' },
      { onConflict: 'id' },
    );
    if (insErr) throw new Error(`accounts upsert: ${insErr.message}`);
    console.log('Created missing accounts row.');
  }

  // 3. Grant the role.
  const { data: role, error: roleErr } = await db.from('roles').select('id, key, name').eq('key', roleKey).maybeSingle();
  if (roleErr || !role) throw new Error(`role '${roleKey}' not found — seeded by 0002_seed_rbac.sql`);

  const { error: grantErr } = await db.from('account_members').upsert(
    { account_id: userId, role_id: role.id },
    { onConflict: 'account_id,role_id' },
  );
  if (grantErr) throw new Error(`grant: ${grantErr.message}`);
  console.log(`Granted role '${role.key}' (${role.name}).`);

  // 4. Verify sign-in actually works with these credentials (never print them).
  const anon = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const { error: signInErr } = await anon.auth.signInWithPassword({ email, password });
  if (signInErr) throw new Error(`sign-in verification FAILED: ${signInErr.message}`);
  console.log('Sign-in verified with the new credentials. ✓');

  console.log(`\nAdmin ready: ${email} (role: ${role.key})`);
}

main().catch((e) => { console.error('\nFailed:', e.message); process.exit(1); });
