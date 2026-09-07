// Decisive headed test: fresh vs_src.php token -> open cloudorchestranova.com
// player in headed browser, scan all frames for a <video> with a real src.
// Never logs tokens / stream URLs.
import { chromium } from 'playwright';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function playerUrlFor(id) {
  const api = `https://vsembed.su/vs_src.php?type=tv&id=${encodeURIComponent(id)}&season=1&episode=1`;
  const r = await fetch(api, { headers: { 'user-agent': UA, referer: 'https://vsembed.su/embed/tv/1416/1/1' } });
  const j = await r.json();
  return typeof j.src === 'string' ? j.src : null;
}

const browser = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled'] });

async function probe(id) {
  const url = await playerUrlFor(id);
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, userAgent: UA });
  await context.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
  const page = await context.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 120)));

  const scan = async (f) => {
    try {
      return await f.evaluate(() => {
        const v = document.querySelector('video');
        return {
          url: location.href.slice(0, 90),
          hasSrc: !!(v && (v.currentSrc || (v.src && v.src !== 'about:blank') || v.srcObject)),
          rs: v ? v.readyState : -1,
          paused: v ? v.paused : null,
          t: v ? v.currentTime : -1,
          dur: v && isFinite(v.duration) ? v.duration : -1,
          players: !!document.querySelector('#player, .video-js, .jwplayer, [id*="player" i]'),
        };
      });
    } catch { return null; }
  };

  let state = null;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000, referer: 'https://vsembed.su/embed/tv/1416/1/1' });
    const t0 = Date.now();
    while (Date.now() - t0 < 25000) {
      for (const f of page.frames()) {
        const s = await scan(f);
        if (s && s.hasSrc) state = s;
      }
      if (state) break;
      await page.waitForTimeout(1500);
    }
    if (!state) {
      for (const f of page.frames()) {
        const s = await scan(f);
        if (s && (s.players || s.hasSrc)) state = state || s;
      }
    }
    const top = await page.evaluate(() => (document.body ? document.body.innerText : '').replace(/\s+/g, ' ').trim().slice(0, 200)).catch(() => '');
    console.log(`\n=== cloudorchestranova player id=${id} ===`);
    if (state) console.log(`  video src=${state.hasSrc} rs=${state.rs} paused=${state.paused} t=${state.t.toFixed(1)}s dur=${state.dur.toFixed(1)} players=${state.players} frame="${state.url}"`);
    else console.log(`  no video with src found across ${page.frames().length} frame(s)`);
    console.log(`  bodyTop="${top}"`);
    if (errs.length) console.log(`  errors: ${errs.slice(0, 3).join(' | ')}`);
    await page.screenshot({ path: `scripts/player-${id}.png` }).catch(() => {});
    return state;
  } catch (e) {
    console.log(`\n=== cloudorchestranova player id=${id} ===\n  NAVFAIL: ${String(e.message).slice(0, 140)}`);
    return null;
  } finally {
    await context.close();
  }
}

const rTmdb = await probe('1416');
const rImdb = await probe('tt0413573');
console.log('\n########## CLOUDORCHESTRANOVA (vsembed/vidsrc player host) ##########');
console.log(`TMDB: ${rTmdb && rTmdb.hasSrc ? 'VIDEO_PRESENT' : rTmdb ? 'NO_VIDEO' : 'FAIL'}`);
console.log(`IMDb: ${rImdb && rImdb.hasSrc ? 'VIDEO_PRESENT' : rImdb ? 'NO_VIDEO' : 'FAIL'}`);
await browser.close();
