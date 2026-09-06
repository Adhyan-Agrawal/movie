// Seed the ad_placements rows for the site's ad slots (Spec Section 11).
// Idempotent upsert by key. Zone keys themselves live in .env (see
// .env.example) — this only registers the placement inventory in the DB.
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const raw = readFileSync('.env', 'utf8');
for (const l of raw.split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) { console.error('Need NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY'); process.exit(2); }

const db = createClient(url, serviceKey, { auth: { persistSession: false } });

const PLACEMENTS = [
  { key: 'home-leaderboard', name: 'Home leaderboard', format: 'banner', position: 'home-below-fold' },
  { key: 'browse-leaderboard', name: 'Browse/Movies/TV leaderboard', format: 'banner', position: 'browse-below-fold' },
  { key: 'title-rectangle', name: 'Title detail rectangle', format: 'banner', position: 'title-below-fold' },
  { key: 'watch-preroll', name: 'Player pre-roll', format: 'preroll', position: 'player-preroll' },
  { key: 'watch-banner', name: 'Watch page banner', format: 'banner', position: 'watch-below-player' },
];

// Register the Adsterra provider row (enabled when any zone key is configured).
const adsterraEnabled = Boolean(
  process.env.ADSTERRA_KEY_LEADERBOARD || process.env.ADSTERRA_KEY_RECTANGLE || process.env.ADSTERRA_KEY_PREROLL,
);

const { error: pErr } = await db.from('ad_providers').upsert(
  {
    key: 'adsterra',
    name: 'Adsterra',
    enabled: adsterraEnabled,
    config: { formats: ['banner', 'preroll'], note: 'Zone keys live in server env (ADSTERRA_KEY_*).' },
  },
  { onConflict: 'key' },
);
if (pErr) { console.error('ad_providers upsert failed:', pErr.message); process.exit(1); }
console.log(`ad_providers: adsterra ${adsterraEnabled ? 'enabled' : 'registered (disabled — no zone keys)'}.`);

const { error: err } = await db.from('ad_placements').upsert(PLACEMENTS, { onConflict: 'key' });
if (err) { console.error('ad_placements upsert failed:', err.message); process.exit(1); }
console.log(`ad_placements: ${PLACEMENTS.length} slots upserted.`);

const { data: rows, error: vErr } = await db.from('ad_placements').select('key, enabled, format');
if (vErr) { console.error('verify failed:', vErr.message); process.exit(1); }
console.log('Current placements:', rows.map((r) => `${r.key}(${r.format}${r.enabled ? '' : ', disabled'})`).join(', '));
