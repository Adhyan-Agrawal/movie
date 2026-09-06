// Headed browser: render vidup.to's SPA homepage/#documentation now that
// Cloudflare passes, and read their REAL embed API docs.
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: false });
const page = await browser.newPage();

try {
  await page.goto('https://vidup.to/#documentation', { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(8000);
  const text = (await page.textContent('body')).replace(/\s+/g, ' ').trim();
  console.log('BODY (first 4000 chars):');
  console.log(text.slice(0, 4000));
} catch (e) {
  console.log('FAILED:', String(e.message).slice(0, 120));
}

await browser.close();
