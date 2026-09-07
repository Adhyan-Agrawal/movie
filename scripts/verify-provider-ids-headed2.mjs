// Focused headed probe #2 — mimics app iframe embedding: navigates with a
// Referer (like the Lumora page would set) and scans every frame up to 40s.
// Captures provider-domain API request PATHNAMES + STATUS only (query stripped,
// stream/m3u8/mp4/ts URLs skipped entirely). Never logs stream URLs.
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled'] });

const PROBES = [
  ['S1_vidsrc_tmdb', 'Server1 vidsrc.mov TMDB', 'https://vidsrc.mov/embed/tv/1416/1/1'],
  ['S1_vidsrc_imdb', 'Server1 vidsrc.mov IMDb', 'https://vidsrc.mov/embed/tv/tt0413573/1/1'],
  ['S2_2embed_tmdb', 'Server2 2embed   TMDB', 'https://www.2embed.cc/embedtv/1416?s=1&e=1'],
  ['S2_2embed_imdb', 'Server2 2embed   IMDb', 'https://www.2embed.cc/embedtv/tt0413573?s=1&e=1'],
  ['S3_vsembed_tmdb', 'Server3 vsembed  TMDB', 'https://vsembed.su/embed/tv/1416/1/1'],
  ['S3_vsembed_imdb', 'Server3 vsembed  IMDb', 'https://vsembed.su/embed/tv/tt0413573/1/1'],
  ['S4_vidup_tmdb', 'Server4 vidup    TMDB', 'https://vidup.to/tv/1416/1/1'],
  ['S4_vidup_imdb', 'Server4 vidup    IMDb', 'https://vidup.to/tv/tt0413573/1/1'],
];

async function scanFrame(f) {
  try {
    return await f.evaluate(() => {
      const v = document.querySelector('video');
      const hasSrc = !!(v && (v.currentSrc || (v.src && v.src !== 'about:blank') || v.srcObject));
      const players = ['#player', '.player', '.video-container', '.video-js', '.jwplayer', '[id*="player" i]', '[class*="player" i]'].some((s) => document.querySelector(s));
      return {
        url: location.href.slice(0, 90),
        video: v ? { hasSrc, rs: v.readyState, paused: v.paused, dur: isFinite(v.duration) ? v.duration : 0, t: v.currentTime } : null,
        players,
        text: (document.body ? document.body.innerText : '').replace(/\s+/g, ' ').trim().slice(0, 300),
      };
    });
  } catch {
    return null;
  }
}

for (const [slug, label, url] of PROBES) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  });
  await context.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
  const page = await context.newPage();

  // Capture provider-domain API requests: pathname + status only. Skip streams.
  const apiHits = [];
  page.on('request', (req) => {
    const u = req.url();
    if (/\.(m3u8|mp4|m4s|ts)(\?|$)/i.test(u)) return; // never log stream URLs
    const host = new URL(u).hostname;
    const isProvider = /vidsrc\.mov|2embed\.cc|vsembed\.su|vidup\.to/i.test(host);
    if (!isProvider) return;
    const p = new URL(u).pathname;
    apiHits.push(`${req.method()} ${host}${p} => pending`);
  });
  page.on('response', (res) => {
    const u = res.url();
    if (/\.(m3u8|mp4|m4s|ts)(\?|$)/i.test(u)) return;
    const host = new URL(u).hostname;
    if (!/vidsrc\.mov|2embed\.cc|vsembed\.su|vidup\.to/i.test(host)) return;
    const p = new URL(u).pathname;
    const idx = apiHits.findLastIndex((h) => h.startsWith(`${res.request().method()} ${host}${p}`) && h.endsWith('=> pending'));
    const line = `${res.request().method()} ${host}${p} => ${res.status()}`;
    if (idx >= 0) apiHits[idx] = line;
    else apiHits.push(line);
  });

  let errorLines = [];
  page.on('console', (m) => { if (m.type() === 'error') errorLines.push(m.text().slice(0, 120)); });

  let verdict = 'BLANK';
  let evidence = '';
  let finalUrl = '';
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000, referer: 'http://localhost:3000/' });
    finalUrl = page.url();

    const t0 = Date.now();
    let best = null;
    let lastSnapshot = null;
    while (Date.now() - t0 < 40000) {
      const scans = [];
      for (const f of page.frames()) { const s = await scanFrame(f); if (s) scans.push(s); }
      lastSnapshot = scans;
      const withV = scans.find((s) => s.video && s.video.hasSrc);
      if (withV) { best = withV; break; }
      await page.waitForTimeout(2000);
    }
    const finalScans = [];
    for (const f of page.frames()) { const s = await scanFrame(f); if (s) finalScans.push(s); }
    const withV = finalScans.find((s) => s.video && s.video.hasSrc) || best;
    const snapshot = withV || lastSnapshot || finalScans;

    const texts = (finalScans.length ? finalScans : snapshot).map((s) => s.text).filter((t) => t && t.length > 2);
    const combined = texts.join(' || ').slice(0, 900);
    const isCF = /just a moment|verify(ing)? you are human|attention required/i.test(combined);
    const errPat = /invalid input|invalid|no results|no result|not found|nothing found|no matching|no video|title not found|page not found|404|unavailable|unable to|failed|could not|doesn'?t exist|does not exist|content not|no episode|oops/i;

    const v = withV ? withV.video : null;
    if (v && v.hasSrc) {
      verdict = 'PLAYS';
      evidence = `video src=yes rs=${v.rs} paused=${v.paused} dur=${v.dur ? v.dur.toFixed(1) : 'n/a'} t=${v.t.toFixed(1)}s frame="${withV.url}"`;
    } else if (isCF) {
      verdict = 'BLOCKED';
      evidence = 'Cloudflare challenge';
    } else if (errPat.test(combined)) {
      verdict = 'ERROR';
      const pos = combined.search(errPat);
      evidence = `"${combined.slice(Math.max(0, pos - 45), pos + 70)}"`;
    } else if (finalScans.some((s) => s.players)) {
      verdict = 'PLAYER_UI';
      const f = finalScans.find((s) => s.players);
      const vv = finalScans.map((s) => (s.video ? `video(src=${s.video.hasSrc},rs=${s.video.rs},t=${s.video.t.toFixed(1)})` : 'novideo')).join(';');
      evidence = `player UI present; ${vv} frame="${f ? f.url : ''}"`;
    } else if (combined.trim().length < 40) {
      verdict = 'BLANK';
      evidence = `thin body "${combined.slice(0, 90)}"`;
    } else {
      verdict = 'PAGE';
      evidence = `no video/error; text="${combined.slice(0, 130)}"`;
    }
    if (v && v.hasSrc && v.rs >= 2 && !v.paused) evidence += ' | loaded+playing';

    console.log(`\n===== ${label} =====`);
    console.log(`  url      : ${url}`);
    console.log(`  finalUrl : ${finalUrl}`);
    console.log(`  verdict  : ${verdict}`);
    console.log(`  evidence : ${evidence}`);
    console.log(`  frames   : ${finalScans.length}`);
    if (apiHits.length) console.log(`  api      : ${apiHits.slice(0, 12).join(' ; ')}`);
    if (errorLines.length) console.log(`  console  : ${errorLines.slice(0, 3).join(' | ')}`);
    await page.screenshot({ path: `scripts/probe2-${slug}.png` }).catch(() => {});
  } catch (e) {
    verdict = 'NAVFAIL';
    evidence = String(e.message).slice(0, 140);
    console.log(`\n===== ${label} =====\n  url: ${url}\n  verdict: NAVFAIL\n  evidence: ${evidence}`);
  }
  console.log(`  RESULT   : ${verdict} | ${evidence.slice(0, 160)}`);
  await context.close();
}

await browser.close();
