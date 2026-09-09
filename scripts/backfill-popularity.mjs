// Backfill `titles.popularity` (migration 0009) from TMDB's mainstream lists.
//
// TMDB `popularity` is the ranking signal behind "trending" and the hero
// carousel. editorial_score alone floats obscure high-rated imports to the top;
// popularity surfaces recognizable hits. This walks /movie|/tv popular +
// top_rated (a few pages each), and updates popularity on titles we already
// hold. Titles never seen on those lists keep NULL popularity and sort last.
//
// Usage: node scripts/backfill-popularity.mjs [--pages 5]
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

for (const l of readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const pagesArg = process.argv.find((a) => a.startsWith('--pages='));
const PAGES = pagesArg ? Number(pagesArg.split('=')[1]) : 5;

const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const TMDB = process.env.TMDB_API_BASE_URL || 'https://api.themoviedb.org/3';
const KEY = process.env.TMDB_API_KEY;

async function tmdb(path, attempt = 1) {
  const u = new URL(TMDB + path);
  u.searchParams.set('api_key', KEY);
  u.searchParams.set('language', 'en-US');
  const r = await fetch(u, { signal: AbortSignal.timeout(15000) });
  if (!r.ok && (r.status === 429 || r.status >= 500) && attempt < 3) {
    await new Promise((x) => setTimeout(x, 500 * attempt));
    return tmdb(path, attempt + 1);
  }
  if (!r.ok) throw new Error(`TMDB ${path} → ${r.status}`);
  return r.json();
}

async function main() {
  // The tmdb_ids we already hold (page the select past Supabase's 1000 cap).
  const ours = new Set();
  for (const kind of ['movie', 'tv']) {
    for (let i = 0; ; i += 1000) {
      const { data, error } = await svc
        .from('titles')
        .select('tmdb_id')
        .eq('type', kind)
        .range(i, i + 999);
      if (error) throw new Error(error.message);
      for (const r of data ?? []) if (r.tmdb_id != null) ours.add(r.tmdb_id);
      if ((data ?? []).length < 1000) break;
    }
  }
  console.log(`catalog tmdb ids held: ${ours.size}`);

  // Gather (tmdb_id -> max popularity) from popular + top_rated lists.
  const pop = new Map();
  for (const kind of ['movie', 'tv']) {
    for (const list of ['popular', 'top_rated']) {
      for (let page = 1; page <= PAGES; page++) {
        const data = await tmdb(`/${kind}/${list}?page=${page}`).catch((e) => {
          console.warn(`skip ${kind}/${list} p${page}: ${e.message}`);
          return null;
        });
        for (const r of data?.results ?? []) {
          if (r.id != null && typeof r.popularity === 'number') {
            pop.set(r.id, Math.max(pop.get(r.id) ?? 0, r.popularity));
          }
        }
        await new Promise((x) => setTimeout(x, 200));
      }
    }
  }
  console.log(`popularity candidates from TMDB lists: ${pop.size}`);

  // Update only titles we hold. Batch by 100 (URL-length safe), one row each.
  let updated = 0;
  const rows = [...pop.entries()].filter(([id]) => ours.has(id));
  console.log(`matching our catalog: ${rows.length}`);
  for (let i = 0; i < rows.length; i += 100) {
    const batch = rows.slice(i, i + 100);
    await Promise.all(
      batch.map(async ([tmdbId, popularity]) => {
        const { error } = await svc.from('titles').update({ popularity }).eq('tmdb_id', tmdbId);
        if (!error) updated++;
      }),
    );
    if (i % 500 === 0) console.log(`  … ${Math.min(i + 100, rows.length)}/${rows.length}`);
    await new Promise((x) => setTimeout(x, 300));
  }
  console.log(`\nDONE: popularity set on ${updated}/${rows.length} titles`);
}

main().catch((e) => {
  console.error('FATAL', e.message);
  process.exit(1);
});
