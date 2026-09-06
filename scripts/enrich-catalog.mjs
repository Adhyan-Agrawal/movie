// Enrich the EXISTING catalog with cast + TV episodes from TMDB.
//
// The chart/discover sync already imported ~3,400 titles (plus `seasons` rows),
// but `people` / `title_people` / `episodes` were never populated — so title
// pages rendered honest "no episodes / no cast" states. This script walks the
// titles that are missing that data (most-popular first) and imports it with
// the SAME normalization rules as `src/features/catalog/tmdb-sync.ts`
// (top-billed cast only, first ~15, profile-path-or-Acting filter; episodes
// keyed by the DB season row).
//
// The full backlog (3,400 titles x ~1 detail + ~N season requests) is far too
// large for one run, so:
//   --limit=N    titles processed per run    (default 300)
//   --seasons=N  season fetches per run      (default 300)
// Re-running continues where the last run stopped (already-enriched titles are
// skipped), so the admin can top the catalog up incrementally.
//
// All writes are IDEMPOTENT:
//   - people:        match by tmdb_id, insert only missing (the unique index
//                    is partial, so onConflict can't express it)
//   - title_people:  match by (title, person, character), insert only missing
//                    (the dedup rule is an expression index)
//   - episodes:      upsert on (season_id, episode_number)
//   - seasons:       upsert on (title_id, season_number) — only as a fallback
//                    for titles whose seasons were never imported
//
// Usage (from the project root):
//   node scripts/enrich-catalog.mjs
//   node scripts/enrich-catalog.mjs --limit=200 --seasons=400
//
// Requires in .env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
// TMDB_API_KEY (v3), optionally TMDB_API_BASE_URL.

import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

// --- env (same pattern as scripts/seed-tmdb.mjs) ---
const raw = readFileSync('.env', 'utf8');
for (const l of raw.split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const tmdbKey = process.env.TMDB_API_KEY;
const tmdbBase = process.env.TMDB_API_BASE_URL || 'https://api.themoviedb.org/3';
if (!url || !serviceKey || !tmdbKey) {
  console.error('Need NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and TMDB_API_KEY in .env');
  process.exit(2);
}

function intArg(name, fallback) {
  const m = new RegExp(`^--${name}=(\\d+)$`).exec(process.argv.find((a) => a.startsWith(`--${name}=`)) || '');
  return Math.max(0, Number(m ? m[1] : fallback));
}
const LIMIT = intArg('limit', 300);
const SEASON_BUDGET = intArg('seasons', 300);
const MAX_CAST = 15; // mirrors MAX_CAST_MEMBERS in tmdb-normalize.ts
const CONCURRENCY = 4;

const IMG = 'https://image.tmdb.org/t/p';
const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

// --- helpers ---
const chunk = (arr, size) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

async function tmdb(path, params = {}) {
  const u = new URL(`${tmdbBase}${path}`);
  u.searchParams.set('api_key', tmdbKey);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  const res = await fetch(u, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`TMDB ${path} -> HTTP ${res.status}`);
  return res.json();
}

/** Paginate a select through Supabase's default 1,000-row page size. */
async function fetchAll(table, select, opts = {}) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    let q = db.from(table).select(select).range(from, from + 999);
    for (const [k, v] of Object.entries(opts)) q = q[k](...v);
    const { data, error } = await q;
    if (error) throw new Error(`${table} read: ${error.message}`);
    out.push(...data);
    if (data.length < 1000) return out;
  }
}

// Same rules as normalizeCast() in src/features/catalog/tmdb-normalize.ts.
function normalizeCast(credits) {
  return (credits?.cast || [])
    .filter((c) => c.id && c.name && (c.profile_path || c.known_for_department === 'Acting'))
    .slice(0, MAX_CAST)
    .map((c, i) => ({
      tmdbId: c.id,
      name: c.name,
      character: c.character || null,
      profileUrl: c.profile_path ? `${IMG}/w185${c.profile_path}` : null,
      knownFor: c.known_for_department || null,
      creditOrder: typeof c.order === 'number' && c.order >= 0 ? c.order : i,
    }));
}

// Same rules as normalizeEpisodes() in src/features/catalog/tmdb-normalize.ts.
function normalizeEpisodes(season) {
  return (season?.episodes || [])
    .filter((e) => e.id && e.episode_number > 0 && e.name)
    .map((e) => ({
      episodeNumber: e.episode_number,
      name: e.name,
      overview: e.overview || '',
      airDate: e.air_date || null,
      runtime: e.runtime || null,
      stillUrl: e.still_path ? `${IMG}/w300${e.still_path}` : null,
      tmdbId: e.id,
    }));
}

// --- one title's enrichment (all writes idempotent) ---
const totals = { titles: 0, people: 0, credits: 0, seasons: 0, episodes: 0, failed: 0 };
let seasonBudget = SEASON_BUDGET;
let skippedSeasons = 0;

// People inserts are serialized + memoized across the run: concurrent titles
// share cast members, and a bare select-then-insert would race on the
// people_tmdb_idx unique index. (An upsert can't express the partial index's
// WHERE clause, so match-then-insert under a mutex is the idempotent path.)
const knownPersonIds = new Map(); // tmdb id -> person row id, memoized per run
let peopleMutex = Promise.resolve();
function withPeopleMutex(fn) {
  const run = peopleMutex.then(fn);
  peopleMutex = run.then(
    () => {},
    () => {},
  );
  return run;
}

/** Resolve (inserting when missing) the person rows for one title's cast. */
async function ensurePeople(cast) {
  return withPeopleMutex(async () => {
    const unknown = [...new Set(cast.map((c) => c.tmdbId))].filter((id) => !knownPersonIds.has(id));
    for (const part of chunk(unknown, 100)) {
      const { data, error } = await db.from('people').select('id, tmdb_id').in('tmdb_id', part);
      if (error) throw new Error(`people read: ${error.message}`);
      for (const p of data || []) if (p.tmdb_id != null) knownPersonIds.set(p.tmdb_id, p.id);
    }
    // Dedupe by tmdb id: TMDB sometimes credits one actor twice (multiple
    // roles), and two rows with the same tmdb_id in one INSERT violate
    // people_tmdb_idx. The credit rows keep both roles (keyed by character).
    const missing = [
      ...new Map(
        cast.filter((c) => !knownPersonIds.has(c.tmdbId)).map((c) => [c.tmdbId, c]),
      ).values(),
    ];
    for (const part of chunk(missing, 500)) {
      const rows = part.map((c) => ({
        tmdb_id: c.tmdbId,
        name: c.name,
        known_for: c.knownFor,
        profile_url: c.profileUrl,
      }));
      const { data, error } = await db.from('people').insert(rows).select('id, tmdb_id');
      if (error) throw new Error(`people insert: ${error.message}`);
      for (const p of data || []) if (p.tmdb_id != null) knownPersonIds.set(p.tmdb_id, p.id);
      totals.people += part.length;
    }
    return new Map(cast.map((c) => [c.tmdbId, knownPersonIds.get(c.tmdbId)]));
  });
}

async function enrichCast(titleId, detail) {
  const cast = normalizeCast(detail.credits);
  if (!cast.length) return;

  const personId = await ensurePeople(cast);

  // title_people: match by (title, person, character), insert only missing.
  const existing = new Set();
  {
    const { data, error } = await db
      .from('title_people')
      .select('person_id, character')
      .eq('title_id', titleId)
      .eq('credit_type', 'cast');
    if (error) throw new Error(`title_people read: ${error.message}`);
    for (const c of data || []) existing.add(`${c.person_id}|${c.character ?? ''}`);
  }
  const seen = new Set();
  const rows = cast
    .filter((c) => {
      const pid = personId.get(c.tmdbId);
      if (!pid) return false;
      const key = `${pid}|${c.character ?? ''}`;
      if (existing.has(key) || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((c) => ({
      title_id: titleId,
      person_id: personId.get(c.tmdbId),
      credit_type: 'cast',
      character: c.character,
      credit_order: c.creditOrder,
    }));
  if (rows.length) {
    const { error } = await db.from('title_people').insert(rows);
    if (error) throw new Error(`title_people insert: ${error.message}`);
    totals.credits += rows.length;
  }
}

async function enrichEpisodes(title, detail) {
  // Resolve the DB season rows (season_number -> id). Titles imported before
  // the seasons sync may have none — upsert them as a fallback.
  let { data: seasons, error } = await db
    .from('seasons')
    .select('id, season_number')
    .eq('title_id', title.id);
  if (error) throw new Error(`seasons read: ${error.message}`);

  const tmdbSeasons = (detail.seasons || []).filter((s) => s.season_number > 0);
  if ((!seasons || seasons.length === 0) && tmdbSeasons.length) {
    const rows = tmdbSeasons.map((s) => ({
      title_id: title.id,
      season_number: s.season_number,
      name: s.name || null,
      overview: s.overview || '',
      air_date: s.air_date || null,
      poster_url: s.poster_path ? `${IMG}/w500${s.poster_path}` : null,
      episode_count: s.episode_count ?? null,
    }));
    const { error: upErr } = await db.from('seasons').upsert(rows, { onConflict: 'title_id,season_number' });
    if (upErr) throw new Error(`seasons upsert: ${upErr.message}`);
    totals.seasons += rows.length;
    ({ data: seasons, error } = await db
      .from('seasons')
      .select('id, season_number')
      .eq('title_id', title.id));
    if (error) throw new Error(`seasons read: ${error.message}`);
  }
  const seasonId = new Map((seasons || []).map((s) => [s.season_number, s.id]));

  const episodeRows = [];
  for (let i = 0; i < tmdbSeasons.length; i++) {
    const s = tmdbSeasons[i];
    if (seasonBudget <= 0) {
      skippedSeasons += tmdbSeasons.length - i;
      break;
    }
    seasonBudget--;
    let payload;
    try {
      payload = await tmdb(`/tv/${title.tmdb_id}/season/${s.season_number}`, { language: 'en-US' });
    } catch (e) {
      console.warn(`  ${title.name} season ${s.season_number}: ${e.message}`);
      continue;
    }
    const sid = seasonId.get(s.season_number);
    if (!sid) continue;
    for (const e of normalizeEpisodes(payload)) {
      episodeRows.push({
        title_id: title.id,
        season_id: sid,
        season_number: s.season_number,
        episode_number: e.episodeNumber,
        name: e.name,
        overview: e.overview,
        air_date: e.airDate,
        runtime_minutes: e.runtime,
        still_url: e.stillUrl,
        tmdb_id: e.tmdbId,
      });
    }
  }
  for (const part of chunk(episodeRows, 500)) {
    const { error: upErr } = await db.from('episodes').upsert(part, { onConflict: 'season_id,episode_number' });
    if (upErr) throw new Error(`episodes upsert: ${upErr.message}`);
  }
  totals.episodes += episodeRows.length;
}

async function enrichTitle(title, hasCast, hasEpisodes) {
  const needsCast = !hasCast.has(title.id);
  const needsEpisodes = title.type === 'tv' && !hasEpisodes.has(title.id);
  if (!needsCast && !needsEpisodes) return;

  const detail = await tmdb(`/${title.type}/${title.tmdb_id}`, {
    append_to_response: 'credits',
    language: 'en-US',
  });
  if (needsCast) await enrichCast(title.id, detail);
  if (needsEpisodes) await enrichEpisodes(title, detail);
  totals.titles++;
}

// --- main ---
async function main() {
  console.log(
    `Enriching up to ${LIMIT} titles (season budget ${SEASON_BUDGET}) from ${tmdbBase}.`,
  );

  const titles = (await fetchAll('titles', 'id, type, tmdb_id, slug, name, editorial_score', {
    not: ['tmdb_id', 'is', null],
    eq: ['status', 'published'],
    order: ['editorial_score', { ascending: false, nullsFirst: false }],
  })).filter((t) => t.type === 'movie' || t.type === 'tv');
  console.log(`Catalog: ${titles.length} published titles with a TMDB id.`);

  const [castRows, episodeRows] = await Promise.all([
    fetchAll('title_people', 'title_id', { eq: ['credit_type', 'cast'] }),
    fetchAll('episodes', 'title_id'),
  ]);
  const hasCast = new Set(castRows.map((r) => r.title_id));
  const hasEpisodes = new Set(episodeRows.map((r) => r.title_id));
  console.log(`Already enriched: ${hasCast.size} titles with cast, ${hasEpisodes.size} with episodes.`);

  const candidates = titles.filter(
    (t) => !hasCast.has(t.id) || (t.type === 'tv' && !hasEpisodes.has(t.id)),
  );
  const batch = candidates.slice(0, LIMIT);
  console.log(
    `${candidates.length} titles still need enrichment — processing the top ${batch.length} by score.`,
  );
  if (batch.length === 0) {
    console.log('Nothing to do — the catalog is fully enriched.');
    return;
  }

  let done = 0;
  for (const part of chunk(batch, CONCURRENCY)) {
    await Promise.all(
      part.map(async (t) => {
        try {
          await enrichTitle(t, hasCast, hasEpisodes);
        } catch (e) {
          totals.failed++;
          console.warn(`  ${t.name} (${t.type}/${t.tmdb_id}): ${e.message}`);
        }
      }),
    );
    done += part.length;
    if (done % 25 < CONCURRENCY || done === batch.length) {
      console.log(
        `  ${done}/${batch.length} titles — people +${totals.people}, credits +${totals.credits}, episodes +${totals.episodes}`,
      );
    }
  }

  console.log(
    `\nEnrichment complete: ${totals.titles} titles enriched, ` +
      `+${totals.people} people, +${totals.credits} cast credits, ` +
      `+${totals.seasons} seasons, +${totals.episodes} episodes, ${totals.failed} failed.`,
  );
  if (skippedSeasons > 0) {
    console.log(
      `Skipped ~${Math.round(skippedSeasons)} season fetches (budget exhausted) — re-run to continue.`,
    );
  }
  console.log(
    `${candidates.length - batch.length} titles still awaiting enrichment — re-run this script to continue.`,
  );
}

main().catch((e) => {
  console.error('\nEnrichment failed:', e.message);
  process.exit(1);
});
