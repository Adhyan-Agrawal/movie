// Backfill trailer URLs for existing titles from TMDB (`/videos` payloads).
// Idempotent: only touches titles whose trailer_url IS NULL. Re-runnable in
// batches (--limit, default 250). Usage: node scripts/backfill-trailers.mjs
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const raw = readFileSync('.env', 'utf8');
for (const l of raw.split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const tmdbKey = process.env.TMDB_API_KEY;
const tmdbBase = process.env.TMDB_API_BASE_URL || 'https://api.themoviedb.org/3';
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const LIMIT = Math.max(1, Number(limitArg?.split('=')[1] || 250));

if (!url || !serviceKey || !tmdbKey) { console.error('Need env keys.'); process.exit(2); }
const db = createClient(url, serviceKey, { auth: { persistSession: false } });

function pickTrailer(videos) {
  const results = (videos?.results ?? []).filter((v) => v.site === 'YouTube' && v.key);
  const byType = (type) => results.find((v) => v.type === type && v.official) ?? results.find((v) => v.type === type);
  const pick = byType('Trailer') ?? byType('Teaser');
  return pick ? `https://www.youtube.com/watch?v=${pick.key}` : null;
}

const { data: titles, error } = await db
  .from('titles')
  .select('id, type, tmdb_id, name')
  .is('trailer_url', null)
  .not('tmdb_id', 'is', null)
  .order('editorial_score', { ascending: false, nullsFirst: false })
  .limit(LIMIT);
if (error) { console.error('select failed:', error.message); process.exit(1); }
console.log(`Titles without trailer (this batch): ${titles.length}`);

let updated = 0, none = 0, failed = 0;
let done = 0;
const CONC = 8;
async function worker() {
  while (titles.length) {
    const t = titles.shift();
    if (!t) break;
    try {
      const res = await fetch(`${tmdbBase}/${t.type}/${t.tmdb_id}/videos?api_key=${tmdbKey}&language=en-US`, {
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const trailer = pickTrailer(data);
      if (trailer) {
        const { error: uErr } = await db.from('titles').update({ trailer_url: trailer }).eq('id', t.id);
        if (uErr) throw new Error(uErr.message);
        updated++;
      } else none++;
    } catch (e) {
      failed++;
      console.warn(`  ${t.name}: ${e.message}`);
    } finally { done++; }
  }
}
await Promise.all(Array.from({ length: CONC }, worker));
console.log(`Done: ${updated} trailers set, ${none} had no YouTube trailer, ${failed} failed.`);
