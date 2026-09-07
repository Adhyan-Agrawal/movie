// Mimic the app's iframe embedding: serve a local page that embeds the provider
// URL in an iframe (allow autoplay, NO sandbox, referrerpolicy), then headless-
// click play and check for a real <video> src in ANY frame.
// Never logs stream URLs.
import http from 'node:http';
import { chromium } from 'playwright';

const TARGETS = [
  ['S1_vidsrc_tmdb', 'https://vidsrc.mov/embed/tv/1416/1/1'],
  ['S1_vidsrc_imdb', 'https://vidsrc.mov/embed/tv/tt0413573/1/1'],
  ['S2_2embed_tmdb', 'https://www.2embed.cc/embedtv/1416?s=1&e=1'],
  ['S2_2embed_imdb', 'https://www.2embed.cc/embedtv/tt0413573?s=1&e=1'],
  ['S3_vsembed_tmdb', 'https://vsembed.su/embed/tv/1416/1/1'],
  ['S3_vsembed_imdb', 'https://vsembed.su/embed/tv/tt0413573/1/1'],
  ['S4_vidup_tmdb', 'https://vidup.to/tv/1416/1/1'],
  ['S4_vidup_imdb', 'https://vidup.to/tv/tt0413573/1/1'],
];

// Local HTTP server that embeds the target in an iframe (like the app does).
let embedUrl = '';
const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end(`<!DOCTYPE html><html><body style="margin:0">
  <iframe id="p" src="${embedUrl}" width="1280" height="720"
    allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
    referrerpolicy="strict-origin-when-cross-origin"
    allowfullscreen></iframe>
  <div id="status">embed test</div>
  </body></html>`);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const browser = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled'] });

async function checkIframe(slug, url) {
  embedUrl = url;
  const context = await browser.newContext({ viewport: { width: 1320, height: 820 }, locale: 'en-US' });
  await context.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
  const page = await context.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 100)));

  const scan = async (f) => {
    try {
      return await f.evaluate(() => {
        const v = document.querySelector('video');
        return {
          url: location.href.slice(0, 80),
          hasSrc: !!(v && (v.currentSrc || (v.src && v.src !== 'about:blank') || v.srcObject)),
          rs: v ? v.readyState : -1,
          paused: v ? v.paused : null,
          t: v ? v.currentTime : -1,
          players: !!document.querySelector('#player, #bigPlay, .vjs-big-play-button, [class*="play" i], [id*="play" i], video'),
          text: (document.body ? document.body.innerText : '').replace(/\s+/g, ' ').trim().slice(0, 90),
        };
      });
    } catch { return null; }
  };

  let out = { verdict: 'BLANK', evidence: '' };
  try {
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    // wait for the iframe to load
    await page.waitForTimeout(4000);

    // First look for player UI / video in all frames (no click).
    let snap = [];
    for (const f of page.frames()) { const s = await scan(f); if (s) snap.push(s); }
    let playerFrame = snap.find((s) => s.players && s.url !== 'about:blank' && s.url.includes('//'));
    let videoState = snap.find((s) => s.hasSrc);

    // If no src, click a play control in every non-blank frame.
    if (!videoState) {
      for (const f of page.frames()) {
        if (f.url() === 'about:blank') continue;
        try {
          await f.evaluate(() => {
            const sels = ['#bigPlay', '#play', '.vjs-big-play-button', '[aria-label*="play" i]', 'button[class*="play" i]', 'button', '.play'];
            for (const s of sels) { const el = document.querySelector(s); if (el) { el.click(); return; } }
          }).catch(() => {});
        } catch {}
      }
    }

    const t0 = Date.now();
    while (Date.now() - t0 < 20000) {
      for (const f of page.frames()) {
        const s = await scan(f);
        if (s && s.hasSrc) { videoState = s; break; }
      }
      if (videoState) break;
      await page.waitForTimeout(1200);
    }

    // final snapshot
    const finals = [];
    for (const f of page.frames()) { const s = await scan(f); if (s) finals.push(s); }
    const v = finals.find((s) => s.hasSrc) || videoState;
    // Strip Chrome error-page noise ("This site can't be reached ... server IP
    // address could not be found") produced by a broken ad/tracker frame; it is
    // NOT the player failing. Only flag genuine player-level error text.
    const text = finals
      .map((s) => s.text)
      .filter((t) => t && t.length > 2)
      .join(' | ')
      .replace(/This site[^|]*server IP address could not be found[^|]*\|?/gi, '')
      .slice(0, 200);
    const isErr = /invalid input|not found|no results|no result|unavailable|no video|no title|failed|could not|404|doesn'?t exist|does not exist/i.test(text);

    if (v && v.hasSrc) {
      out.verdict = 'PLAYS';
      out.evidence = `video src=yes rs=${v.rs} paused=${v.paused} t=${v.t.toFixed(1)}s frame="${v.url}"`;
    } else if (isErr) {
      out.verdict = 'ERROR';
      out.evidence = `text="${text.slice(0, 120)}"`;
    } else if (finals.some((s) => s.players)) {
      out.verdict = 'PLAYER_UI';
      out.evidence = `player UI present (needs click?); hasSrc=false; frames=${finals.length}; text="${text.slice(0, 120)}"`;
    } else {
      out.verdict = 'BLANK';
      out.evidence = `no video/player/error; frames=${finals.length}; text="${text.slice(0, 120)}"`;
    }
    await page.screenshot({ path: `scripts/embed-${slug}.png` }).catch(() => {});
  } catch (e) {
    out.verdict = 'NAVFAIL';
    out.evidence = String(e.message).slice(0, 140);
  }
  await context.close();
  console.log(`${out.verdict.padEnd(9)} | ${slug.padEnd(20)} | ${url.slice(8).padEnd(40)} | ${out.evidence.slice(0, 130)}`);
  return out;
}

console.log('########## EMBEDDED-IFRAME PROBE (mimics app) ##########');
const results = [];
for (const [slug, url] of TARGETS) {
  results.push(await checkIframe(slug, url));
}
await browser.close();
server.close();
