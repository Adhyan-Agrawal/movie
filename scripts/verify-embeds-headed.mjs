// Verify the corrected vidup + 2embed embed URLs render actual players
// (headed browser — vidup Cloudflare-blocks headless).
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: false });
const page = await browser.newPage();
let failed = false;

for (const [label, url] of [
  ['vidup movie (Inception)', 'https://vidup.to/movie/tt1375666'],
  ['2embed movie TMDB (Inception)', 'https://www.2embed.cc/embed/27205'],
  ['vidup tv episode (Breaking Bad)', 'https://vidup.to/tv/tt0903747/1/1'],
  ['2embed tv TMDB (Breaking Bad)', 'https://www.2embed.cc/embedtv/1396?s=1&e=1'],
]) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(6000);
    const text = (await page.textContent('body').catch(() => '')).replace(/\s+/g, ' ').trim();
    const video = await page.locator('video, iframe[src*="player"], #player, .video-container, jwplayer').count();
    const ok = video > 0 || (/invalid|404|not found|blocked/i.test(text) === false && text.length > 300);
    console.log(`${ok ? 'OK  ' : 'BAD '} ${label} -> video=${video} "${text.slice(0, 90)}"`);
    if (!ok) failed = true;
  } catch (e) {
    console.log(`FAIL ${label} -> ${String(e.message).slice(0, 80)}`);
    failed = true;
  }
}

await browser.close();
console.log(failed ? '\nFAILED' : '\nALL PASSED');
process.exit(failed ? 1 : 0);
