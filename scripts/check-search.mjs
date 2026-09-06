// Quick check: the anon trigram ILIKE search path the server action uses.
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const raw = readFileSync('.env', 'utf8');
for (const l of raw.split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); }

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
for (const q of ['dark', 'breaking', 'knight', 'alien']) {
  const pattern = ['%', q, '%'].join('');
  const { data, error } = await db.from('titles').select('name, slug').ilike('name', pattern).eq('visibility', 'public');
  if (error) { console.log('ERR', error.message); process.exit(1); }
  console.log(`ILIKE "${pattern}" ->`, data.map((t) => t.name).join(', ') || '(none)');
}
