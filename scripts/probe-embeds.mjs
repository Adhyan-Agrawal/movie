// Probe vidup.to and 2embed embed endpoints with a matrix of URL shapes and
// id types, reading the RENDERED page (some are SPAs / Cloudflare-gated that
// curl can't see) to find which combination yields a player vs an error.
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage();

const PROBES = [
  // vidup.to variants (Dark Knight: imdb tt0468569, tmdb 155)
  ['vidup  movie/imdb', 'https://vidup.to/embed/movie/tt0468569'],
  ['vidup  movie/tmdb', 'https://vidup.to/embed/movie/155'],
  ['vidup  bare/imdb', 'https://vidup.to/embed/tt0468569'],
  ['vidup  bare/tmdb', 'https://vidup.to/embed/155'],
  ['vidup  e/imdb', 'https://vidup.to/e/tt0468569'],
  ['vidup  tv/imdb', 'https://vidup.to/embed/tv/tt0903747/1/1'],
  ['vidup  tv/tmdb', 'https://vidup.to/embed/tv/1396/1/1'],
  // 2embed variants
  ['2embed cc  embed/imdb', 'https://www.2embed.cc/embed/tt0468569'],
  ['2embed cc  embed/tmdb', 'https://www.2embed.cc/embed/155'],
  ['2embed skin embed/imdb', 'https://www.2embed.skin/embed/tt0468569'],
  ['2embed skin embed/tmdb', 'https://www.2embed.skin/embed/155'],
  ['2embed skin embedtv', 'https://www.2embed.skin/embedtv/tt0903747?s=1&e=1'],
];

for (const [label, url] of PROBES) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(4000);
    const text = (await page.textContent('body').catch(() => '')).replace(/\s+/g, ' ').trim();
    const verdict = /invalid|not found|error|blocked|404/i.test(text) ? 'ERROR' : text.length > 400 ? 'PLAYER?' : 'THIN';
    console.log(`${verdict.padEnd(7)} ${label.padEnd(22)} -> "${text.slice(0, 110)}"`);
  } catch (e) {
    console.log(`FAIL    ${label.padEnd(22)} -> ${String(e.message).slice(0, 80)}`);
  }
}

await browser.close();
