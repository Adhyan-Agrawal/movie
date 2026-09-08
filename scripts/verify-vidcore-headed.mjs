// Headed-browser probe for the new vidcore provider (Server 5).
//
// Loads the documented movie embed for Inception and reports whether a player /
// real <video> renders — i.e. that the embed is NOT a 404, Cloudflare block, or
// error page. Follows the repo's earlier headed-probe scripts
// (verify-provider-ids-headed.mjs) but is a single focused URL.
//
// Never logs stream / .m3u8 / .mp4 URLs. Screenshot is written to
// scripts/vidcore-probe.png.
//
//   node scripts/verify-vidcore-headed.mjs
//
import { chromium } from 'playwright';

const URL = 'https://vidcore.org/embed/movie/27205'; // TMDB id of Inception

const browser = await chromium.launch({
  headless: false,
  args: ['--disable-blink-features=AutomationControlled'],
});

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
const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 140));
});
page.on('pageerror', (e) => consoleErrors.push(`[pageerror] ${String(e.message).slice(0, 140)}`));

/** Scan one frame for a real video source / player UI (no URLs returned). */
async function scanFrame(f) {
  try {
    return await f.evaluate(() => {
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
        video: v
          ? {
              hasSrc,
              readyState: v.readyState,
              paused: v.paused,
              duration: isFinite(v.duration) ? v.duration : 0,
              currentTime: v.currentTime,
              width: v.videoWidth,
              height: v.videoHeight,
            }
          : null,
        players,
        iframeCount: document.querySelectorAll('iframe').length,
        bodyText: (document.body ? document.body.innerText : '').replace(/\s+/g, ' ').trim().slice(0, 260),
      };
    });
  } catch {
    return null;
  }
}

/** Redact URLs from anything we log — never print stream/.m3u8/.mp4 URLs. */
function redact(value) {
  return value.replace(/\bhttps?:\/\/[^\s"'<>]+/gi, '[url]');
}

/** Wait for a real <video src> anywhere in the frame tree. */
async function waitForPlayback(page, maxMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    for (const f of page.frames()) {
      const s = await scanFrame(f);
      if (s && s.video && s.video.hasSrc) return s;
    }
    await page.waitForTimeout(1500);
  }
  return null;
}

let verdict = 'BLANK';
let evidence = '';
let title = '';

try {
  // vidcore can show a transient "Video Unavailable" while its server list
  // warms up on a cold load, so we wait, and retry once by reloading.
  let withVideo = await waitForPlayback(page, 22000);
  if (!withVideo) {
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    withVideo = await waitForPlayback(page, 22000);
  }
  await page.waitForTimeout(1500);

  const allScans = [];
  for (const f of page.frames()) {
    const s = await scanFrame(f);
    if (s) allScans.push(s);
  }
  if (!withVideo) withVideo = allScans.find((s) => s.video && s.video.hasSrc) || null;
  const best = withVideo || allScans.find((s) => s.players || s.iframeCount > 1) || null;

  const frameTexts = allScans.map((s) => s.bodyText).filter((t) => t && t.length > 3);
  const text = redact(frameTexts.join(' || ').slice(0, 1400));
  const topText = redact(((await page.textContent('body').catch(() => '')) || '').replace(/\s+/g, ' ').trim());
  const combined = `${topText} ${text}`;

  const isCloudflare = /just a moment|verify(ing)? you are human|attention required|cf-challenge/i.test(combined);
  const errorPattern =
    /invalid input|invalid|no results|no result|not found|nothing found|no matching|no video|title not found|page not found|404|error|unavailable|unable to|failed|could not|doesn'?t exist|does not exist|content not|no episode|oops/i;

  title = await page.title().catch(() => '');
  await page.screenshot({ path: 'scripts/vidcore-probe.png', fullPage: false }).catch(() => {});

  const v = withVideo ? withVideo.video : null;
  if (v && v.hasSrc) {
    verdict = 'PLAYS';
    evidence = `video src=yes readyState=${v.readyState} paused=${v.paused} dims=${v.width}x${v.height} ` +
      `dur=${v.duration ? v.duration.toFixed(1) : 'n/a'} t=${v.currentTime.toFixed(1)}s frame=player-frame`;
  } else if (isCloudflare) {
    verdict = 'BLOCKED';
    evidence = 'Cloudflare / human-verification interstitial';
  } else if (errorPattern.test(combined)) {
    verdict = 'ERROR';
    const pos = combined.search(errorPattern);
    evidence = `"${combined.slice(Math.max(0, pos - 45), pos + 65)}"`;
  } else if (best && (best.players || best.iframeCount > 1)) {
    verdict = 'PLAYER_UI';
    evidence = `player UI / iframe chain present; video.hasSrc=${v ? v.hasSrc : false}`;
  } else if (allScans.length <= 1 && topText.length < 40) {
    verdict = 'BLANK';
    evidence = `thin body "${topText.slice(0, 100)}"`;
  } else {
    verdict = 'PAGE';
    evidence = `no video/error across ${allScans.length} frame(s); text="${text.slice(0, 160)}"`;
  }
} catch (e) {
  verdict = 'NAVFAIL';
  evidence = redact(String(e.message).slice(0, 200));
}

console.log('\n===== vidcore headed probe =====');
console.log(`  url      : ${URL}`);
console.log(`  title    : ${title}`);
console.log(`  verdict  : ${verdict}`);
console.log(`  evidence : ${evidence}`);
if (consoleErrors.length) console.log(`  console  : ${consoleErrors.slice(0, 4).join(' | ')}`);

await browser.close();
console.log(`\nRESULT: ${verdict}`);
process.exit(verdict === 'PLAYS' || verdict === 'PLAYER_UI' ? 0 : 1);
