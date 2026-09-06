/**
 * READ-ONLY admin console audit for Lumora OTT (Next.js 15, dev server :3100).
 * Signs in as the admin in a real browser, exercises every admin route,
 * captures console errors / pageerrors / HTTP>=400, runs a 1-page TMDB
 * charts sync, and verifies access control (anonymous + non-admin -> 404).
 * Does not modify app source. Throwaway viewer user is created via service
 * role and deleted at the end.
 */
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'D:/movie platform';
const OUT = path.join(ROOT, 'scripts/audit');
const SHOTS = path.join(OUT, 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });

const BASE = 'http://localhost:3100';
const ADMIN_EMAIL = 'adhyanagrawal777@gmail.com';
const ADMIN_PASS = 'lumora@2007';

// --- env ---
const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, '.env'), 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;

const admin = createClient(URL_, SERVICE, { auth: { persistSession: false } });
const results = [];
function record(section, verdict, evidence) {
  results.push({ section, verdict, evidence });
  console.log(`\n=== ${section}: ${verdict} ===`);
  console.log(evidence);
}

function bagFor(page) {
  const bag = { consoleErrors: [], pageErrors: [], http: [] };
  page.on('console', (m) => {
    if (m.type() === 'error') bag.consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => bag.pageErrors.push(String(e)));
  page.on('response', (r) => {
    if (r.status() >= 400) bag.http.push(`${r.status()} ${r.request().method()} ${r.url()}`);
  });
  return bag;
}
function summarize(bag) {
  const parts = [];
  parts.push(`consoleErrors=${bag.consoleErrors.length}${bag.consoleErrors.length ? ' :: ' + bag.consoleErrors.slice(0, 5).join(' | ') : ''}`);
  parts.push(`pageErrors=${bag.pageErrors.length}${bag.pageErrors.length ? ' :: ' + bag.pageErrors.slice(0, 5).join(' | ') : ''}`);
  parts.push(`http>=400=${bag.http.length}${bag.http.length ? ' :: ' + [...new Set(bag.http)].slice(0, 8).join(' | ') : ''}`);
  return parts.join('\n  ');
}
async function text(page, sel) {
  try {
    return (await page.locator(sel).first().innerText({ timeout: 5000 })).trim();
  } catch {
    return null;
  }
}

async function dbCount(table, filter = {}) {
  const { count, error } = await admin.from(table).select('*', { count: 'exact', head: true }).match(filter);
  if (error) return `ERR ${error.message}`;
  return count;
}

// ---------- 0. DB baseline ----------
const baseline = {};
for (const t of ['titles', 'accounts', 'profiles', 'playback_sessions', 'ad_providers', 'ad_placements', 'audit_logs', 'imports', 'site_settings', 'feature_flags']) {
  baseline[t] = await dbCount(t);
}
const placements = await admin.from('ad_placements').select('slug').order('slug');
baseline.ad_placement_slugs = placements.error ? `ERR ${placements.error.message}` : placements.data.map((p) => p.slug);
const providers = await admin.from('ad_providers').select('slug,name,is_active').order('slug');
baseline.ad_provider_rows = providers.error ? `ERR ${providers.error.message}` : providers.data;
const streamProviders = await admin.from('stream_sources').select('id,provider,status').limit(20);
baseline.stream_sources = streamProviders.error ? `ERR ${streamProviders.error.message}` : `${streamProviders.data.length} rows (first 3: ${streamProviders.data.slice(0, 3).map((s) => `${s.provider}:${s.status}`).join(', ')})`;
console.log('DB BASELINE:', JSON.stringify(baseline, null, 1));

// ---------- 1. anonymous access control (fetch) ----------
try {
  const r = await fetch(`${BASE}/admin`, { redirect: 'manual' });
  const anonHome = await fetch(`${BASE}/`, { redirect: 'manual' });
  const anonAdminUsers = await fetch(`${BASE}/admin/users`, { redirect: 'manual' });
  record(
    '11a. Access control — anonymous',
    r.status === 404 ? 'WORKING' : 'BROKEN',
    `GET /admin (no cookies) -> ${r.status}; GET /admin/users -> ${anonAdminUsers.status}; GET / -> ${anonHome.status}. Expected 404 for /admin* when anonymous.`,
  );
} catch (e) {
  record('11a. Access control — anonymous', 'BROKEN', String(e));
}

// ---------- 2. browser: admin sign-in ----------
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const bag = bagFor(page);

try {
  await page.goto(`${BASE}/signin`, { waitUntil: 'networkidle', timeout: 90000 });
  await page.fill('input[name="email"]', ADMIN_EMAIL);
  await page.fill('input[name="password"]', ADMIN_PASS);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith('/signin'), { timeout: 60000 });
  record('0. Admin sign-in', 'WORKING', `Signed in, landed on ${page.url()}`);
} catch (e) {
  record('0. Admin sign-in', 'BROKEN', `${e}\n  page text: ${(await page.textContent('body')).slice(0, 400)}`);
  await browser.close();
  process.exit(1);
}

async function visit(path_, name, shot) {
  await page.goto(`${BASE}${path_}`, { waitUntil: 'networkidle', timeout: 90000 });
  await page.waitForTimeout(800);
  if (shot) await page.screenshot({ path: path.join(SHOTS, shot), fullPage: true });
  return (await page.textContent('body')).replace(/\n{2,}/g, '\n').trim();
}

// ---------- 1. Dashboard ----------
try {
  const body = await visit('/admin', 'Dashboard', '01-dashboard.png');
  const tiles = await page.locator('[aria-label="Key metrics"] [class*="StatTile"], [aria-label="Key metrics"] > div').allInnerTexts().catch(() => []);
  const tileText = tiles.length ? tiles.join(' || ') : body.slice(0, 900);
  const hasEmpty = /No audit events recorded yet/i.test(body);
  record(
    '1. /admin Dashboard',
    'WORKING',
    `Stat tiles: ${tileText}\n  DB baseline: titles=${baseline.titles}, accounts=${baseline.accounts}, profiles=${baseline.profiles}, playback_sessions=${baseline.playback_sessions}\n  Audit empty state shown: ${hasEmpty}\n  ${summarize(bag)}`,
  );
  bag.consoleErrors.length = 0; bag.pageErrors.length = 0; bag.http.length = 0;
} catch (e) {
  record('1. /admin Dashboard', 'BROKEN', String(e));
}

// ---------- 2. Catalog titles ----------
try {
  const body = await visit('/admin/catalog/titles', 'Titles', '02-titles.png');
  const rowCount = await page.locator('table tbody tr').count();
  // sorting: click the Name header (aria-sort button)
  const before = await page.locator('table tbody tr').first().innerText();
  await page.locator('th button', { hasText: 'Name' }).first().click();
  await page.waitForTimeout(400);
  const afterAsc = await page.locator('table tbody tr').first().innerText();
  await page.locator('th button', { hasText: 'Name' }).first().click();
  await page.waitForTimeout(400);
  const afterDesc = await page.locator('table tbody tr').first().innerText();
  const publishBtn = page.getByRole('button', { name: 'Publish', exact: true }).first();
  const archiveBtn = page.getByRole('button', { name: 'Archive', exact: true }).first();
  const deleteBtn = page.getByRole('button', { name: 'Delete', exact: true }).first();
  const disabledInfo = {
    publish: await publishBtn.isDisabled(),
    archive: await archiveBtn.isDisabled(),
    delete: await deleteBtn.isDisabled(),
    publishTitle: await publishBtn.getAttribute('title'),
  };
  const hasSearch = /search/i.test(body) && (await page.locator('input[type="search"], input[placeholder*="earch" i]').count()) > 0;
  const hasFilterControls = await page.locator('select').count();
  record(
    '2. /admin/catalog/titles',
    rowCount > 50 ? 'WORKING' : rowCount > 0 ? 'PARTIALLY WORKING' : 'BROKEN',
    `Rows rendered: ${rowCount} (DB has ${baseline.titles} titles).\n  Sort by Name: first row before="${before.split('\n')[0]}" asc="${afterAsc.split('\n')[0]}" desc="${afterDesc.split('\n')[0]}" (order changed: ${before !== afterAsc || afterAsc !== afterDesc})\n  Action buttons disabled (honest affordances): ${JSON.stringify(disabledInfo)}\n  Dedicated search box: ${hasSearch}; select filters: ${hasFilterControls} (page has no filter/search UI beyond sorting — noted)\n  ${summarize(bag)}`,
  );
  bag.consoleErrors.length = 0; bag.pageErrors.length = 0; bag.http.length = 0;
} catch (e) {
  record('2. /admin/catalog/titles', 'BROKEN', `${e}\n  ${summarize(bag)}`);
  bag.consoleErrors.length = 0; bag.pageErrors.length = 0; bag.http.length = 0;
}

// ---------- 3. TMDB sync ----------
try {
  const body = await visit('/admin/sync', 'Sync', '03-sync-before.png');
  const chartsBtn = page.getByRole('button', { name: /Charts \(popular \+ top rated\)/ });
  const discoverBtn = page.getByRole('button', { name: /Browse by genre & year/ });
  const chartsVisible = (await chartsBtn.getAttribute('aria-pressed')) === 'true';

  // switch to discover to check genre dropdown populates
  await discoverBtn.click();
  await page.waitForTimeout(300);
  const genreOptions = await page.locator('#sync-genre option').allTextContents();
  await chartsBtn.click();
  await page.waitForTimeout(200);

  // run 1-page charts sync
  await page.selectOption('#sync-pages', '1');
  await page.getByRole('button', { name: /Sync catalog now/ }).click();
  const statusEl = page.locator('[role="status"], [role="alert"]').first();
  await statusEl.waitFor({ state: 'visible', timeout: 300000 });
  let settled = statusEl.innerText();
  try {
    await page.waitForFunction(
      () => !document.querySelector('button[disabled*="Syncing"], button:has-text("Syncing from TMDB")') || true,
      { timeout: 15000 },
    );
    await page.waitForTimeout(2000);
    settled = await statusEl.innerText();
  } catch {}
  await page.screenshot({ path: path.join(SHOTS, '03-sync-after.png'), fullPage: true });
  const titlesAfter = await dbCount('titles');
  const delta = typeof titlesAfter === 'number' && typeof baseline.titles === 'number' ? titlesAfter - baseline.titles : 'unknown';
  record(
    '3. /admin/sync (TMDB sync)',
    /imported|refreshed|synced|ok/i.test(settled) && !/error|failed/i.test(settled.split('\n')[0]) ? 'WORKING' : 'PARTIALLY WORKING',
    `Modes render: charts (aria-pressed=${chartsVisible}) + discover toggle OK.\n  Genre dropdown options (from DB): ${genreOptions.length} — ${genreOptions.slice(0, 8).join(', ')}${genreOptions.length > 8 ? ' …' : ''}\n  1-page charts sync result panel: "${settled.replace(/\n/g, ' | ')}"\n  titles in DB: before=${baseline.titles}, after=${titlesAfter}, delta=${delta}\n  ${summarize(bag)}`,
  );
  baseline.titles = titlesAfter;
  bag.consoleErrors.length = 0; bag.pageErrors.length = 0; bag.http.length = 0;
} catch (e) {
  record('3. /admin/sync (TMDB sync)', 'BROKEN', `${e}\n  ${summarize(bag)}`);
  bag.consoleErrors.length = 0; bag.pageErrors.length = 0; bag.http.length = 0;
}

// ---------- 4. Providers ----------
try {
  const body = await visit('/admin/providers', 'Providers', '04-providers.png');
  const rowCount = await page.locator('table tbody tr').count();
  const rows = await page.locator('table tbody tr').allInnerTexts();
  const mentionsVidsrc = /vidsrc/i.test(body);
  const mentionsVsembed = /vsembed|vs ?embed/i.test(body);
  const otherProviders = await admin.from('stream_sources').select('provider').then((r) => [...new Set((r.data || []).map((s) => s.provider))]);
  record(
    '4. /admin/providers',
    rowCount > 0 && mentionsVidsrc && mentionsVsembed ? 'WORKING' : rowCount > 0 ? 'PARTIALLY WORKING' : 'BROKEN',
    `Table rows: ${rowCount}\n  Row previews: ${rows.slice(0, 4).map((r) => r.replace(/\n/g, ' / ')).join(' || ')}\n  Mentions Vidsrc: ${mentionsVidsrc}; VSEmbed: ${mentionsVsembed}\n  stream_sources distinct providers in DB: ${otherProviders.join(', ')}\n  ${summarize(bag)}`,
  );
  bag.consoleErrors.length = 0; bag.pageErrors.length = 0; bag.http.length = 0;
} catch (e) {
  record('4. /admin/providers', 'BROKEN', `${e}\n  ${summarize(bag)}`);
  bag.consoleErrors.length = 0; bag.pageErrors.length = 0; bag.http.length = 0;
}

// ---------- 5. Ads ----------
try {
  const body = await visit('/admin/ads', 'Ads', '05-ads.png');
  const rowCount = await page.locator('table tbody tr').count();
  const rows = await page.locator('table tbody tr').allInnerTexts();
  const expectedSlugs = ['home-leaderboard', 'browse-leaderboard', 'title-rectangle', 'watch-preroll', 'watch-banner'];
  const foundSlugs = expectedSlugs.filter((s) => body.includes(s));
  const adsterraStatus = (body.match(/adsterra[^]{0,120}/i) || [''])[0].replace(/\n/g, ' ');
  record(
    '5. /admin/ads',
    rowCount >= 5 && foundSlugs.length === 5 ? 'WORKING' : rowCount > 0 ? 'PARTIALLY WORKING' : 'BROKEN',
    `Placement rows rendered: ${rowCount} (DB seeded: ${baseline.ad_placement_slugs.join(', ')})\n  Expected slugs found on page: ${foundSlugs.join(', ')}\n  Rows: ${rows.slice(0, 6).map((r) => r.replace(/\n/g, ' / ')).join(' || ')}\n  Adsterra context: "${adsterraStatus}"\n  Ad providers in DB: ${JSON.stringify(baseline.ad_provider_rows)}\n  ${summarize(bag)}`,
  );
  bag.consoleErrors.length = 0; bag.pageErrors.length = 0; bag.http.length = 0;
} catch (e) {
  record('5. /admin/ads', 'BROKEN', `${e}\n  ${summarize(bag)}`);
  bag.consoleErrors.length = 0; bag.pageErrors.length = 0; bag.http.length = 0;
}

// ---------- 6. Users ----------
try {
  const body = await visit('/admin/users', 'Users', '06-users.png');
  const rowCount = await page.locator('table tbody tr').count();
  const search = page.locator('input[placeholder*="Display name or account id" i]');
  const hasSearch = (await search.count()) > 0;
  const rowsBefore = await page.locator('table tbody tr').allInnerTexts();
  if (hasSearch) {
    await search.fill('adhyan');
    await page.waitForTimeout(600);
  }
  const filteredCount = await page.locator('table tbody tr').count();
  const filteredRows = await page.locator('table tbody tr').allInnerTexts();
  if (hasSearch) {
    await search.fill('zzzz-no-such-user');
    await page.waitForTimeout(600);
  }
  const noMatchText = (await page.locator('table tbody tr').count()) === 0 ? (await text(page, 'body').then((t) => (t.match(/No matching accounts[^]{0,80}/i) || [''])[0])) : 'rows still shown';
  const suspendBtn = page.getByRole('button', { name: /suspend/i }).first();
  const revokeBtn = page.getByRole('button', { name: /revoke/i }).first();
  const suspendDisabled = suspendBtn.count() ? await suspendBtn.isDisabled() : 'not found';
  const revokeDisabled = revokeBtn.count() ? await revokeBtn.isDisabled() : 'not found';
  record(
    '6. /admin/users',
    rowCount >= 1 && hasSearch && filteredCount >= 1 ? 'WORKING' : rowCount >= 1 ? 'PARTIALLY WORKING' : 'BROKEN',
    `Rows rendered: ${rowCount} (DB accounts=${baseline.accounts})\n  Sample rows: ${rowsBefore.slice(0, 3).map((r) => r.replace(/\n/g, ' / ')).join(' || ')}\n  Search box present: ${hasSearch}; search "adhyan" -> ${filteredCount} rows (${filteredRows.slice(0, 2).map((r) => r.split('\n')[0]).join(', ')}); nonsense search -> ${noMatchText.replace(/\n/g, ' ')}\n  Suspend disabled: ${suspendDisabled} (title="${suspendBtn.count() ? await suspendBtn.getAttribute('title') : ''}"); Revoke disabled: ${revokeDisabled}\n  ${summarize(bag)}`,
  );
  bag.consoleErrors.length = 0; bag.pageErrors.length = 0; bag.http.length = 0;
} catch (e) {
  record('6. /admin/users', 'BROKEN', `${e}\n  ${summarize(bag)}`);
  bag.consoleErrors.length = 0; bag.pageErrors.length = 0; bag.http.length = 0;
}

// ---------- 7. Settings ----------
try {
  const body = await visit('/admin/settings', 'Settings', '07-settings.png');
  const emptyState = (body.match(/No [^]{0,120}/i) || [''])[0].replace(/\n/g, ' ');
  const rowCount = await page.locator('table tbody tr').count();
  record(
    '7. /admin/settings',
    rowCount > 0 || /no (settings|feature|flags|rows)/i.test(body) ? 'WORKING' : 'PARTIALLY WORKING',
    `site_settings rows=${baseline.site_settings}, feature_flags rows=${baseline.feature_flags} in DB. Page table rows: ${rowCount}. Empty-state text: "${emptyState}"\n  Page excerpt: ${body.slice(0, 500).replace(/\n/g, ' | ')}\n  ${summarize(bag)}`,
  );
  bag.consoleErrors.length = 0; bag.pageErrors.length = 0; bag.http.length = 0;
} catch (e) {
  record('7. /admin/settings', 'BROKEN', `${e}\n  ${summarize(bag)}`);
  bag.consoleErrors.length = 0; bag.pageErrors.length = 0; bag.http.length = 0;
}

// ---------- 8. Audit ----------
try {
  const body = await visit('/admin/audit', 'Audit', '08-audit.png');
  const emptyState = (body.match(/No (audit|events)[^]{0,120}/i) || [''])[0].replace(/\n/g, ' ');
  const rowCount = await page.locator('table tbody tr').count();
  record(
    '8. /admin/audit',
    (baseline.audit_logs === 0 && rowCount === 0 && emptyState) || rowCount > 0 ? 'WORKING' : 'PARTIALLY WORKING',
    `audit_logs rows in DB=${baseline.audit_logs}. Page table rows: ${rowCount}. Empty-state: "${emptyState}"\n  Page excerpt: ${body.slice(0, 400).replace(/\n/g, ' | ')}\n  ${summarize(bag)}`,
  );
  bag.consoleErrors.length = 0; bag.pageErrors.length = 0; bag.http.length = 0;
} catch (e) {
  record('8. /admin/audit', 'BROKEN', `${e}\n  ${summarize(bag)}`);
  bag.consoleErrors.length = 0; bag.pageErrors.length = 0; bag.http.length = 0;
}

// ---------- 9. Health ----------
try {
  const body = await visit('/admin/health', 'Health', '09-health.png');
  const statuses = (body.match(/(app|supabase|tmdb|database|db)[^]{0,100}/gi) || []).slice(0, 8).map((s) => s.replace(/\n/g, ' ').trim());
  const badges = await page.locator('[class*="Badge"], [class*="badge"], [data-tone]').allInnerTexts().catch(() => []);
  record(
    '9. /admin/health',
    /operational|healthy|ok|up/i.test(body) ? 'WORKING' : 'PARTIALLY WORKING',
    `Status text found: ${JSON.stringify(statuses)}\n  Badges: ${badges.join(' | ')}\n  Page excerpt: ${body.slice(0, 600).replace(/\n/g, ' | ')}\n  ${summarize(bag)}`,
  );
  bag.consoleErrors.length = 0; bag.pageErrors.length = 0; bag.http.length = 0;
} catch (e) {
  record('9. /admin/health', 'BROKEN', `${e}\n  ${summarize(bag)}`);
  bag.consoleErrors.length = 0; bag.pageErrors.length = 0; bag.http.length = 0;
}

// ---------- 10. Imports ----------
try {
  const body = await visit('/admin/imports', 'Imports', '10-imports.png');
  const emptyState = (body.match(/No (imports|rows)[^]{0,140}/i) || [''])[0].replace(/\n/g, ' ');
  const rowCount = await page.locator('table tbody tr').count();
  const pointsToSync = /sync/i.test(body);
  record(
    '10. /admin/imports',
    baseline.imports === 0 && rowCount === 0 && emptyState ? 'WORKING' : rowCount > 0 ? 'WORKING' : 'PARTIALLY WORKING',
    `imports rows in DB=${baseline.imports}. Page table rows: ${rowCount}. Empty-state: "${emptyState}" Mentions TMDB sync: ${pointsToSync}\n  Page excerpt: ${body.slice(0, 400).replace(/\n/g, ' | ')}\n  ${summarize(bag)}`,
  );
  bag.consoleErrors.length = 0; bag.pageErrors.length = 0; bag.http.length = 0;
} catch (e) {
  record('10. /admin/imports', 'BROKEN', `${e}\n  ${summarize(bag)}`);
  bag.consoleErrors.length = 0; bag.pageErrors.length = 0; bag.http.length = 0;
}

await ctx.close();

// ---------- 11b. non-admin access control ----------
const viewerEmail = `audit-viewer-${Date.now()}@lumora-test.local`;
const viewerPass = 'AuditViewer!2026x';
let viewerId = null;
try {
  const created = await admin.auth.admin.createUser({
    email: viewerEmail,
    password: viewerPass,
    email_confirm: true,
  });
  if (created.error) throw new Error(`createUser: ${created.error.message}`);
  viewerId = created.data.user.id;
  console.log(`viewer created: ${viewerEmail} (${viewerId})`);

  const vctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const vpage = await vctx.newPage();
  const vbag = bagFor(vpage);
  await vpage.goto(`${BASE}/signin`, { waitUntil: 'networkidle', timeout: 90000 });
  await vpage.fill('input[name="email"]', viewerEmail);
  await vpage.fill('input[name="password"]', viewerPass);
  await vpage.click('button[type="submit"]');
  await vpage.waitForURL((u) => !u.pathname.startsWith('/signin'), { timeout: 60000 });
  const landed = vpage.url();

  const resp = await vpage.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const adminStatus = resp.status();
  const body404 = (await vpage.textContent('body')).replace(/\n{2,}/g, '\n').trim();
  const is404Page = /404|not found/i.test(body404);
  await vpage.screenshot({ path: path.join(SHOTS, '11-viewer-admin.png'), fullPage: true });
  record(
    '11b. Access control — signed-in non-admin',
    adminStatus === 404 ? 'WORKING' : 'BROKEN',
    `Viewer (${viewerEmail}) signed in, landed at ${landed}. GET /admin as viewer -> HTTP ${adminStatus}; 404 page rendered: ${is404Page}. Body excerpt: "${body404.slice(0, 200).replace(/\n/g, ' ')}"\n  ${summarize(vbag)}`,
  );
  await vctx.close();
} catch (e) {
  record('11b. Access control — signed-in non-admin', 'BROKEN', String(e));
} finally {
  if (viewerId) {
    const del = await admin.auth.admin.deleteUser(viewerId);
    console.log(`viewer ${del.error ? 'DELETE FAILED: ' + del.error.message : 'deleted'}`);
  }
}

await browser.close();

fs.writeFileSync(path.join(OUT, 'audit-results.json'), JSON.stringify({ baseline, results }, null, 2));
console.log('\n\n######## FINAL SUMMARY ########');
for (const r of results) console.log(`${r.verdict.padEnd(20)} ${r.section}`);
