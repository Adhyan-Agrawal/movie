import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
for (const l of readFileSync('.env','utf8').split(/\r?\n/)) { const m=/^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g,''); }
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth:{persistSession:false} });
// TV titles missing episodes entirely (rpc-free: read seasons with joined episodes count)
const { data: tv } = await db.from('titles').select('id, slug, tmdb_id, imdb_id').eq('type','tv');
const gap = [];
for (const t of tv ?? []) {
  const { count: ec } = await db.from('episodes').select('*',{count:'exact',head:true}).eq('title_id',t.id);
  if (!ec) gap.push(t);
  if (gap.length > 20) break; // just need a sample
}
console.log(`TV titles scanned: ${tv?.length ?? 0}`);
console.log(`TV with NO episode rows (sample): ${gap.length}+`);
for (const g of gap) console.log('  -', g.slug, 'tmdb='+g.tmdb_id, 'imdb='+(g.imdb_id??'none'));
// season-level: seasons whose episode_count says N but imported < N
const { data: seasons } = await db.from('seasons').select('id, title_id, season_number, episode_count').limit(3000);
let partial=0; const sSample=[];
for (const s of seasons ?? []) {
  if (s.episode_count == null) continue;
  const { count: ec } = await db.from('episodes').select('*',{count:'exact',head:true}).eq('season_id',s.id);
  if (ec < s.episode_count) { partial++; if (sSample.length<8) sSample.push(`s${s.season_number}: ${ec}/${s.episode_count}`); }
}
console.log(`\nSeasons scanned: ${seasons?.length ?? 0}`);
console.log(`Seasons with partial episode import: ${partial}`);
for (const s of sSample) console.log('  -', s);
