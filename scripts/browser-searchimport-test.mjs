// Browser test of search auto-import: search for a title NOT in the local
// catalog; the action should query TMDB, import it, and return it.
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright';

const raw = readFileSync('.env', 'utf8');
for (const l of raw.split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
const BASE = 'http://localhost:3100';
const QUERY = 'Whiplash';

// Confirm the query is not already in the catalog.
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data: pre } = await db.from('titles').select('name').ilike('name', `%${QUERY}%`);
console.log(`0. local matches before search: ${pre?.length ?? 0}`);
if ((pre?.length ?? 0) > 0) { console.log('   (already in catalog — pick a different query to test auto-import)'); }

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`${BASE}/search`, { waitUntil: 'networkidle' });

await page.fill('input[type="search"], input[name="q"], #search-input', QUERY);
// Wait for the debounced action + TMDB import + results.
await page.waitForTimeout(8000);
const body = await page.textContent('body');
const hasResults = body.includes(QUERY);
console.log(`1. searched "${QUERY}" -> results include "${QUERY}": ${hasResults ? '✓' : '✗'}`);

const { data: post } = await db.from('titles').select('name, tmdb_id, poster_url').ilike('name', `%${QUERY}%`).limit(3);
console.log(`2. auto-imported into catalog: ${post?.length ?? 0} rows`);
for (const t of post ?? []) console.log(`   ${t.name} tmdb=${t.tmdb_id} poster=${t.poster_url ? 'yes' : 'null'}`);

await browser.close();
