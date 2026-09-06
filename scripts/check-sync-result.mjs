// Post-sync verification: catalog size, artwork coverage, seasons, anon RLS read.
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const raw = readFileSync('.env', 'utf8');
for (const l of raw.split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const db = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const { count: total } = await db.from('titles').select('*', { count: 'exact', head: true });
const { count: withPoster } = await db.from('titles').select('*', { count: 'exact', head: true }).not('poster_url', 'is', null);
const { count: seasons } = await db.from('seasons').select('*', { count: 'exact', head: true });
const { count: genres } = await db.from('genres').select('*', { count: 'exact', head: true });
const { data: sample } = await db.from('titles').select('name, slug, poster_url, tmdb_id, imdb_id').not('poster_url', 'is', null).limit(4);

console.log(`titles: ${total} (with posters: ${withPoster})`);
console.log(`seasons: ${seasons}, genres: ${genres}`);
for (const t of sample ?? []) console.log(`  ${t.name}  tmdb=${t.tmdb_id} imdb=${t.imdb_id} poster=${t.poster_url?.slice(0, 60)}...`);

// Anon RLS read.
const anon = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
const { data: pub, error } = await anon.from('titles').select('name').eq('visibility', 'public');
console.log(`\nanon (RLS) sees ${pub?.length ?? 0} public titles ${error ? 'ERR: ' + error.message : ''}`);
