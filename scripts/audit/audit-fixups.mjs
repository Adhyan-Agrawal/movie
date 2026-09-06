/** Fix-up pass for sections 3-6 of the admin audit (script bugs in first run). */
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'D:/movie platform';
const OUT = path.join(ROOT, 'scripts/audit');
const SHOTS = path.join(OUT, 'screenshots');
const BASE = 'http://localhost:3100';

const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n').filter((l) => l.includes('=') && !l.trim().startsWith('#')).map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const results = JSON.parse(fs.readFileSync(path.join(OUT, 'audit-results.json'), 'utf8'));
function upsert(section, verdict, evidence) {
  results.results = results.results.filter((r) => r.section !== section);
  results.results.push({ section, verdict, evidence });
  console.log(`\n=== ${section}: ${verdict} ===\n${evidence}`);
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const bag = { consoleErrors: [], pageErrors: [], http: [] };
page.on('console', (m) => { if (m.type() === 'error') bag.consoleErrors.push(m.text()); });
page.on('pageerror', (e) => bag.pageErrors.push(String(e)));
page.on('response', (r) => { if (r.status() >= 400) bag.http.push(`${r.status()} ${r.url()}`); });
const sum = () => `consoleErrors=${bag.consoleErrors.length} ${bag.consoleErrors.slice(0, 3).join(' | ')}; pageErrors=${bag.pageErrors.length}; http>=400=${[...new Set(bag.http)].slice(0, 5).join(' ')}`;

await page.goto(`${BASE}/signin`, { waitUntil: 'networkidle', timeout: 90000 });
await page.fill('input[name="email"]', 'adhyanagrawal777@gmail.com');
await page.fill('input[name="password"]', 'lumora@2007');
await page.click('button[type="submit"]');
await page.waitForURL((u) => !u.pathname.startsWith('/signin'), { timeout: 60000 });

// ---- 3. TMDB sync (proper) ----
try {
  const { count: titlesBefore } = await admin.from('titles').select('*', { count: 'exact', head: true });
  await page.goto(`${BASE}/admin/sync`, { waitUntil: 'networkidle', timeout: 90000 });
  const chartsBtn = page.getByRole('button', { name: /Charts \(popular \+ top rated\)/ });
  const discoverBtn = page.getByRole('button', { name: /Browse by genre & year/ });
  const chartsPressed = await chartsBtn.getAttribute('aria-pressed');
  await discoverBtn.click();
  await page.waitForTimeout(400);
  const discoverVisible = (await page.locator('#sync-genre').isVisible()) && (await page.locator('#sync-year-from').isVisible());
  const genreOptions = await page.locator('#sync-genre option').allTextContents();
  const genreCount = await admin.from('genres').select('*', { count: 'exact', head: true });
  await chartsBtn.click();
  await page.waitForTimeout(300);
  const chartsGenreHidden = !(await page.locator('#sync-genre').isVisible().catch(() => false));

  await page.selectOption('#sync-pages', '1');
  await page.getByRole('button', { name: /Sync catalog now/ }).click();
  const status = page.locator('[role="status"], [role="alert"]').first();
  await status.waitFor({ state: 'visible', timeout: 300000 });
  // wait for the button to leave the pending state
  await page.waitForFunction(() => !document.body.innerText.includes('Syncing from TMDB'), { timeout: 300000 });
  await page.waitForTimeout(1500);
  const settledText = (await status.innerText()).replace(/\n/g, ' | ');
  await page.screenshot({ path: path.join(SHOTS, '03-sync-after.png'), fullPage: true });
  const { count: titlesAfter } = await admin.from('titles').select('*', { count: 'exact', head: true });
  const { count: importsAfter } = await admin.from('imports').select('*', { count: 'exact', head: true });
  const { count: auditAfter } = await admin.from('audit_logs').select('*', { count: 'exact', head: true });
  const ok = (await status.getAttribute('role')) === 'status' && !/error|denied/i.test(settledText);
  upsert(
    '3. /admin/sync (TMDB sync)',
    ok ? 'WORKING' : 'PARTIALLY WORKING',
    `Modes: charts default (aria-pressed=${chartsPressed}); discover toggle reveals genre/year controls: ${discoverVisible}; back to charts hides them: ${chartsGenreHidden}.\n  Genre dropdown options: ${genreOptions.length} (from DB genres table: ${genreCount.count}) — ${genreOptions.slice(0, 10).join(', ')}${genreOptions.length > 10 ? ' …' : ''}\n  1-page charts sync result panel: "${settledText}"\n  Titles in DB: ${titlesBefore} -> ${titlesAfter} (delta ${titlesAfter - titlesBefore}); imports rows: ${importsAfter}; audit_logs rows: ${auditAfter}\n  ${sum()}`,
  );
} catch (e) {
  upsert('3. /admin/sync (TMDB sync)', 'BROKEN', `${e}\n  ${sum()}`);
}
bag.consoleErrors.length = 0; bag.pageErrors.length = 0; bag.http.length = 0;

// ---- 4. Providers (cards, not table) ----
try {
  await page.goto(`${BASE}/admin/providers`, { waitUntil: 'networkidle', timeout: 90000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(SHOTS, '04-providers.png'), fullPage: true });
  const body = (await page.textContent('body')).replace(/\s+\n/g, '\n');
  const dbSection = body.match(/Database providers[^▄]{0,400}/i)?.[0] || '';
  const builtinSections = await page.locator('section').allInnerTexts();
  const providerDb = await admin.from('providers').select('*', { count: 'exact', head: true });
  const mentionsVidsrc = /vidsrc/i.test(body);
  const mentionsVsembed = /vsembed/i.test(body);
  upsert(
    '4. /admin/providers',
    mentionsVidsrc && mentionsVsembed ? 'WORKING' : 'PARTIALLY WORKING',
    `DB providers table rows: ${providerDb.count} (empty in DB).\n  Database-providers section text: "${dbSection.replace(/\n/g, ' ').slice(0, 300)}"\n  Built-in provider cards rendered: ${builtinSections.length} — headings: ${(await page.locator('h3').allInnerTexts()).join(' | ')}\n  Mentions Vidsrc: ${mentionsVidsrc}, VSEmbed: ${mentionsVsembed}\n  ${sum()}`,
  );
} catch (e) {
  upsert('4. /admin/providers', 'BROKEN', `${e}\n  ${sum()}`);
}
bag.consoleErrors.length = 0; bag.pageErrors.length = 0; bag.http.length = 0;

// ---- 5. Ads (key column) ----
try {
  await page.goto(`${BASE}/admin/ads`, { waitUntil: 'networkidle', timeout: 90000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(SHOTS, '05-ads.png'), fullPage: true });
  const body = (await page.textContent('body'));
  const ap = await admin.from('ad_placements').select('key,name,format,enabled').order('key');
  const expected = ['home-leaderboard', 'browse-leaderboard', 'title-rectangle', 'watch-preroll', 'watch-banner'];
  const found = expected.filter((k) => body.includes(k));
  const apr = await admin.from('ad_providers').select('*');
  const rowCount = await page.locator('table tbody tr').count();
  const adsterraCtx = (body.match(/[Aa]dsterra[^]{0,150}/) || [''])[0].replace(/\n/g, ' ');
  upsert(
    '5. /admin/ads',
    found.length === 5 && /unconfigured|not configured|disabled/i.test(adsterraCtx) ? 'WORKING' : found.length === 5 ? 'WORKING' : 'PARTIALLY WORKING',
    `Placement rows rendered in table: ${rowCount}. Expected keys found on page: ${found.length}/5 (${found.join(', ')})\n  DB ad_placements: ${ap.data.map((p) => `${p.key}(${p.format},${p.enabled ? 'enabled' : 'disabled'})`).join(', ')}\n  Adsterra context on page: "${adsterraCtx}"\n  ad_providers DB row: ${JSON.stringify(ap.data)}\n  ${sum()}`,
  );
} catch (e) {
  upsert('5. /admin/ads', 'BROKEN', `${e}\n  ${sum()}`);
}
bag.consoleErrors.length = 0; bag.pageErrors.length = 0; bag.http.length = 0;

// ---- 6. Users (buttons before filtering) ----
try {
  await page.goto(`${BASE}/admin/users`, { waitUntil: 'networkidle', timeout: 90000 });
  await page.waitForTimeout(500);
  const rowsBefore = await page.locator('table tbody tr').allInnerTexts();
  const suspend = page.getByRole('button', { name: 'Suspend', exact: true }).first();
  const revoke = page.getByRole('button', { name: 'Revoke', exact: true }).first();
  const suspendInfo = suspend.count() ? { disabled: await suspend.isDisabled(), title: await suspend.getAttribute('title') } : 'not found';
  const revokeInfo = revoke.count() ? { disabled: await revoke.isDisabled(), title: await revoke.getAttribute('title') } : 'not found';

  const search = page.locator('#users-q');
  const accountsDb = await admin.from('accounts').select('display_name,id,is_suspended,created_at');
  await search.fill('adhyan');
  await page.waitForTimeout(500);
  const afterAdhyan = await page.locator('table tbody tr').allInnerTexts();
  await search.fill('zzzz-none');
  await page.waitForTimeout(500);
  const noMatch = await page.locator('table tbody tr').count();
  const noMatchEmpty = (await page.textContent('body')).match(/No matching accounts[^]{0,60}/i)?.[0]?.replace(/\n/g, ' ');
  await search.fill('');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, '06-users.png'), fullPage: true });
  upsert(
    '6. /admin/users',
    rowsBefore.length >= 1 && afterAdhyan.length >= 1 && suspendInfo !== 'not found' ? 'WORKING' : rowsBefore.length >= 1 ? 'PARTIALLY WORKING' : 'BROKEN',
    `Rows rendered: ${rowsBefore.length} (DB accounts=${accountsDb.count}: ${accountsDb.data.map((a) => `${a.display_name}(${a.is_suspended ? 'suspended' : 'active'})`).join(', ')})\n  Sample row: "${rowsBefore[0]?.replace(/\n/g, ' / ')}"\n  Search "adhyan" -> ${afterAdhyan.length} row(s): ${afterAdhyan.map((r) => r.split('\n')[0]).join(', ')}; nonsense -> ${noMatch} rows, empty state: "${noMatchEmpty}"\n  Suspend disabled: ${JSON.stringify(suspendInfo)}; Revoke disabled: ${JSON.stringify(revokeInfo)}\n  ${sum()}`,
  );
} catch (e) {
  upsert('6. /admin/users', 'BROKEN', `${e}\n  ${sum()}`);
}

await ctx.close();
await browser.close();
fs.writeFileSync(path.join(OUT, 'audit-results.json'), JSON.stringify(results, null, 2));
console.log('\n######## UPDATED SUMMARY ########');
for (const r of results.results) console.log(`${r.verdict.padEnd(20)} ${r.section}`);
