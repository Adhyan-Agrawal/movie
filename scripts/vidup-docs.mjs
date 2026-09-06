// Retry vidup.to docs with longer waits + scroll (SPA).
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('https://vidup.to/#documentation', { waitUntil: 'load', timeout: 40000 });
await page.waitForTimeout(8000);
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
await page.waitForTimeout(3000);
const text = await page.textContent('body').catch(() => '');
console.log('body length:', text.length);
const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
const interesting = lines.filter((l) => /embed|movie|tv|season|episode|imdb|tmdb|api|player/i.test(l));
console.log(interesting.slice(0, 50).join('\n').slice(0, 4000));

// Also try common doc paths.
for (const p of ['/documentation', '/docs', '/api']) {
  try {
    const res = await page.goto(`https://vidup.to${p}`, { waitUntil: 'load', timeout: 20000 });
    await page.waitForTimeout(4000);
    const t = await page.textContent('body').catch(() => '');
    const hits = t.split(/\n+/).map((l) => l.trim()).filter((l) => /embed|imdb|tmdb/i.test(l));
    console.log(`\n--- ${p} (${res?.status()}, len ${t.length}) ---`);
    console.log(hits.slice(0, 20).join('\n').slice(0, 1500));
  } catch (e) {
    console.log(`\n--- ${p} FAILED: ${String(e.message).slice(0, 80)}`);
  }
}
await browser.close();
