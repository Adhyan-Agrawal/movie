import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (name: string) => readFileSync(fileURLToPath(new URL(`../../${name}`, import.meta.url)), 'utf8');
const config = read('netlify.toml');
const manifest = JSON.parse(read('package.json'));
const documentation = read('README.md');
const example = Object.fromEntries(read('.env.example').split(/\r?\n/)
  .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
  .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));

describe('local Netlify hosting contract', () => {
  it('uses the standard Next build and adapter publish directory', () => {
    expect(config).toMatch(/^\[build\]\s*\n\s*command = "npm run build"\s*\n\s*publish = "\.next"/m);
    expect(manifest.scripts.build).toBe('next build');
    expect(config).toMatch(/^\[build.environment\]\s*\n\s*NODE_VERSION = "22"/m);
    expect(manifest.engines.node).toBe('>=22.12.0');
    expect(config).not.toMatch(/\.open-next|\[\[redirects\]\]|\[\[plugins\]\]/);
    expect(read('next.config.mjs')).not.toMatch(/output\s*:\s*['"]export['"]/);
  });

  it('opts into supported skew protection without pinning the automatic adapter', () => {
    expect(config).toContain('NETLIFY_NEXT_SKEW_PROTECTION = "true"');
    expect({ ...manifest.dependencies, ...manifest.devDependencies }).not.toHaveProperty('@netlify/plugin-nextjs');
    expect(documentation).toMatch(/not\s+arbitrary client `fetch` calls automatically/);
  });

  it('stores no domain or credential in Netlify configuration', () => {
    const assignments = [...config.matchAll(/^\s*([A-Z_a-z][A-Z_a-z0-9]*)\s*=/gm)].map((match) => match[1]);
    expect(assignments).toEqual(['command', 'publish', 'NODE_VERSION', 'NETLIFY_NEXT_SKEW_PROTECTION']);
    expect(config).not.toContain('.netlify.app');
    for (const name of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY',
      'TMDB_API_KEY', 'VIDNEST_API_SECRET', 'WATCH_PARTY_WORKER_URL', 'WATCH_PARTY_SECRET',
      'WYZIE_API_KEY', 'WYZIE_SUBTITLE_TOKEN_SECRET', 'ADSTERRA_KEY_LEADERBOARD', 'ADSTERRA_KEY_RECTANGLE', 'ADSTERRA_KEY_PREROLL']) {
      expect(example[name], name).toBe('');
    }
    expect(example.NEXT_PUBLIC_APP_URL).toBe('http://localhost:3000');
  });

  it('documents explicit application variable scopes and separate service prerequisites', () => {
    for (const value of ['Builds + Functions', 'Functions only', 'NEXT_PUBLIC_APP_URL', 'WATCH_PARTY_WORKER_URL',
      'WATCH_PARTY_SECRET', 'VIDNEST_API_SECRET', 'separate durable WebSocket service', 'confirmation emails']) {
      expect(documentation).toContain(value);
    }
    expect(documentation).toContain('a local Next build cannot certify sustained playback on Netlify');
  });

  it('keeps legacy Cloudflare release commands independent and manual-only', () => {
    const workflow = read('.github/workflows/deploy-lumora-cloudflare.yml');
    expect(workflow).toContain('Legacy Cloudflare release (manual only)');
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).not.toMatch(/^\s+(?:push|pull_request|schedule|workflow_call):/m);
    expect(manifest.scripts['cf:build']).toBe('node scripts/build-cloudflare.mjs');
    expect(manifest.scripts['cf:deploy']).toBe('node scripts/deploy-cloudflare.mjs');
    for (const hook of ['prebuild', 'postbuild', 'preinstall', 'postinstall']) {
      expect(manifest.scripts[hook] ?? '').not.toMatch(/cloudflare|wrangler|cf:/);
    }
  });

  it('ignores generated Netlify state and private environment files, not examples', () => {
    const ignore = read('.gitignore');
    expect(ignore).toMatch(/^\/\.netlify\/$/m);
    expect(ignore).toMatch(/^\.env\*$/m);
    expect(ignore).toMatch(/^!\.env.example$/m);
    expect(ignore).toMatch(/^\/\.next\/$/m);
  });
});
