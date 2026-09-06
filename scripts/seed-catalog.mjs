// Seeds the live catalog (genres, titles, title_genres) from the app's mock
// catalog so the DB has real, publicly-visible rows and the app can read from
// Supabase end to end. Uses the service-role key: a trusted, server-side seed
// job is a legitimate RLS-bypass use (Spec Section 6/10). Idempotent: upserts
// by natural keys (genre.slug, title.slug), so re-running does not duplicate.
//
// This inserts ONLY the local sample catalog (gradient placeholder artwork,
// no third-party media URLs) — it does not fetch or embed any provider
// content, honoring the spec's provider-authorization rule.
//
// Usage: node scripts/seed-catalog.mjs

import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const raw = readFileSync('.env', 'utf8');
for (const l of raw.split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error('Need NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(2);
}

const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

// The 8 sample titles (mirrors src/features/catalog/mock-data.ts). Placeholder
// gradient artwork is generated in the UI from the slug; we store null artwork
// here rather than persisting CSS gradients as if they were image URLs.
const TITLES = [
  { slug: 'aurora-drift', type: 'movie', name: 'Aurora Drift', year: 2024, runtime: 128, maturity: 'PG-13', score: 88, featured: true, genres: ['Sci-Fi', 'Thriller'], synopsis: 'A deep-space salvage crew discovers a derelict vessel carrying a signal that predates the stars around it.' },
  { slug: 'the-lantern-district', type: 'tv', name: 'The Lantern District', year: 2023, runtime: 52, maturity: 'TV-MA', score: 92, featured: true, genres: ['Crime', 'Drama'], synopsis: 'In a rain-soaked port city, a retired detective is pulled back in by a case that mirrors her own past.' },
  { slug: 'meridian', type: 'movie', name: 'Meridian', year: 2025, runtime: 111, maturity: 'PG', score: 79, featured: false, genres: ['Adventure'], synopsis: 'Two rival cartographers race to map an uncharted coastline before a coming storm erases it.' },
  { slug: 'glasshouse', type: 'tv', name: 'Glasshouse', year: 2022, runtime: 45, maturity: 'TV-14', score: 74, featured: false, genres: ['Mystery', 'Drama'], synopsis: 'A botanist inherits a greenhouse that seems to remember everyone who has ever worked inside it.' },
  { slug: 'night-call', type: 'movie', name: 'Night Call', year: 2024, runtime: 96, maturity: 'R', score: 83, featured: false, genres: ['Thriller'], synopsis: 'A late-shift dispatcher becomes the only lifeline for a caller she cannot locate.' },
  { slug: 'emberfall', type: 'tv', name: 'Emberfall', year: 2025, runtime: 58, maturity: 'TV-14', score: 81, featured: false, genres: ['Fantasy', 'Adventure'], synopsis: 'Rival guilds vie for control of a city that runs entirely on captured light.' },
  { slug: 'tidewater', type: 'movie', name: 'Tidewater', year: 2023, runtime: 104, maturity: 'PG-13', score: 76, featured: false, genres: ['Drama', 'Mystery'], synopsis: 'A marine biologist returns to her flooded hometown and finds it stranger than she left it.' },
  { slug: 'signal-fire', type: 'tv', name: 'Signal Fire', year: 2024, runtime: 49, maturity: 'TV-MA', score: 87, featured: false, genres: ['Sci-Fi', 'Horror'], synopsis: 'A remote research station picks up a broadcast that should not exist.' },
];

function slugify(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }

async function main() {
  // 1. Genres (upsert by slug).
  const genreNames = [...new Set(TITLES.flatMap((t) => t.genres))].sort();
  const genreRows = genreNames.map((name) => ({ slug: slugify(name), name }));
  const { error: gErr } = await db.from('genres').upsert(genreRows, { onConflict: 'slug' });
  if (gErr) throw new Error(`genres upsert: ${gErr.message}`);
  const { data: genres, error: gSel } = await db.from('genres').select('id, slug');
  if (gSel) throw new Error(`genres select: ${gSel.message}`);
  const genreId = new Map(genres.map((g) => [g.slug, g.id]));
  console.log(`Genres: ${genreRows.length} upserted.`);

  // 2. Titles (upsert by slug), published + public so title_is_public() passes.
  const now = new Date().toISOString();
  const titleRows = TITLES.map((t) => ({
    type: t.type,
    slug: t.slug,
    name: t.name,
    synopsis: t.synopsis,
    release_year: t.year,
    runtime_minutes: t.runtime,
    maturity: t.maturity,
    status: 'published',
    visibility: 'public',
    featured: t.featured,
    editorial_score: t.score,
    published_at: now,
  }));
  const { error: tErr } = await db.from('titles').upsert(titleRows, { onConflict: 'slug' });
  if (tErr) throw new Error(`titles upsert: ${tErr.message}`);
  const { data: titles, error: tSel } = await db.from('titles').select('id, slug');
  if (tSel) throw new Error(`titles select: ${tSel.message}`);
  const titleId = new Map(titles.map((t) => [t.slug, t.id]));
  console.log(`Titles: ${titleRows.length} upserted (published + public).`);

  // 3. title_genres join (upsert by composite PK).
  const joinRows = [];
  for (const t of TITLES) {
    for (const gName of t.genres) {
      const tid = titleId.get(t.slug);
      const gid = genreId.get(slugify(gName));
      if (tid && gid) joinRows.push({ title_id: tid, genre_id: gid });
    }
  }
  const { error: jErr } = await db.from('title_genres').upsert(joinRows, { onConflict: 'title_id,genre_id' });
  if (jErr) throw new Error(`title_genres upsert: ${jErr.message}`);
  console.log(`title_genres: ${joinRows.length} links upserted.`);

  // 4. Verify anon can see them through RLS (title_is_public path).
  const anon = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const { data: pub, error: pErr } = await anon.from('titles').select('slug, name').eq('visibility', 'public');
  if (pErr) throw new Error(`anon read: ${pErr.message}`);
  console.log(`\nAnon (RLS) sees ${pub.length} published titles: ${pub.map((p) => p.slug).join(', ')}`);
  console.log('\nCatalog seed complete.');
}

main().catch((e) => { console.error('\nSeed failed:', e.message); process.exit(1); });
