// E2E: the native player must render a real <video> for an HLS media_sources
// row (Server 1), and the provider embeds must shift down (Server 2 = vidup).
import { chromium } from 'playwright';

const BASE = 'http://localhost:3100';
const WATCH = `${BASE}/watch/movie/inception-27205`;
let failed = false;
const ok = (cond, label) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed = true;
};

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(WATCH, { waitUntil: 'networkidle' });

// Accept the consent gate if shown (native Server 1 is consent-free, but be safe).
const consent = page.locator('button', { hasText: /load external player/i }).first();
try { await consent.click({ timeout: 3000 }); } catch { /* no consent gate */ }

// Skip the pre-roll ad if configured (skippable after 5s).
try {
  await page.locator('button', { hasText: /skip ad/i }).click({ timeout: 12000 });
} catch { /* no pre-roll zone */ }

// The native <video> element must exist and actually load media.
const video = page.locator('video').first();
ok(await video.count() > 0, 'native <video> element rendered');
const src = await video.getAttribute('src').catch(() => null);
const readyState = await video
  .evaluate(() => new Promise((resolve) => {
    const v = document.querySelector('video');
    if (v && v.readyState > 0) return resolve(v.readyState);
    const onReady = () => { cleanup(); resolve(v?.readyState ?? -1); };
    const cleanup = () => {
      v?.removeEventListener('loadedmetadata', onReady);
      v?.removeEventListener('canplay', onReady);
    };
    v?.addEventListener('loadedmetadata', onReady);
    v?.addEventListener('canplay', onReady);
    setTimeout(() => { cleanup(); resolve(v?.readyState ?? -1); }, 15000);
  }))
  .catch(() => -1);
const hlsAttached = await page.evaluate(() => performance.getEntriesByType('resource')
  .some((r) => r.name.includes('test-streams.mux.dev')));
ok(src?.includes('test-streams.mux.dev') || hlsAttached,
  `video source is the native HLS stream (src=${(src ?? 'none').slice(0, 50)})`);
ok(readyState > 0, `video has media data (readyState=${readyState})`);

// Source selector: 5 servers, native = Server 1, vidup shifted to Server 2.
const options = await page.locator('select option').allTextContents();
ok(options.join(',') === 'Server 1,Server 2,Server 3,Server 4,Server 5',
  `source selector lists ${options.length} servers (${options.join(',')})`);

await page.selectOption('select', 'server-2');
// Switching to an embed server re-applies its consent gate — accept it.
try {
  await page.locator('button', { hasText: /load external player/i }).click({ timeout: 4000 });
} catch { /* already consented */ }
await page.waitForTimeout(2500);
// Scope to the provider embed — an ad banner iframe also lives on the page.
const iframeSrc = await page
  .locator('iframe[src*="vidup.to"]')
  .first()
  .getAttribute('src')
  .catch(() => null);
ok(iframeSrc?.includes('vidup.to') ?? false, `Server 2 switched to the vidup embed (${iframeSrc?.slice(0, 50) ?? 'NONE'})`);

await browser.close();
console.log(failed ? '\nFAILED' : '\nALL PASSED');
process.exit(failed ? 1 : 0);
