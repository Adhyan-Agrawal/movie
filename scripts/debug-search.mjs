// Debug: instrument the search flow — does the action fire? what does it return?
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const raw = readFileSync('.env', 'utf8');
for (const l of raw.split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
const BASE = 'http://localhost:3100';

const browser = await chromium.launch();
const page = await browser.newPage();

page.on('request', (req) => {
  if (req.method() === 'POST' && req.url().includes('/search')) {
    console.log('ACTION POST fired:', req.url().slice(0, 80));
  }
});
page.on('response', async (res) => {
  if (res.request().method() === 'POST' && res.url().includes('/search')) {
    console.log('ACTION response status:', res.status());
  }
});
page.on('console', (msg) => {
  if (msg.type() === 'error') console.log('console.error:', msg.text().slice(0, 200));
});
page.on('pageerror', (err) => console.log('pageerror:', String(err).slice(0, 200)));

await page.goto(`${BASE}/search`, { waitUntil: 'networkidle' });
await page.fill('#site-search', 'Whiplash');
await page.waitForTimeout(10000);

const body = await page.textContent('body');
console.log('body mentions Whiplash:', body.includes('Whiplash'));
const resultsText = await page.locator('[role="status"], [aria-live]').first().textContent().catch(() => null);
console.log('status region:', resultsText?.slice(0, 120) ?? '(none)');
await browser.close();
