// Backfill trailer URLs for existing titles from TMDB.
//
// Idempotent: only touches rows where `trailer_url IS NULL` (and tmdb_id is
// set), so re-running just picks up whatever is still missing — a flaky network
// mid-run is fine, the next run finishes the job. For each candidate it fetches
// the TMDB detail with `append_to_response=videos` (`/movie/{id}` or
// `/tv/{id}`), picks the best official YouTube Trailer, and stores it as a
// YouTube embed URL:
//
//   https://www.youtube.com/embed/{key}
//
// Runs standalone against the Supabase service client + TMDB, mirroring
// scripts/backfill-enrich.mjs (env loader, retry/backoff, pacing) so it stays
// gentle on TMDB rate limits.
//
// Usage: node scripts/backfill-trailers.mjs [--limit 200] [--dry-run]
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

for (const l of readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const DRY_RUN = process.argv.includes('--dry-run');
const LIMIT = (() => {
  const inline = process.argv.find((a) => a.startsWith('--limit='));
  const n = inline
    ? Number(inline.split('=')[1])
    : process.argv.includes('--limit')
      ? Number(process.argv[process.argv.indexOf('--limit') + 1])
      : NaN;
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : Infinity;
})();

const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const TMDB = process.env.TMDB_API_BASE_URL || 'https://api.themoviedb.org/3';
const KEY = process.env.TMDB_API_KEY;

if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY || !KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / TMDB_API_KEY in .env');
  process.exit(2);
}

/** Fetch a TMDB path with retry/backoff on 429 + 5xx (mirrors backfill-enrich). */
async function tmdb(path, params = {}, attempt = 1) {
  const u = new URL(TMDB + path);
  u.searchParams.set('api_key', KEY);
  for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
  const r = await fetch(u, { signal: AbortSignal.timeout(15000) });
  if (!r.ok && (r.status === 429 || r.status >= 500) && attempt < 3) {
    await new Promise((x) => setTimeout(x, 500 * attempt));
    return tmdb(path, params, attempt + 1);
  }
  if (!r.ok) throw new Error(`TMDB ${path} → ${r.status}`);
  return r.json();
}

/**
 * Pick the best trailer key from a `/videos` append payload: the first YouTube
 * Trailer marked official, falling back to the first YouTube Trailer of any
 * kind (matching src/features/catalog/tmdb-normalize.ts). Teaser-only results
 * are ignored — the backfill targets trailers.
 */
function pickTrailerKey(videos) {
  const results = (videos?.results ?? []).filter(
    (v) => v.site === 'YouTube' && typeof v.key === 'string' && v.key.length > 0,
  );
  const official = results.find((v) => v.type === 'Trailer' && v.official);
  return (official ?? results.find((v) => v.type === 'Trailer'))?.key ?? null;
}

/** Backfill one title. Returns a { status } summary for the progress log. */
async function backfillOne(title) {
  const kind = title.type === 'movie' ? 'movie' : title.type === 'tv' ? 'tv' : null;
  if (!kind || title.tmdb_id == null) return { status: 'skip', reason: 'no kind/tmdb id' };

  const detail = await tmdb(`/${kind}/${title.tmdb_id}`, {
    append_to_response: 'videos',
    language: 'en-US',
  });
  const key = pickTrailerKey(detail?.videos);
  if (!key) return { status: 'none' };

  if (DRY_RUN) return { status: 'would-update', key };

  const url = `https://www.youtube.com/embed/${key}`;
  const { error } = await svc.from('titles').update({ trailer_url: url }).eq('id', title.id);
  if (error) return { status: 'error', reason: error.message };
  return { status: 'ok', url };
}

async function main() {
  // Page through ALL candidate titles (Supabase caps a bare select at 1,000
  // rows). Order by id so the paging is stable across runs.
  const titles = [];
  for (let i = 0; ; i += 1000) {
    const { data, error } = await svc
      .from('titles')
      .select('id, type, tmdb_id, name')
      .is('trailer_url', null)
      .not('tmdb_id', 'is', null)
      .order('id')
      .range(i, i + 999);
    if (error) throw new Error(error.message);
    titles.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }
  console.log(`Titles missing a trailer: ${titles.length}${Number.isFinite(LIMIT) ? ` (limit ${LIMIT})` : ''}`);

  let done = 0, updated = 0, none = 0, skipped = 0, failed = 0;
  for (const title of titles) {
    if (done >= LIMIT) break;
    done++;
    try {
      const r = await backfillOne(title);
      if (r.status === 'ok') {
        updated++;
        console.log(`✓ ${title.name} → ${r.url}`);
      } else if (r.status === 'would-update') {
        updated++;
        console.log(`✓ ${title.name} → would set ${r.key}`);
      } else if (r.status === 'none') {
        none++;
      } else if (r.status === 'skip') {
        skipped++;
      } else {
        failed++;
        console.warn(`✗ ${title.name}: ${r.reason}`);
      }
    } catch (e) {
      failed++;
      console.warn(`✗ ${title.name} threw: ${e.message.slice(0, 160)}`);
    }
    if (done % 25 === 0) {
      console.log(`  … ${done} done, ${updated} updated, ${none} none, ${skipped} skipped, ${failed} failed`);
    }
    // Be gentle with TMDB between titles.
    await new Promise((x) => setTimeout(x, 200));
  }
  console.log(`\nDONE: processed=${done} updated=${updated} none=${none} skipped=${skipped} failed=${failed}`);
}

main().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
