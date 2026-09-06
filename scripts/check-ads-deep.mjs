// Deep diagnostic of the Adsterra ad frame via /api/ad-frame.
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage();

page.on('console', (msg) => {
  const t = msg.text();
  if (/ad|option|invoke|format|blocked|csp|refused|error/i.test(t)) {
    console.log(`console[${msg.type()}]: ${t.slice(0, 140)}`);
  }
});
page.on('requestfailed', (r) => {
  if (/highperformance|adsterra/i.test(r.url())) console.log(`REQ FAILED: ${r.url().slice(0, 90)} — ${r.failure()?.errorText}`);
});
page.on('requestfinished', (r) => {
  if (/highperformanceformat|adsterra/i.test(r.url())) console.log(`REQ OK: ${r.url().slice(0, 90)}`);
});

await page.goto('http://localhost:3100/', { waitUntil: 'load', timeout: 60000 });
await page.waitForTimeout(10000);

const adFrame = page.frames().find((f) => f.url().includes('/api/ad-frame'));
if (adFrame) {
  const html = await adFrame.content();
  console.log(`\nad frame content: ${html.length} bytes`);
  console.log('contains written iframe:', /<iframe/i.test(html.replace(/<script[\s\S]*<\/script>/g, '')) ? 'YES ✓' : 'no');
  console.log(html.replace(/\s+/g, ' ').slice(0, 500));
  // Nested creative frame?
  const nested = page.frames().filter((f) => f !== adFrame && f.parentFrame() === adFrame);
  console.log(`nested creative frames: ${nested.length}`);
  for (const n of nested) {
    try {
      const c = await n.content();
      console.log(`  nested (${n.url().slice(0, 60)}): ${c.length} bytes, has content: ${c.length > 100 ? 'YES ✓' : 'no'}`);
    } catch {
      console.log(`  nested (${n.url().slice(0, 60)}): cross-origin (creative loaded — good sign)`);
    }
  }
} else {
  console.log('NO ad frame found. frames:', page.frames().map((f) => f.url().slice(0, 40)));
}

await browser.close();
