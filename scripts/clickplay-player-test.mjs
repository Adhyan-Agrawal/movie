// Headed test: load cloudorchestranova player for both id types, CLICK the play
// button (autoStart:false), and check whether a <video> gets a real source.
// Never logs stream URLs.
import { chromium } from 'playwright';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

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
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 120)));

  let result = 'NAVFAIL';
  let evidence = '';
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000, referer: 'https://vsembed.su/embed/tv/1416/1/1' });
    await page.waitForTimeout(3000);

    // Find and click the play control
    const clicked = await page.evaluate(() => {
      const sel = ['#bigPlay', '#play', '.big-play-button', '.vjs-big-play-button', '[class*="play" i]', 'button', '[role="button"]'];
      for (const s of sel) {
        const el = document.querySelector(s);
        if (el) { (el).click(); return s; }
      }
      return null;
    });

    const t0 = Date.now();
    let state = null;
    while (Date.now() - t0 < 25000) {
      for (const f of page.frames()) {
        try {
          const s = await f.evaluate(() => {
            const v = document.querySelector('video');
            return {
              hasSrc: !!(v && (v.currentSrc || (v.src && v.src !== 'about:blank') || v.srcObject)),
              rs: v ? v.readyState : -1,
              t: v ? v.currentTime : -1,
              dur: v && isFinite(v.duration) ? v.duration : -1,
            };
          });
          if (s && s.hasSrc) { state = s; break; }
        } catch {}
      }
      if (state) break;
      await page.waitForTimeout(1500);
    }
    if (!state) {
      for (const f of page.frames()) {
        try {
          const s = await f.evaluate(() => {
            const v = document.querySelector('video');
            return { hasSrc: !!(v && (v.currentSrc || (v.src && v.src !== 'about:blank') || v.srcObject)), rs: v ? v.readyState : -1, t: v ? v.currentTime : -1 };
          });
          if (s && (s.hasSrc || s.rs > 0)) state = state || s;
        } catch {}
      }
    }
    const top = (await page.evaluate(() => document.body ? document.body.innerText : '').catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 150);
    result = state && state.hasSrc ? 'VIDEO_PRESENT' : state ? 'PLAYER_BUT_NO_SRC' : 'NO_PLAYER';
    evidence = `clicked=${clicked} hasSrc=${state ? state.hasSrc : false} rs=${state ? state.rs : -1} t=${state ? state.t.toFixed(1) : -1} top="${top}"`;
    await page.screenshot({ path: `scripts/clickplay-${id}.png` }).catch(() => {});
  } catch (e) {
    result = 'NAVFAIL';
    evidence = String(e.message).slice(0, 140);
  }
  console.log(`\n=== cloudorchestranova click-play id=${id} ===`);
  console.log(`  result  : ${result}`);
  console.log(`  evidence: ${evidence}`);
  if (errors.length) console.log(`  errors  : ${errors.slice(0, 3).join(' | ')}`);
  await context.close();
  return result;
}

const r1 = await probe('1416');
const r2 = await probe('tt0413573');
console.log('\n########## CLICK-PLAY VERDICT ##########');
console.log(`TMDB (1416)      : ${r1}`);
console.log(`IMDb (tt0413573) : ${r2}`);
await browser.close();
