// Verify continue-watching isolation — SCOPED to the actual Continue Watching
// section (titles also appear in trending rows, which is not a leak).
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright';

const raw = readFileSync('.env', 'utf8');
for (const l of raw.split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
const BASE = 'http://localhost:3100';
let failed = false;

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const emailB = `iso-test-b-${Date.now()}@gmail.com`;
const { data: created } = await admin.auth.admin.createUser({ email: emailB, password: 'iso-test-pass-1', email_confirm: true });
const userBId = created?.user?.id;

const browser = await chromium.launch();

/** Text of the Continue Watching section only (empty string when absent). */
async function continueSectionText(page) {
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500); // guest row loads after mount
  const section = page.locator('section', {
    has: page.getByRole('heading', { name: /^continue watching$/i }),
  });
  if ((await section.count()) === 0) return '';
  return (await section.first().textContent()) ?? '';
}

async function signIn(page, email, password) {
  await page.goto(`${BASE}/signin`, { waitUntil: 'networkidle' });
  await page.fill('#signin-email', email);
  await page.fill('#signin-password', password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/account**', { timeout: 15000 });
}

async function watchTitle(page, path) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
  const consent = page.locator('button', { hasText: /play|load|continue/i }).first();
  try { await consent.click({ timeout: 4000 }); } catch { /* no consent */ }
  // The skippable pre-roll (when configured) gates the player: wait out the
  // 5s countdown, then skip, so the player mounts and tracking fires.
  const skip = page.getByRole('button', { name: /skip ad/i });
  try {
    await skip.waitFor({ state: 'visible', timeout: 12000 });
    await skip.click();
  } catch { /* no pre-roll configured */ }
  await page.waitForTimeout(4000);
}

// 1. User A (admin) watches The Dark Knight -> it appears in THEIR section.
const ctxA = await browser.newContext();
const pageA = await ctxA.newPage();
await signIn(pageA, process.env.ADMIN_EMAIL, process.env.ADMIN_PASSWORD);
await watchTitle(pageA, '/watch/movie/the-dark-knight-155');
const aText = await continueSectionText(pageA);
const aSees = aText.includes('The Dark Knight');
console.log(`1. user A's continue section has Dark Knight: ${aSees ? '✓' : '✗'} (section: "${aText.slice(0, 80).trim()}")`);
if (!aSees) failed = true;

// 2. Fresh guest: no cookies, no localStorage — their section must be empty/absent.
const ctxG = await browser.newContext();
const pageG = await ctxG.newPage();
const gText = await continueSectionText(pageG);
const guestLeak = gText.includes('The Dark Knight');
console.log(`2. fresh guest's section free of A's titles: ${!guestLeak ? '✓' : `✗ LEAK: "${gText.slice(0, 80)}"`}`);
if (guestLeak) failed = true;

// 3. Guest watches Inception -> their LOCAL section shows Inception only.
await watchTitle(pageG, '/watch/movie/inception-27205');
const gText2 = await continueSectionText(pageG);
const gSeesInception = gText2.includes('Inception');
const gLeak = gText2.includes('The Dark Knight');
console.log(`3. guest's local section: Inception ${gSeesInception ? '✓' : '✗'}, no Dark Knight ${!gLeak ? '✓' : '✗'} ("${gText2.slice(0, 80).trim()}")`);
if (!gSeesInception || gLeak) failed = true;

// 4. User B (different account): their section must NOT contain A's titles.
if (userBId) {
  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  await signIn(pageB, emailB, 'iso-test-pass-1');
  const bText = await continueSectionText(pageB);
  const bLeak = bText.includes('The Dark Knight') || bText.includes('Inception');
  console.log(`4. user B's section free of others' titles: ${!bLeak ? '✓' : `✗ LEAK: "${bText.slice(0, 80)}"`}`);
  if (bLeak) failed = true;
  await ctxB.close();
} else {
  console.log('4. SKIPPED (user B creation failed)');
}

await admin.auth.admin.deleteUser(userBId).catch(() => {});
await browser.close();
console.log(failed ? '\nFAILED' : '\nALL PASSED');
process.exit(failed ? 1 : 0);
