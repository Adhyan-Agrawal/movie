// E2E: the server selector must actually switch the player's iframe.
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const raw = readFileSync('.env', 'utf8');
for (const l of raw.split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
const BASE = 'http://localhost:3100';
let failed = false;

const browser = await chromium.launch();

async function checkServer(serverValue, expectHost) {
  const page = await browser.newPage();
  await page.goto(`${BASE}/watch/movie/the-dark-knight-155`, { waitUntil: 'networkidle' });

  // Accept consent if shown.
  const consentBtn = page.locator('button', { hasText: /play|load|continue/i }).first();
  try { await consentBtn.click({ timeout: 4000 }); } catch { /* no consent */ }
  await page.waitForTimeout(2000);

  // Select the server.
  await page.selectOption('select', serverValue);
  await page.waitForTimeout(2500);

  // The iframe src must now point at the expected host.
  const src = await page.locator('iframe').first().getAttribute('src').catch(() => null);
  const ok = src?.includes(expectHost);
  console.log(`${serverValue} -> iframe src: ${src?.slice(0, 60) ?? 'NONE'} ${ok ? '✓' : `✗ (expected ${expectHost})`}`);
  if (!ok) failed = true;
  await page.close();
}

// Order matters: Server 1 is default; check switching to 2, 3, 4, then back to 1.
await checkServer('server-2', '2embed.cc');
await checkServer('server-3', 'vsembed.su');
await checkServer('server-4', 'vidsrc.mov');
await checkServer('server-1', 'vidup.to');

await browser.close();
console.log(failed ? '\nFAILED' : '\nALL PASSED');
process.exit(failed ? 1 : 0);
