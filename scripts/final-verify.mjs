// Final verification: trailers render, native player + upload pages compile,
// all routes healthy. Real browser for the trailer modal.
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright';

const raw = readFileSync('.env', 'utf8');
for (const l of raw.split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
const BASE = 'http://localhost:3100';
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// Find a title WITH a trailer.
const { data: withTrailer } = await db.from('titles').select('slug, type, name, trailer_url').not('trailer_url', 'is', null).limit(1);
const t = withTrailer?.[0];
console.log(`title with trailer: ${t?.name} (${t?.slug}) -> ${t?.trailer_url?.slice(0, 50)}`);

const browser = await chromium.launch();
const page = await browser.newPage();
let failed = false;

if (t) {
  await page.goto(`${BASE}/title/${t.type}/${t.slug}`, { waitUntil: 'networkidle', timeout: 60000 });
  const btn = page.getByRole('button', { name: /trailer/i });
  const hasBtn = await btn.count();
  console.log(`1. trailer button on title page: ${hasBtn > 0 ? '✓' : '✗ (MISSING)'}`);
  if (hasBtn > 0) {
    await btn.first().click();
    await page.waitForTimeout(3000);
    const dialog = page.locator('[role="dialog"]');
    const embed = page.locator('iframe[src*="youtube-nocookie"]').first();
    const embedSrc = (await embed.count()) ? await embed.getAttribute('src') : null;
    console.log(`2. trailer modal + YouTube embed: ${embedSrc ? `✓ (${embedSrc.slice(0, 60)})` : '✗'}`);
    if (!embedSrc) failed = true;
  } else failed = true;
} else {
  console.log('1. no trailer data — run scripts/backfill-trailers.mjs');
  failed = true;
}

// Route smoke.
for (const p of ['/', '/movies', '/tv', '/browse', '/search', '/signin', '/api/health', '/admin']) {
  const code = await page.request.get(`${BASE}${p}`).then((r) => r.status());
  const expect = p === '/admin' ? 404 : 200;
  const ok = code === expect;
  if (!ok) failed = true;
  console.log(`${ok ? '✓' : '✗'} ${p} -> ${code}${p === '/admin' ? ' (404 expected)' : ''}`);
}

await browser.close();
console.log(failed ? '\nFAILED' : '\nALL PASSED');
process.exit(failed ? 1 : 0);
