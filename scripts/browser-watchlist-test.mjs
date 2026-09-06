// E2E: watchlist + watch history, as a signed-in viewer in a real browser.
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

// 2. Watchlist: add a title from its detail page.
await page.goto(`${BASE}/title/movie/the-dark-knight-155`, { waitUntil: 'networkidle' });
const wlButton = page.getByRole('button', { name: /watchlist/i }).first();
await wlButton.click();
await page.waitForTimeout(2500);
const pressed = await wlButton.getAttribute('aria-pressed');
const label = await wlButton.textContent();
console.log(`2. watchlist toggle -> aria-pressed=${pressed} label="${label?.trim()}" ${pressed === 'true' ? '✓' : '✗'}`);
if (pressed !== 'true') failed = true;

// 3. Watchlist page shows the title.
await page.goto(`${BASE}/account/watchlist`, { waitUntil: 'networkidle' });
const wlBody = await page.textContent('body');
const wlOk = wlBody.includes('The Dark Knight') && !wlBody.includes('Your watchlist is empty');
console.log(`3. /account/watchlist -> ${wlOk ? 'lists The Dark Knight ✓' : 'EMPTY/missing ✗'}`);
if (!wlOk) failed = true;

// 4. Watch a title (consent -> player mounts -> session recorded).
await page.goto(`${BASE}/watch/movie/the-dark-knight-155`, { waitUntil: 'networkidle' });
// Consent panel button ("Load player"/"Play" style) — find it generically.
const consentBtn = page.locator('button', { hasText: /play|load|continue/i }).first();
try {
  await consentBtn.click({ timeout: 5000 });
  console.log('4. consent accepted');
} catch { console.log('4. no consent panel (maybe already implied)'); }
await page.waitForTimeout(4000); // session start fires on iframe mount

// 5. History page shows the session.
await page.goto(`${BASE}/account/history`, { waitUntil: 'networkidle' });
const hBody = await page.textContent('body');
const hOk = hBody.includes('The Dark Knight');
console.log(`5. /account/history -> ${hOk ? 'shows The Dark Knight session ✓' : 'empty ✗'}`);
if (!hOk) {
  failed = true;
  console.log('   history body head:', hBody.slice(0, 300));
}

// 6. Remove from watchlist (toggle back).
await page.goto(`${BASE}/title/movie/the-dark-knight-155`, { waitUntil: 'networkidle' });
const btn2 = page.getByRole('button', { name: /watchlist/i }).first();
await btn2.click();
await page.waitForTimeout(2000);
const pressed2 = await btn2.getAttribute('aria-pressed');
console.log(`6. remove from watchlist -> aria-pressed=${pressed2} ${pressed2 === 'false' ? '✓' : '✗'}`);
if (pressed2 !== 'false') failed = true;

await browser.close();
console.log(failed ? '\nFAILED' : '\nALL PASSED');
process.exit(failed ? 1 : 0);
