// Intercept vidup.to network traffic to find where its docs/API load from.
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage();
const seen = [];
page.on('request', (r) => seen.push(`REQ ${r.method()} ${r.url().slice(0, 120)}`));
page.on('response', (r) => {
  if (r.url().includes('vidup')) seen.push(`RES ${r.status()} ${r.url().slice(0, 120)} [${r.headers()['content-type'] ?? ''}]`);
});
try {
  await page.goto('https://vidup.to/#documentation', { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(10000);
  // Try clicking anything that looks like documentation/api.
  for (const label of ['documentation', 'api', 'docs', 'get started']) {
    const el = page.locator(`text=${label}`).first();
    if (await el.count()) { await el.click({ timeout: 3000 }).catch(() => {}); await page.waitForTimeout(3000); }
  }
  const text = (await page.textContent('body').catch(() => '')).slice(0, 1500);
  console.log('BODY:', text.replace(/\n+/g, ' | ').slice(0, 800));
} catch (e) {
  console.log('FAILED:', String(e.message).slice(0, 100));
}
console.log('\nNETWORK (vidup only):');
console.log(seen.filter((s) => s.includes('vidup')).slice(0, 30).join('\n'));
await browser.close();
