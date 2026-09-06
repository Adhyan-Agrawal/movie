// Browser test of the admin TMDB sync panel: sign in as admin, open /admin/sync,
// run a 1-page charts sync, and verify the UI. On this network TMDB is blocked,
// so the expected result is the honest "Sync failed: ... unreachable" error state.
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const raw = readFileSync('.env', 'utf8');
for (const l of raw.split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const BASE = 'http://localhost:3100';

const browser = await chromium.launch();
const page = await browser.newPage();

// 1. Sign in as admin.
await page.goto(`${BASE}/signin`, { waitUntil: 'networkidle' });
await page.fill('#signin-email', process.env.ADMIN_EMAIL);
await page.fill('#signin-password', process.env.ADMIN_PASSWORD);
await page.getByRole('button', { name: 'Sign in' }).click();
await page.waitForURL('**/account**', { timeout: 15000 });
console.log('1. signed in as admin ✓');

// 2. Open the admin sync page (nav item should exist).
await page.goto(`${BASE}/admin/sync`, { waitUntil: 'networkidle' });
const heading = await page.locator('h1').first().textContent();
console.log(`2. /admin/sync renders: "${heading}" ${heading?.includes('TMDB') ? '✓' : '✗'}`);
const navHasSync = await page.locator('nav[aria-label="Admin"]').textContent();
console.log(`   sidebar has TMDB sync: ${navHasSync?.includes('TMDB sync') ? '✓' : '✗'}`);

// 3. Run a quick 1-page charts sync.
await page.selectOption('#sync-pages', '1');
await page.getByRole('button', { name: /Sync catalog now/ }).click();
// TMDB detail fetches are batched with 15s timeouts; on a blocked network each
// list fetch fails fast, but allow generous time.
await page.waitForTimeout(25000);
const status = await page.locator('[role="status"], [role="alert"]').first().textContent().catch(() => null);
console.log(`3. sync result panel: ${status ? `"${status.slice(0, 140)}..."` : 'NOT SHOWN ✗'}`);
const isError = await page.locator('[role="alert"]').count().then((n) => n > 0);
console.log(`   honest error state on blocked network: ${isError ? '✓' : '(no error — sync may have succeeded?!)'}`);

await browser.close();
