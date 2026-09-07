import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
for (const l of readFileSync('.env','utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g,'');
}
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession:false } });
const count = async (t, f) => { let q = db.from(t).select('*', { count:'exact', head:true }); if (f) q = f(q); const { count:c, error } = await q; return error ? `ERR ${error.message}` : c; };
console.log('titles          ', await count('titles'));
console.log('  movies        ', await count('titles', q=>q.eq('type','movie')));
console.log('  tv            ', await count('titles', q=>q.eq('type','tv')));
console.log('  tv no imdb_id ', await count('titles', q=>q.eq('type','tv').is('imdb_id',null)));
console.log('  no tmdb_id    ', await count('titles', q=>q.is('tmdb_id',null)));
console.log('seasons         ', await count('seasons'));
console.log('episodes        ', await count('episodes'));
console.log('people          ', await count('people'));
console.log('title_people    ', await count('title_people'));
console.log('media_sources   ', await count('media_sources'));
console.log('watch_progress  ', await count('watch_progress'));
// TV titles with zero episodes
const { data: tv } = await db.from('titles').select('id, slug, tmdb_id, imdb_id').eq('type','tv').limit(2000);
let noSeason=0, noEp=0; const samples=[];
for (const t of tv ?? []) {
  const { count: sc } = await db.from('seasons').select('*',{count:'exact',head:true}).eq('title_id',t.id);
  const { count: ec } = await db.from('episodes').select('*',{count:'exact',head:true}).eq('title_id',t.id);
  if (!sc) noSeason++;
  if (!ec) { noEp++; if (samples.length<5) samples.push(`${t.slug} (tmdb ${t.tmdb_id}, imdb ${t.imdb_id ?? 'none'}, seasons ${sc})`); }
}
console.log(`\nTV titles scanned: ${tv?.length ?? 0}`);
console.log(`  with NO seasons rows : ${noSeason}`);
console.log(`  with NO episode rows : ${noEp}`);
console.log('  samples missing episodes:'); for (const s of samples) console.log('   -', s);
