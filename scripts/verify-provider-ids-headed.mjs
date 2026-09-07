// Throwaway headed-browser probe v3: Grey's Anatomy (TMDB 1416 / IMDb tt0413573)
// S1E1 — per provider, per id-type: does the episode embed actually PLAY?
// Scans every frame (cross-origin player iframes), waits up to 22s, screenshots.
// Never logs/prints stream/m3u8 URLs.
import { chromium } from 'playwright';
import fs from 'node:fs';

const browser = await chromium.launch({
  headless: false,
  args: ['--disable-blink-features=AutomationControlled'],
});

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
    const r = await f.evaluate(() => {
      const v = document.querySelector('video');
      const hasSrc = !!(
        v &&
        (v.currentSrc || (v.src && v.src !== 'about:blank') || v.srcObject)
      );
      const players = [
        '#player',
        '.player',
        '.video-container',
        '.video-js',
        '.jwplayer',
        '.vjs-tech',
        '[id*="player" i]',
        '[class*="player" i]',
      ].some((sel) => document.querySelector(sel) !== null);
      return {
        url: location.href.slice(0, 90),
        video: v
          ? {
              hasSrc,
              readyState: v.readyState,
              paused: v.paused,
              duration: isFinite(v.duration) ? v.duration : 0,
              currentTime: v.currentTime,
              vw: v.videoWidth,
              vh: v.videoHeight,
            }
          : null,
        players,
        iframeCount: document.querySelectorAll('iframe').length,
        bodyText: (document.body ? document.body.innerText : '').replace(/\s+/g, ' ').trim().slice(0, 220),
      };
    });
    return r;
  } catch {
    return null;
  }
}

const RESULTS = [];

for (let i = 0; i < PROBES.length; i++) {
  const [slug, label, url] = PROBES[i];
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const page = await context.newPage();
  const errorLines = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errorLines.push(m.text().slice(0, 140));
  });
  page.on('pageerror', (e) => errorLines.push(`[pageerror] ${String(e.message).slice(0, 140)}`));

  const out = { label, url, verdict: 'BLANK', evidence: '', title: '', slug };
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });

    // Poll up to 22s scanning all frames for a real video source.
    const t0 = Date.now();
    let best = null;
    while (Date.now() - t0 < 22000) {
      for (const f of page.frames()) {
        const s = await scanFrame(f);
        if (s && s.video && s.video.hasSrc) {
          best = s;
          break;
        }
      }
      if (best) break;
      if (!best) {
        // track any frame with player UI as weak progress
        for (const f of page.frames()) {
          const s = await scanFrame(f);
          if (s && (s.players || s.iframeCount > 1)) best = best || s;
        }
      }
      await page.waitForTimeout(1500);
    }
    await page.waitForTimeout(1500);

    // Final scan of all frames.
    const allScans = [];
    for (const f of page.frames()) {
      const s = await scanFrame(f);
      if (s) allScans.push(s);
    }
    const withVideo = allScans.find((s) => s.video && s.video.hasSrc) || null;
    if (withVideo) best = withVideo;

    const frameTexts = allScans.map((s) => s.bodyText).filter((t) => t && t.length > 3);
    const text = frameTexts.join(' || ').slice(0, 1400);
    const topText = (await page.textContent('body').catch(() => '')) || '';
    const combined = topText.replace(/\s+/g, ' ').trim() + ' ' + text;

    const isCF = /just a moment|verify(ing)? you are human|attention required|cf-challenge/i.test(combined);
    const errPat =
      /invalid input|invalid|no results|no result|not found|nothing found|no matching|no video|title not found|page not found|404|error|unavailable|unable to|failed|could not|doesn'?t exist|does not exist|content not|no episode|oops/i;

    out.title = (await page.title().catch(() => '')) || '';
    await page.screenshot({ path: `scripts/probe-${slug}.png`, fullPage: false }).catch(() => {});

    const v = withVideo ? withVideo.video : null;
    if (v && v.hasSrc) {
      out.verdict = 'PLAYS';
      out.evidence = `video src=yes rs=${v.readyState} paused=${v.paused} dims=${v.vw}x${v.vh} dur=${v.duration ? v.duration.toFixed(1) : 'n/a'} t=${v.currentTime.toFixed(1)}s frame="${withVideo.url}"`;
    } else if (isCF) {
      out.verdict = 'BLOCKED';
      out.evidence = `Cloudflare challenge (topBodyLen=${topText.replace(/\s+/g, ' ').trim().length})`;
    } else if (errPat.test(combined)) {
      out.verdict = 'ERROR';
      const pos = combined.search(errPat);
      out.evidence = `"${combined.slice(Math.max(0, pos - 45), pos + 65)}"`;
    } else if (best && (best.players || best.iframeCount > 1)) {
      out.verdict = 'PLAYER_UI';
      out.evidence = `player UI/iframe chain; video.hasSrc=${v ? v.hasSrc : false} frame="${best.url}"`;
    } else if (allScans.length <= 1 && topText.replace(/\s+/g, ' ').trim().length < 40) {
      out.verdict = 'BLANK';
      out.evidence = `thin body "${topText.replace(/\s+/g, ' ').trim().slice(0, 100)}"`;
    } else {
      out.verdict = 'PAGE';
      out.evidence = `no video/error across ${allScans.length} frame(s); text="${text.slice(0, 150)}"`;
    }

    console.log(`\n===== ${label} =====`);
    console.log(`  url      : ${url}`);
    console.log(`  verdict  : ${out.verdict}`);
    console.log(`  evidence : ${out.evidence}`);
    console.log(`  frames   : ${allScans.length}`);
    if (errorLines.length) console.log(`  console  : ${errorLines.slice(0, 4).join(' | ')}`);
    const seen = allScans
      .map((s) => (s.video ? `video(src=${s.video.hasSrc},rs=${s.video.readyState},t=${s.video.currentTime.toFixed(1)})` : 'novideo') + (s.players ? '+UI' : ''))
      .join(' ; ');
    console.log(`  framescan: ${seen}`);
    out._text = combined.slice(0, 600);
  } catch (e) {
    out.verdict = 'NAVFAIL';
    out.evidence = String(e.message).slice(0, 140);
    console.log(`\n===== ${label} =====\n  url: ${url}\n  verdict: NAVFAIL\n  evidence: ${out.evidence}`);
  }

  RESULTS.push(out);
  await context.close();
}

console.log('\n\n########## SUMMARY ##########');
for (const r of RESULTS) {
  console.log(`${r.verdict.padEnd(9)} | ${r.label.padEnd(22)} | ${r.url.slice(8).padEnd(38)} | ${r.evidence.slice(0, 150)}`);
}

await browser.close();
