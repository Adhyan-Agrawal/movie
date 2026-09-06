// Verify Adsterra banners actually RENDER (not just appear in HTML): load the
// home page, inspect each ad iframe's content (it is sandboxed srcdoc, so we
// look at what loaded inside it), and check network requests to Adsterra hosts.
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const raw = readFileSync('.env', 'utf8');
for (const l of raw.split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); }

const browser = await chromium.launch();
const page = await browser.newPage();

const adRequests = [];
page.on('request', (r) => {
  if (/highperformanceformat|adsterra|profitablerate|a\.magsrv|mgid/i.test(r.url())) {
    adRequests.push(`${r.url().slice(0, 90)}`);
  }
});

await page.goto('http://localhost:3100/', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(8000);

// Inspect each ad iframe (same-process srcdoc frames are accessible to CDP).
const frames = page.frames();
console.log('frames:', frames.length);
let adFrameContent = 0;
for (const f of frames) {
  try {
    const html = await f.content();
    if (html.length > 200 && (html.includes('atOptions') || /banner|ad/i.test(html.slice(0, 400)))) {
      adFrameContent++;
      console.log(`  ad frame (${f.url().slice(0, 40) || 'srcdoc'}): ${html.length} bytes`);
    }
  } catch { /* cross-origin inner frames not inspectable — expected */ }
}

console.log(`ad-related network requests: ${adRequests.length}`);
adRequests.slice(0, 5).forEach((u) => console.log('  ', u));

// Check the visible ad slot area dimensions (rendered size).
const slot = page.locator('iframe[title*="Advertisement"]').first();
if (await slot.count()) {
  const box = await slot.boundingBox();
  console.log(`leaderboard iframe visible: ${box ? `${Math.round(box.width)}x${Math.round(box.height)}px` : 'not visible'}`);
} else {
  console.log('NO leaderboard iframe found');
}

await browser.close();
