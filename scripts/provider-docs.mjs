// Render the provider doc pages (JS SPAs) and extract embed URL patterns.
import { chromium } from 'playwright';

const browser = await chromium.launch();
for (const url of ['https://vidup.to/#documentation', 'https://www.2embed.skin/#api', 'https://vidsrc.mov/#api']) {
  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(3000);
    const text = await page.textContent('body');
    console.log(`\n===== ${url} =====`);
    // Extract lines mentioning embed endpoints/URLs.
    const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
    const interesting = lines.filter((l) =>
      /embed|\/movie\/|\/tv\/|season|episode|imdb|tmdb|player\.|\/e\/|\/v\//i.test(l),
    );
    console.log(interesting.slice(0, 40).join('\n').slice(0, 3000));
  } catch (e) {
    console.log(`\n===== ${url} ===== FAILED: ${e.message?.slice(0, 120)}`);
  }
  await page.close();
}
await browser.close();
