// Seed the live catalog with REAL, well-known movies and TV series — genuine
// names, years, runtimes, genres, synopses, and (critically) REAL tmdb_id +
// imdb_id values, which are what the Vidsrc/VSEmbed adapter uses to resolve
// playback. This replaces the fictional sample titles.
//
// Why a curated list instead of the TMDB API: api.themoviedb.org is unreachable
// from this environment (verified: other HTTPS hosts work, TMDB API times
// out). The metadata below is public, well-established reference data. Poster
// URLs are intentionally left null (the UI renders gradient placeholders) so we
// never point at a guessed/broken image URL.
//
// When run on a network that can reach TMDB, `node scripts/seed-tmdb.mjs`
// enriches these SAME rows (same slug convention: `<name>-<tmdbId>`) with
// official synopses, posters, and certifications, and adds more titles.
//
// Idempotent: upserts by natural keys. Fictional sample titles are deleted by
// slug on every run. Usage: node scripts/seed-real-titles.mjs

import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const raw = readFileSync('.env', 'utf8');
for (const l of raw.split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!url || !serviceKey) {
  console.error('Need NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(2);
}
const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

function slugify(s) {
  return String(s).toLowerCase().normalize('NFKD').replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}

// The fictional placeholder titles from the earlier sample seed — removed so
// the live catalog contains only real titles.
const FICTIONAL_SLUGS = [
  'aurora-drift', 'the-lantern-district', 'meridian', 'glasshouse',
  'night-call', 'emberfall', 'tidewater', 'signal-fire',
];

// Real titles. tmdb_id / imdb_id are the public reference identifiers used by
// the playback resolver. editorial_score approximates public ratings (x10).
const MOVIES = [
  { name: 'Inception', year: 2010, runtime: 148, maturity: 'PG-13', score: 88, tmdb: 27205, imdb: 'tt1375666', genres: ['Sci-Fi', 'Thriller', 'Action'], synopsis: 'A thief who steals corporate secrets through dream-sharing technology is given the inverse task: plant an idea in the mind of a CEO.' },
  { name: 'The Dark Knight', year: 2008, runtime: 152, maturity: 'PG-13', score: 90, tmdb: 155, imdb: 'tt0468569', genres: ['Action', 'Crime', 'Drama'], synopsis: 'Batman raises the stakes in his war on crime until a criminal mastermind known as the Joker plunges Gotham into anarchy.' },
  { name: 'Interstellar', year: 2014, runtime: 169, maturity: 'PG-13', score: 86, tmdb: 157336, imdb: 'tt0816692', genres: ['Sci-Fi', 'Drama', 'Adventure'], synopsis: 'With Earth becoming uninhabitable, a former pilot leads a mission through a wormhole to find humanity a new home.' },
  { name: 'The Matrix', year: 1999, runtime: 136, maturity: 'R', score: 84, tmdb: 603, imdb: 'tt0133093', genres: ['Sci-Fi', 'Action'], synopsis: 'A hacker discovers his reality is a simulation and joins a rebellion against the machines that built it.' },
  { name: 'Parasite', year: 2019, runtime: 132, maturity: 'R', score: 81, tmdb: 496243, imdb: 'tt6754393', genres: ['Thriller', 'Drama'], synopsis: 'A poor family schemes to become employed by a wealthy household by infiltrating their household staff — until a hidden secret upends both homes.' },
  { name: 'Dune', year: 2021, runtime: 155, maturity: 'PG-13', score: 82, tmdb: 438631, imdb: 'tt1160419', genres: ['Sci-Fi', 'Adventure'], synopsis: 'Paul Atreides travels to the desert planet Arrakis, where his family is drawn into a war over the most valuable substance in the galaxy.' },
  { name: 'Mad Max: Fury Road', year: 2015, runtime: 120, maturity: 'R', score: 81, tmdb: 76341, imdb: 'tt1392190', genres: ['Action', 'Adventure', 'Sci-Fi'], synopsis: 'In a post-apocalyptic wasteland, Max joins Furiosa in a desperate escape across the desert from a tyrant warlord.' },
  { name: 'Arrival', year: 2016, runtime: 116, maturity: 'PG-13', score: 78, tmdb: 329865, imdb: 'tt2582802', genres: ['Sci-Fi', 'Drama', 'Mystery'], synopsis: 'A linguist is recruited to communicate with alien visitors whose language reshapes how she experiences time itself.' },
  { name: 'Spirited Away', year: 2001, runtime: 125, maturity: 'PG', score: 86, tmdb: 129, imdb: 'tt0245429', genres: ['Animation', 'Fantasy', 'Adventure'], synopsis: 'A ten-year-old girl wanders into a world of spirits and must work in a bathhouse for the gods to free her parents and return home.' },
  { name: 'The Godfather', year: 1972, runtime: 175, maturity: 'R', score: 92, tmdb: 238, imdb: 'tt0068646', genres: ['Crime', 'Drama'], synopsis: 'The aging patriarch of an organized crime dynasty transfers control of his empire to his reluctant youngest son.' },
  { name: 'Oppenheimer', year: 2023, runtime: 181, maturity: 'R', score: 89, tmdb: 872585, imdb: 'tt15398776', genres: ['Drama', 'History'], synopsis: 'The story of J. Robert Oppenheimer, the physicist who led the Manhattan Project and grappled with the bomb he helped create.' },
  { name: 'Everything Everywhere All at Once', year: 2022, runtime: 139, maturity: 'R', score: 84, tmdb: 545611, imdb: 'tt6710474', genres: ['Action', 'Adventure', 'Sci-Fi'], synopsis: 'A laundromat owner discovers she must connect with versions of herself across the multiverse to stop a cosmic collapse.' },
];

const TV = [
  { name: 'Breaking Bad', year: 2008, runtime: 49, maturity: 'TV-MA', score: 95, tmdb: 1396, imdb: 'tt0903747', genres: ['Crime', 'Drama', 'Thriller'], synopsis: 'A terminally-ill chemistry teacher partners with a former student to manufacture methamphetamine, descending ever deeper into the drug trade.' },
  { name: 'Game of Thrones', year: 2011, runtime: 57, maturity: 'TV-MA', score: 88, tmdb: 1399, imdb: 'tt0944947', genres: ['Fantasy', 'Drama', 'Action'], synopsis: 'Noble families of Westeros wage war for the Iron Throne while an ancient threat stirs beyond the Wall in the north.' },
  { name: 'Stranger Things', year: 2016, runtime: 51, maturity: 'TV-14', score: 87, tmdb: 66737, imdb: 'tt4574334', genres: ['Sci-Fi', 'Horror', 'Drama'], synopsis: 'When a boy vanishes in 1980s Indiana, his friends and family uncover secret experiments, supernatural forces, and one strange girl.' },
  { name: 'The Last of Us', year: 2023, runtime: 55, maturity: 'TV-MA', score: 88, tmdb: 100088, imdb: 'tt3581920', genres: ['Sci-Fi', 'Drama'], synopsis: 'Twenty years after a fungal pandemic, a hardened smuggler escorts a teenage girl who may hold the key to saving what remains of humanity.' },
  { name: 'Chernobyl', year: 2019, runtime: 65, maturity: 'TV-MA', score: 93, tmdb: 87108, imdb: 'tt7366338', genres: ['Drama', 'History'], synopsis: 'The true story of the 1986 nuclear disaster and the people who sacrificed everything to contain the fallout and reveal the truth.' },
  { name: 'Better Call Saul', year: 2015, runtime: 46, maturity: 'TV-MA', score: 91, tmdb: 60059, imdb: 'tt3032476', genres: ['Crime', 'Drama'], synopsis: 'The trials of Jimmy McGill, a struggling lawyer in Albuquerque, as he transforms into criminal attorney Saul Goodman.' },
  { name: 'Dark', year: 2017, runtime: 55, maturity: 'TV-MA', score: 87, tmdb: 70514, imdb: 'tt5753856', genres: ['Sci-Fi', 'Mystery', 'Thriller'], synopsis: 'In a small German town, the disappearance of children exposes a time loop binding four families across generations.' },
  { name: 'The Boys', year: 2019, runtime: 60, maturity: 'TV-MA', score: 85, tmdb: 76479, imdb: 'tt1190634', genres: ['Action', 'Sci-Fi'], synopsis: 'A ragtag group of vigilantes takes on corrupt superheroes who abuse their celebrity and power behind a corporate veil.' },
  { name: 'Arcane', year: 2021, runtime: 42, maturity: 'TV-14', score: 91, tmdb: 94605, imdb: 'tt11126994', genres: ['Animation', 'Action', 'Fantasy'], synopsis: 'Two sisters end up on opposite sides of a brewing war between the gleaming city of Piltover and the underbelly of Zaun.' },
  { name: 'Severance', year: 2022, runtime: 48, maturity: 'TV-MA', score: 87, tmdb: 95396, imdb: 'tt11280740', genres: ['Sci-Fi', 'Thriller', 'Drama'], synopsis: 'Employees at Lumon Industries undergo a procedure that surgically divides their work and personal memories — until one of them starts asking why.' },
];

async function main() {
  // 1. Remove the fictional sample titles (and their genre links, via cascade).
  const { error: delErr } = await db.from('titles').delete().in('slug', FICTIONAL_SLUGS);
  if (delErr) throw new Error(`delete fictional titles: ${delErr.message}`);
  console.log(`Removed ${FICTIONAL_SLUGS.length} fictional placeholder titles.`);

  // 2. Genres (upsert by slug).
  const all = [...MOVIES, ...TV];
  const genreNames = [...new Set(all.flatMap((t) => t.genres))].sort();
  const genreRows = genreNames.map((name) => ({ slug: slugify(name), name }));
  {
    const { error } = await db.from('genres').upsert(genreRows, { onConflict: 'slug' });
    if (error) throw new Error(`genres upsert: ${error.message}`);
  }
  const { data: genres, error: gSel } = await db.from('genres').select('id, slug');
  if (gSel) throw new Error(`genres select: ${gSel.message}`);
  const genreId = new Map(genres.map((g) => [g.slug, g.id]));
  console.log(`Genres: ${genreRows.length} upserted.`);

  // 3. Titles — published + public, real external ids. Feature the top 5 by score.
  const now = new Date().toISOString();
  const rows = [
    ...MOVIES.map((t) => ({ t, type: 'movie' })),
    ...TV.map((t) => ({ t, type: 'tv' })),
  ].map(({ t, type }) => ({
    type,
    tmdb_id: t.tmdb,
    imdb_id: t.imdb,
    slug: `${slugify(t.name)}-${t.tmdb}`,
    name: t.name,
    synopsis: t.synopsis,
    release_year: t.year,
    runtime_minutes: t.runtime,
    maturity: t.maturity,
    status: 'published',
    visibility: 'public',
    featured: false,
    editorial_score: t.score,
    published_at: now,
  }));
  const featured = [...all].sort((a, b) => b.score - a.score).slice(0, 5)
    .map((t) => `${slugify(t.name)}-${t.tmdb}`);
  for (const r of rows) r.featured = featured.includes(r.slug);

  {
    const { error } = await db.from('titles').upsert(rows, { onConflict: 'slug' });
    if (error) throw new Error(`titles upsert: ${error.message}`);
  }
  const { data: titles, error: tSel } = await db.from('titles').select('id, slug');
  if (tSel) throw new Error(`titles select: ${tSel.message}`);
  const titleId = new Map(titles.map((t) => [t.slug, t.id]));
  console.log(`Titles: ${rows.length} upserted (published + public, ${featured.length} featured).`);

  // 4. title_genres join.
  const joinRows = [];
  for (const t of all) {
    const tid = titleId.get(`${slugify(t.name)}-${t.tmdb}`);
    if (!tid) continue;
    for (const g of t.genres) {
      const gid = genreId.get(slugify(g));
      if (gid) joinRows.push({ title_id: tid, genre_id: gid });
    }
  }
  {
    const { error } = await db.from('title_genres').upsert(joinRows, { onConflict: 'title_id,genre_id' });
    if (error) throw new Error(`title_genres upsert: ${error.message}`);
  }
  console.log(`title_genres: ${joinRows.length} links upserted.`);

  // 5. Verify anon (RLS) can read every public title, with ids intact.
  if (anonKey) {
    const anon = createClient(url, anonKey, { auth: { persistSession: false } });
    const { data: pub, error: pErr } = await anon.from('titles')
      .select('slug, name, type, tmdb_id, imdb_id').eq('visibility', 'public');
    if (pErr) throw new Error(`anon read: ${pErr.message}`);
    const withIds = pub.filter((p) => p.tmdb_id || p.imdb_id).length;
    console.log(`\nAnon (RLS) sees ${pub.length} public titles; ${withIds} carry playback ids.`);
    for (const p of pub.slice(0, 6)) console.log(`  ${p.type}  ${p.name}  tmdb=${p.tmdb_id ?? '-'}  imdb=${p.imdb_id ?? '-'}`);
    if (withIds === pub.length) console.log('All titles resolvable for playback. ✓');
  }
  console.log('\nReal catalog seed complete.');
}

main().catch((e) => { console.error('\nSeed failed:', e.message); process.exit(1); });
