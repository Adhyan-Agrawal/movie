// REAL browser test of the sign-in and sign-up forms (the user's exact flow):
// loads /signin, fills the form, submits, and asserts the redirect + session.
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const raw = readFileSync('.env', 'utf8');
for (const l of raw.split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const BASE = 'http://localhost:3100';
const adminEmail = process.env.ADMIN_EMAIL;
const adminPassword = process.env.ADMIN_PASSWORD;

const browser = await chromium.launch();
let failed = false;

// --- 1. Sign in (admin account, wrong password first to see the error path) ---
{
  const page = await browser.newPage();
  await page.goto(`${BASE}/signin`, { waitUntil: 'networkidle' });
  await page.fill('#signin-email', adminEmail);
  await page.fill('#signin-password', 'wrong-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForTimeout(2000);
  const alertText = await page.locator('[role="alert"]').textContent().catch(() => null);
  console.log(`1. wrong password -> inline error: ${alertText ? `"${alertText.slice(0, 60)}" ✓` : 'NONE ✗'}`);
  if (!alertText) failed = true;

  // Correct password (React 19 resets the form after each action — refill both).
  await page.fill('#signin-email', adminEmail);
  await page.fill('#signin-password', adminPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/account**', { timeout: 15000 }).catch(() => {});
  const body = await page.textContent('body');
  const ok = page.url().includes('/account') && body.includes('Signed in as');
  console.log(`2. correct password -> ${ok ? `redirected to ${page.url()}, session active ✓` : `FAIL (url: ${page.url()}) ✗`}`);
  if (!ok) {
    failed = true;
    const alert = await page.locator('[role="alert"]').textContent().catch(() => null);
    console.log(`   form error shown: ${alert ? `"${alert}"` : '(none — no redirect, no error)'}`);
  }
  await page.close();
}

// --- 2. Sign-up (fresh throwaway account, SMTP-free) ---
{
  const email = `browser-signup-${Date.now()}@gmail.com`;
  const password = 'browser-test-pass-1';
  const page = await browser.newPage();
  await page.goto(`${BASE}/signup`, { waitUntil: 'networkidle' });
  await page.fill('#signup-email', email);
  await page.fill('#signup-password', password);
  await page.fill('#signup-confirm', password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL('**/account**', { timeout: 20000 }).catch(() => {});
  const body = await page.textContent('body');
  const ok = page.url().includes('/account') && body.includes('Signed in as');
  console.log(`3. sign-up -> ${ok ? `redirected to ${page.url()}, session active ✓` : `FAIL (url: ${page.url()}) ✗`}`);
  if (!ok) {
    failed = true;
    const alert = await page.locator('[role="alert"]').textContent().catch(() => null);
    if (alert) console.log(`   form error shown: "${alert}"`);
  } else {
    // 3b. Sign out.
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.waitForTimeout(3000);
    const afterUrl = page.url();
    await page.goto(`${BASE}/account`);
    const b2 = await page.textContent('body');
    const out = b2.includes('Sign in to continue');
    console.log(`4. sign out -> url after click: ${afterUrl} | /account now: ${out ? 'sign-in panel (session cleared) ✓' : 'still signed in ✗'}`);
    if (!out) failed = true;
  }

  // Cleanup: delete the throwaway user via service role.
  const { createClient } = await import('@supabase/supabase-js');
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const u = (list?.users ?? []).find((x) => x.email === email);
  if (u) await admin.auth.admin.deleteUser(u.id);
  console.log('5. throwaway user cleaned up');
  await page.close();
}

await browser.close();
console.log(failed ? '\nBROWSER TEST FAILED' : '\nALL BROWSER TESTS PASSED');
process.exit(failed ? 1 : 0);
