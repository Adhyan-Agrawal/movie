// E2E: profile management (create, rename, delete) in a real browser.
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const raw = readFileSync('.env', 'utf8');
for (const l of raw.split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
const BASE = 'http://localhost:3100';

const browser = await chromium.launch();
const page = await browser.newPage();
let failed = false;

// 1. Sign in.
await page.goto(`${BASE}/signin`, { waitUntil: 'networkidle' });
await page.fill('#signin-email', process.env.ADMIN_EMAIL);
await page.fill('#signin-password', process.env.ADMIN_PASSWORD);
await page.getByRole('button', { name: 'Sign in' }).click();
await page.waitForURL('**/account**', { timeout: 15000 });
console.log('1. signed in ✓');

// 2. Create a profile.
await page.goto(`${BASE}/account/profiles`, { waitUntil: 'networkidle' });
await page.fill('#new-profile-name', 'Movie Night');
await page.getByRole('button', { name: 'Add profile' }).click();
await page.waitForTimeout(3000);
const body1 = await page.textContent('body');
const created = body1.includes('Movie Night');
console.log(`2. create profile -> ${created ? 'Movie Night appears ✓' : 'NOT CREATED ✗'}`);
if (!created) { failed = true; console.log('   body head:', body1.slice(0, 250)); }

// 3. Rename it.
const renameBtn = page.locator('li', { hasText: 'Movie Night' }).getByRole('button', { name: 'Rename' }).first();
await renameBtn.click();
const input = page.locator('li', { hasText: 'Movie Night' }).locator('input').first();
await input.fill('Late Night');
await page.locator('li', { hasText: 'Movie Night' }).getByRole('button', { name: 'Save' }).first().click();
await page.waitForTimeout(3000);
const body2 = await page.textContent('body');
const renamed = body2.includes('Late Night') && !body2.includes('Movie Night');
console.log(`3. rename -> ${renamed ? 'now "Late Night" ✓' : 'RENAME FAILED ✗'}`);
if (!renamed) failed = true;

// 4. Delete it (two-step confirm).
const tile = page.locator('li', { hasText: 'Late Night' });
await tile.getByRole('button', { name: 'Delete' }).first().click();
await tile.getByRole('button', { name: 'Confirm delete' }).first().click();
await page.waitForTimeout(3000);
const body3 = await page.textContent('body');
const deleted = !body3.includes('Late Night');
console.log(`4. delete -> ${deleted ? 'removed ✓' : 'STILL PRESENT ✗'}`);
if (!deleted) failed = true;

await browser.close();
console.log(failed ? '\nFAILED' : '\nALL PASSED');
process.exit(failed ? 1 : 0);
