// Headed-browser probe: vidup.to blocks headless Chrome via Cloudflare; a
// headed window may pass. Probes vidup patterns + 2embed TMDB/IMDb variants.
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: false });
const page = await browser.newPage();

const PROBES = [
  // vidup with TMDB ids and different shapes
  ['vidup  movie/tmdb 155', 'https://vidup.to/embed/movie/155'],
  ['vidup  bare/tmdb 155', 'https://vidup.to/embed/155'],
  ['vidup  movie/imdb', 'https://vidup.to/embed/movie/tt0468569'],
  ['vidup  e/tmdb', 'https://vidup.to/e/155'],
  ['vidup  tv/tmdb', 'https://vidup.to/embed/tv/1396/1/1'],
  // 2embed confirmations
  ['2embed cc embed/tmdb 155', 'https://www.2embed.cc/embed/155'],
  ['2embed cc embed/tmdb 27205', 'https://www.2embed.cc/embed/27205'],
  ['2embed cc embedtv tmdb', 'https://www.2embed.cc/embedtv/1396?s=1&e=1'],
];

for (const [label, url] of PROBES) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(5000);
    const text = (await page.textContent('body').catch(() => '')).replace(/\s+/g, ' ').trim();
    const hasVideo = await page.locator('video, iframe[src*="player"], jwplayer, #player, .video-container').count();
    const verdict =
      hasVideo > 0 ? 'PLAYER' : /invalid|not found|error|blocked/i.test(text) ? 'ERROR' : text.length > 400 ? 'PAGE' : 'THIN';
    console.log(`${verdict.padEnd(7)} ${label.padEnd(24)} video=${hasVideo} -> "${text.slice(0, 100)}"`);
  } catch (e) {
    console.log(`FAIL    ${label.padEnd(24)} -> ${String(e.message).slice(0, 80)}`);
  }
}

await browser.close();
