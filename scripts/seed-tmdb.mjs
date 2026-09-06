// Seed the live catalog with REAL titles from TMDB (Spec Section 4/7).
//
// Fetches popular + top-rated movies and TV from TMDB, normalizes each into a
// `titles` row (real tmdb_id, imdb_id, poster/backdrop URLs, synopsis, genres,
// runtime, certification), and upserts into Supabase via the service role.
// Titles are published + public so anon RLS (title_is_public) can read them and
// the Vidsrc adapter can resolve playback from the real tmdb_id/imdb_id.
//
// Idempotent: upserts by natural keys (genre.slug, title.slug), so re-running
// refreshes rather than duplicating. Only PUBLIC metadata + poster URLs from
// TMDB are stored (allowed under TMDB terms with attribution); no provider
// media is fetched or embedded here.
//
// Usage:
//   node scripts/seed-tmdb.mjs            # ~40 movies + ~40 TV
//   node scripts/seed-tmdb.mjs --pages=3  # more pages (20 per page per type)
//
// Requires in .env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
// NEXT_PUBLIC_SUPABASE_ANON_KEY, TMDB_API_KEY (v3), TMDB_API_BASE_URL.

import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

// --- env ---
const raw = readFileSync('.env', 'utf8');
for (const l of raw.split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const tmdbKey = process.env.TMDB_API_KEY;
const tmdbBase = process.env.TMDB_API_BASE_URL || 'https://api.themoviedb.org/3';
if (!url || !serviceKey || !tmdbKey) {
  console.error('Need NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and TMDB_API_KEY in .env');
  process.exit(2);
}

const PAGES = Math.max(1, Number((process.argv.find((a) => a.startsWith('--pages=')) || '').split('=')[1] || 2));
const IMG = 'https://image.tmdb.org/t/p';
const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

// --- helpers ---
function slugify(s) {
  return String(s).toLowerCase().normalize('NFKD').replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}

async function tmdb(path, params = {}) {
  const u = new URL(`${tmdbBase}${path}`);
  u.searchParams.set('api_key', tmdbKey);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  const res = await fetch(u, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`TMDB ${path} -> HTTP ${res.status}`);
  return res.json();
}

// Map TMDB US certification to our maturity strings; default 'NR'.
function movieCert(release) {
  const us = (release?.results || []).find((r) => r.iso_3166_1 === 'US');
  const cert = us?.release_dates?.find((d) => d.certification)?.certification;
  return cert || 'NR';
}
function tvCert(ratings) {
  const us = (ratings?.results || []).find((r) => r.iso_3166_1 === 'US');
  return us?.rating || 'NR';
}

async function fetchGenreMap(kind) {
  const data = await tmdb(`/genre/${kind}/list`);
  return new Map((data.genres || []).map((g) => [g.id, g.name]));
}

// Build a normalized title record from a TMDB detail payload.
function normalizeMovie(d) {
  const year = d.release_date ? Number(d.release_date.slice(0, 4)) : null;
  return {
    type: 'movie',
    tmdb_id: d.id,
    imdb_id: d.imdb_id || d.external_ids?.imdb_id || null,
    slug: `${slugify(d.title)}-${d.id}`,
    name: d.title,
    original_name: d.original_title && d.original_title !== d.title ? d.original_title : null,
    synopsis: d.overview || '',
    release_year: year && year >= 1878 && year <= 2100 ? year : null,
    runtime_minutes: d.runtime || null,
    maturity: movieCert(d.release_dates),
    original_language: d.original_language || 'en',
    poster_url: d.poster_path ? `${IMG}/w500${d.poster_path}` : null,
    backdrop_url: d.backdrop_path ? `${IMG}/w1280${d.backdrop_path}` : null,
    editorial_score: typeof d.vote_average === 'number' ? Math.round(d.vote_average * 10) : null,
    genres: (d.genres || []).map((g) => g.name),
  };
}
function normalizeTv(d) {
  const year = d.first_air_date ? Number(d.first_air_date.slice(0, 4)) : null;
  const runtime = Array.isArray(d.episode_run_time) && d.episode_run_time.length ? d.episode_run_time[0] : null;
  return {
    type: 'tv',
    tmdb_id: d.id,
    imdb_id: d.external_ids?.imdb_id || null,
    slug: `${slugify(d.name)}-${d.id}`,
    name: d.name,
    original_name: d.original_name && d.original_name !== d.name ? d.original_name : null,
    synopsis: d.overview || '',
    release_year: year && year >= 1878 && year <= 2100 ? year : null,
    runtime_minutes: runtime,
    maturity: tvCert(d.content_ratings),
    original_language: d.original_language || 'en',
    poster_url: d.poster_path ? `${IMG}/w500${d.poster_path}` : null,
    backdrop_url: d.backdrop_path ? `${IMG}/w1280${d.backdrop_path}` : null,
    editorial_score: typeof d.vote_average === 'number' ? Math.round(d.vote_average * 10) : null,
    genres: (d.genres || []).map((g) => g.name),
  };
}

async function collectIds(kind, pages) {
  const ids = new Set();
  for (let p = 1; p <= pages; p++) {
    for (const list of ['popular', 'top_rated']) {
      const data = await tmdb(`/${kind}/${list}`, { page: p, language: 'en-US' });
      for (const r of data.results || []) ids.add(r.id);
    }
  }
  return [...ids];
}

async function main() {
  console.log(`TMDB base: ${tmdbBase} — fetching ${PAGES} page(s) of popular+top_rated per type.`);

  // 1. Collect ids, then fetch full details (with external_ids + certifications).
  const [movieIds, tvIds] = await Promise.all([collectIds('movie', PAGES), collectIds('tv', PAGES)]);
  console.log(`Discovered ${movieIds.length} movies, ${tvIds.length} TV ids. Fetching details...`);

  const titles = [];
  for (const id of movieIds) {
    try {
      const d = await tmdb(`/movie/${id}`, { append_to_response: 'release_dates,external_ids', language: 'en-US' });
      const n = normalizeMovie(d);
      if (n.name && n.synopsis) titles.push(n);
    } catch (e) { console.warn(`  movie ${id}: ${e.message}`); }
  }
  for (const id of tvIds) {
    try {
      const d = await tmdb(`/tv/${id}`, { append_to_response: 'content_ratings,external_ids', language: 'en-US' });
      const n = normalizeTv(d);
      if (n.name && n.synopsis) titles.push(n);
    } catch (e) { console.warn(`  tv ${id}: ${e.message}`); }
  }
  console.log(`Normalized ${titles.length} titles with synopsis.`);
  if (!titles.length) throw new Error('No titles fetched from TMDB — aborting so the catalog is not wiped.');

  // 2. Genres: upsert union by slug.
  const genreNames = [...new Set(titles.flatMap((t) => t.genres))].filter(Boolean).sort();
  const genreRows = genreNames.map((name) => ({ slug: slugify(name), name }));
  {
    const { error } = await db.from('genres').upsert(genreRows, { onConflict: 'slug' });
    if (error) throw new Error(`genres upsert: ${error.message}`);
  }
  const { data: genres, error: gSel } = await db.from('genres').select('id, slug');
  if (gSel) throw new Error(`genres select: ${gSel.message}`);
  const genreId = new Map(genres.map((g) => [g.slug, g.id]));
  console.log(`Genres: ${genreRows.length} upserted.`);

  // 3. Titles: upsert by slug, published + public. Feature the top 5 by score.
  const now = new Date().toISOString();
  const ranked = [...titles].sort((a, b) => (b.editorial_score ?? 0) - (a.editorial_score ?? 0));
  const featuredSlugs = new Set(ranked.slice(0, 5).map((t) => t.slug));
  const titleRows = titles.map((t) => ({
    type: t.type, tmdb_id: t.tmdb_id, imdb_id: t.imdb_id, slug: t.slug, name: t.name,
    original_name: t.original_name, synopsis: t.synopsis, release_year: t.release_year,
    runtime_minutes: t.runtime_minutes, maturity: t.maturity, original_language: t.original_language,
    poster_url: t.poster_url, backdrop_url: t.backdrop_url, editorial_score: t.editorial_score,
    status: 'published', visibility: 'public', featured: featuredSlugs.has(t.slug), published_at: now,
  }));
  {
    const { error } = await db.from('titles').upsert(titleRows, { onConflict: 'slug' });
    if (error) throw new Error(`titles upsert: ${error.message}`);
  }
  const { data: dbTitles, error: tSel } = await db.from('titles').select('id, slug');
  if (tSel) throw new Error(`titles select: ${tSel.message}`);
  const titleId = new Map(dbTitles.map((t) => [t.slug, t.id]));
  console.log(`Titles: ${titleRows.length} upserted (published + public, ${featuredSlugs.size} featured).`);

  // 4. title_genres join.
  const joinRows = [];
  for (const t of titles) {
    const tid = titleId.get(t.slug);
    if (!tid) continue;
    for (const gName of t.genres) {
      const gid = genreId.get(slugify(gName));
      if (gid) joinRows.push({ title_id: tid, genre_id: gid });
    }
  }
  {
    const { error } = await db.from('title_genres').upsert(joinRows, { onConflict: 'title_id,genre_id' });
    if (error) throw new Error(`title_genres upsert: ${error.message}`);
  }
  console.log(`title_genres: ${joinRows.length} links upserted.`);

  // 5. Verify anon (RLS) can read them.
  if (anonKey) {
    const anon = createClient(url, anonKey, { auth: { persistSession: false } });
    const { data: pub, error: pErr } = await anon.from('titles').select('slug').eq('visibility', 'public');
    if (pErr) throw new Error(`anon read: ${pErr.message}`);
    console.log(`\nAnon (RLS) sees ${pub.length} public titles.`);
  }
  console.log('\nReal TMDB catalog seed complete.');
}

main().catch((e) => { console.error('\nSeed failed:', e.message); process.exit(1); });
