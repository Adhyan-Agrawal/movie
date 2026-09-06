// Native-player E2E helper: add/remove a TEST remote media_sources row.
// Usage: node scripts/native-test-source.mjs add|remove
// Uses the service key from .env (same pattern as check-sync-result.mjs).
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const raw = readFileSync('.env', 'utf8');
for (const l of raw.split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// Public mux test stream — safe, well-known HLS asset.
const TEST_URL = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';
const TEST_LABEL = 'Test HLS';

const cmd = process.argv[2];
if (cmd === 'add') {
  const { data: title } = await db.from('titles').select('id, name').eq('slug', 'inception-27205').single();
  if (!title) { console.error('inception title not found'); process.exit(1); }
  const { data, error } = await db.from('media_sources').insert({
    title_id: title.id,
    kind: 'hls',
    url: TEST_URL,
    label: TEST_LABEL,
    priority: 500,
    enabled: true,
  }).select('id').single();
  if (error) { console.error('insert failed:', error.message); process.exit(1); }
  console.log(`inserted media_source ${data.id} for "${title.name}" (${title.id})`);
} else if (cmd === 'remove') {
  const { data, error } = await db.from('media_sources').delete().eq('url', TEST_URL).eq('label', TEST_LABEL).select('id');
  if (error) { console.error('delete failed:', error.message); process.exit(1); }
  console.log(`deleted ${data?.length ?? 0} test media_source row(s)`);
} else {
  console.error('usage: node scripts/native-test-source.mjs add|remove');
  process.exit(1);
}
