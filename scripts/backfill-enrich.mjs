// Backfill enrichment: import missing seasons/episodes/cast for every TV title
// whose episode count is below its seasons' expected total (the 1000-row select
// bug left every title past the first thousand with seasons but no episodes).
//
// Runs standalone against the Supabase service client + TMDB. Mirrors
// enrichTitleFromTmdb (src/features/catalog/tmdb-sync.ts) so results match the
// on-demand path, including the 'catalog.enrich' audit marker the app's
// cooldown reads (so viewers' pages won't re-enrich after this run).
//
// Usage: node scripts/backfill-enrich.mjs [--limit 200] [--dry-run]
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

for (const l of readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const DRY_RUN = process.argv.includes('--dry-run');
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const LIMIT = limitArg ? Number(limitArg.split('=')[1]) : Infinity;

const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const TMDB = process.env.TMDB_API_BASE_URL || 'https://api.themoviedb.org/3';
const KEY = process.env.TMDB_API_KEY;

const slugify = (s) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
const poster = (p) => (p ? `https://image.tmdb.org/t/p/w500${p}` : null);
const backdrop = (p) => (p ? `https://image.tmdb.org/t/p/w1280${p}` : null);
const profile = (p) => (p ? `https://image.tmdb.org/t/p/w185${p}` : null);

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

async function enrichOne(title) {
  const { data: row } = await svc.from('titles').select('id, tmdb_id').eq('id', title.id).maybeSingle();
  if (!row || row.tmdb_id == null) return { status: 'skip', reason: 'no tmdb id' };

  // Completeness gate (same as the app): episodes already meet expected.
  const { data: seasons } = await svc.from('seasons').select('season_number, episode_count').eq('title_id', row.id);
  const expected = (seasons ?? []).reduce((s, x) => s + (x.episode_count ?? 0), 0);
  const { count: actual } = await svc.from('episodes').select('*', { count: 'exact', head: true }).eq('title_id', row.id);
  if (expected > 0 && (actual ?? 0) >= expected) return { status: 'skip', reason: 'complete' };

  const detail = await tmdb(`/tv/${row.tmdb_id}`, {
    append_to_response: 'content_ratings,external_ids,credits,videos',
    language: 'en-US',
  });
  if (!detail || !detail.name || !detail.overview) return { status: 'skip', reason: 'bad detail' };

  if (DRY_RUN) return { status: 'would-import', episodes: 0 };

  const t = {
    type: 'tv',
    tmdb_id: detail.id,
    imdb_id: detail.external_ids?.imdb_id ?? null,
    slug: `${slugify(detail.name)}-${detail.id}`,
    name: detail.name,
    original_name: detail.original_name && detail.original_name !== detail.name ? detail.original_name : null,
    synopsis: detail.overview,
    release_year: detail.first_air_date ? Number(detail.first_air_date.slice(0, 4)) : null,
    runtime_minutes: detail.episode_run_time?.[0] ?? null,
    maturity: detail.content_ratings?.results?.find((r) => r.iso_3166_1 === 'US')?.rating ?? 'NR',
    original_language: detail.original_language,
    poster_url: poster(detail.poster_path),
    backdrop_url: backdrop(detail.backdrop_path),
    trailer_url: detail.videos?.results?.find((v) => v.type === 'Trailer' && v.site === 'YouTube')?.key
      ? `https://www.youtube.com/embed/${detail.videos.results.find((v) => v.type === 'Trailer' && v.site === 'YouTube').key}`
      : null,
    editorial_score: detail.vote_average ? Math.round(detail.vote_average * 10) : null,
    popularity: typeof detail.popularity === 'number' ? detail.popularity : null,
  };

  const { error: uErr } = await svc.from('titles').upsert(
    { ...t, status: 'published', visibility: 'public', published_at: new Date().toISOString() },
    { onConflict: 'slug' },
  );
  if (uErr) return { status: 'error', reason: `titles upsert: ${uErr.message}` };
  const { data: dbT } = await svc.from('titles').select('id').eq('slug', t.slug).maybeSingle();
  if (!dbT) return { status: 'error', reason: 'title id not found' };
  const titleId = dbT.id;

  // Seasons (season 0 = specials excluded).
  const seasonRows = (detail.seasons ?? [])
    .filter((s) => s.season_number > 0)
    .map((s) => ({
      title_id: titleId,
      season_number: s.season_number,
      name: s.name,
      overview: s.overview ?? '',
      air_date: s.air_date,
      poster_url: poster(s.poster_path),
      episode_count: s.episode_count,
    }));
  if (seasonRows.length) {
    const { error: seErr } = await svc.from('seasons').upsert(seasonRows, { onConflict: 'title_id,season_number' });
    if (seErr) return { status: 'error', reason: `seasons upsert: ${seErr.message}` };
  }
  const { data: dbSeasons } = await svc.from('seasons').select('id, season_number').eq('title_id', titleId);
  const seasonId = new Map((dbSeasons ?? []).map((s) => [s.season_number, s.id]));

  // Episodes, one TMDB call per season.
  let episodes = 0;
  for (const s of seasonRows) {
    const sd = await tmdb(`/tv/${row.tmdb_id}/season/${s.season_number}`, { language: 'en-US' }).catch(() => null);
    if (!sd?.episodes) continue;
    const sid = seasonId.get(s.season_number);
    if (!sid) continue;
    const rows = sd.episodes
      .filter((e) => e.episode_number > 0 && e.name)
      .map((e) => ({
        title_id: titleId,
        season_id: sid,
        season_number: s.season_number,
        episode_number: e.episode_number,
        name: e.name,
        overview: e.overview ?? '',
        air_date: e.air_date,
        runtime_minutes: e.runtime_minutes,
        still_url: e.still_path ? `https://image.tmdb.org/t/p/w400${e.still_path}` : null,
        tmdb_id: e.id,
      }));
    if (rows.length) {
      const { error: epErr } = await svc.from('episodes').upsert(rows, { onConflict: 'season_id,episode_number' });
      if (epErr) return { status: 'error', reason: `episodes upsert: ${epErr.message}` };
      episodes += rows.length;
    }
  }

  // Top-billed cast (match-then-insert, partial-index constraints).
  try {
    const cast = (detail.credits?.cast ?? []).filter((c) => c.name).slice(0, 20);
    const peopleByTmdb = new Map();
    for (const c of cast) if (c.id && c.name) peopleByTmdb.set(c.id, c);
    const personId = new Map();
    if (peopleByTmdb.size) {
      const ids = [...peopleByTmdb.keys()];
      for (let i = 0; i < ids.length; i += 100) {
        const part = ids.slice(i, i + 100);
        const { data: existing } = await svc.from('people').select('id, tmdb_id').in('tmdb_id', part);
        for (const p of existing ?? []) if (p.tmdb_id != null) personId.set(p.tmdb_id, p.id);
      }
      const missing = [...peopleByTmdb.values()].filter((c) => !personId.has(c.id));
      if (missing.length) {
        const { data: inserted } = await svc
          .from('people')
          .insert(missing.map((c) => ({ tmdb_id: c.id, name: c.name, profile_url: profile(c.profile_path) })))
          .select('id, tmdb_id');
        for (const p of inserted ?? []) if (p.tmdb_id != null) personId.set(p.tmdb_id, p.id);
      }
      const { data: existingCredits } = await svc
        .from('title_people')
        .select('person_id, character')
        .eq('title_id', titleId)
        .eq('credit_type', 'cast');
      const seen = new Set((existingCredits ?? []).map((c) => `${c.person_id}|${c.character ?? ''}`));
      const rows = cast.flatMap((c, i) => {
        const pid = personId.get(c.id);
        if (!pid) return [];
        const key = `${pid}|${c.character ?? ''}`;
        if (seen.has(key)) return [];
        seen.add(key);
        return [{ title_id: titleId, person_id: pid, credit_type: 'cast', character: c.character ?? null, credit_order: i }];
      });
      for (let i = 0; i < rows.length; i += 500) {
        await svc.from('title_people').insert(rows.slice(i, i + 500));
      }
    }
  } catch (e) {
    console.warn(`  cast import failed for ${row.tmdb_id}: ${e.message}`);
  }

  // audit marker so the app's cooldown respects this run.
  await svc.from('audit_logs').insert({
    action: 'catalog.enrich',
    entity_type: 'title',
    outcome: 'success',
    after: { title_id: titleId, episodes, reason: null },
  });
  return { status: 'ok', episodes };
}

async function main() {
  // Page through ALL TV titles (Supabase caps a bare select at 1,000 rows).
  const tv = [];
  for (let i = 0; ; i += 1000) {
    const { data, error } = await svc
      .from('titles')
      .select('id, slug')
      .eq('type', 'tv')
      .order('slug')
      .range(i, i + 999);
    if (error) throw new Error(error.message);
    tv.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }
  console.log(`TV titles: ${tv.length}`);

  // Per-title watchdog: a single slow/hung title (long TMDB retry chain under
  // a flaky network) must not stall the whole run.
  const withTimeout = (p, ms) =>
    Promise.race([
      p,
      new Promise((resolve) => setTimeout(() => resolve({ status: 'timeout', reason: 'watchdog' }), ms)),
    ]);
  let done = 0, imported = 0, skipped = 0, failed = 0, ep = 0;
  for (const title of tv ?? []) {
    if (done >= LIMIT) break;
    try {
      const r = await withTimeout(enrichOne(title), 120_000);
      done++;
      if (r.status === 'ok') { imported++; ep += r.episodes; console.log(`✓ ${title.slug} +${r.episodes}`); }
      else if (r.status === 'skip') { skipped++; }
      else if (r.status === 'timeout') { failed++; console.warn(`✗ ${title.slug} watchdog timeout`); }
      else { failed++; console.warn(`✗ ${title.slug} ${r.reason ?? r.status}`); }
    } catch (e) {
      failed++; done++;
      console.warn(`✗ ${title.slug} threw: ${e.message.slice(0, 120)}`);
    }
    if (done % 25 === 0) console.log(`  … ${done} done, ${imported} imported, ${skipped} skipped, ${failed} failed`);
    // Be gentle with TMDB between titles.
    await new Promise((x) => setTimeout(x, 250));
  }
  console.log(`\nDONE: processed=${done} imported=${imported} episodes=${ep} skipped=${skipped} failed=${failed}`);
}

main().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
