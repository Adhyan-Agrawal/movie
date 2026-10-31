import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import nextEnv from '@next/env';

const { loadEnvConfig } = nextEnv;

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
const OPEN_NEXT_CLI = join(ROOT, 'node_modules', '@opennextjs', 'cloudflare', 'dist', 'cli', 'index.js');
const WRANGLER_CLI = join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const SAFE_ENV_FILE = join(ROOT, '.dev.vars.example');
const DRY_RUN = process.argv.slice(2).includes('--dry-run');
const REQUIRED = [
  'NEXT_PUBLIC_APP_NAME',
  'NEXT_PUBLIC_APP_URL',
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'TMDB_API_KEY',
  'TMDB_API_BASE_URL',
  'VIDNEST_API_URL',
  'VIDNEST_API_SECRET',
];
const RUNTIME_NAMES = [
  'NEXTJS_ENV',
  ...REQUIRED,
  'WYZIE_API_KEY',
  'WYZIE_SUBTITLE_TOKEN_SECRET',
  'VIDNEST_CDN_BASE_URL',
  'ADSTERRA_KEY_LEADERBOARD',
  'ADSTERRA_KEY_RECTANGLE',
  'ADSTERRA_KEY_PREROLL',
];
const AUTH_NAMES = ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN'];
const PUBLIC_BUILD_NAMES = [
  'NEXTJS_ENV',
  'NEXT_PUBLIC_APP_NAME',
  'NEXT_PUBLIC_APP_URL',
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
];

function invalidPublicHostname(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  return !host || isIP(host) !== 0 || host === 'localhost' || host.endsWith('.localhost')
    || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')
    || host.endsWith('.example') || host.endsWith('.invalid') || host.endsWith('.test');
}

function validateHttpsUrl(environment, name, { originOnly = false, path } = {}) {
  let url;
  try {
    url = new URL(environment[name]);
  } catch {
    throw new Error(`${name} must be a public HTTPS URL.`);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash
    || invalidPublicHostname(url.hostname)) {
    throw new Error(`${name} must be a public HTTPS URL without credentials or a fragment.`);
  }
  if (originOnly && (url.pathname !== '/' || url.search)) {
    throw new Error(`${name} must be an HTTPS origin without a path or query.`);
  }
  if (path !== undefined && (url.pathname !== path || url.search)) {
    throw new Error(`${name} must end exactly in ${path}.`);
  }
}

function validatedEnvironment() {
  const inherited = { ...process.env };
  const silent = { info() {}, error() {}, warn() {} };
  const { combinedEnv } = loadEnvConfig(ROOT, false, silent, true);
  const missing = REQUIRED.filter((name) => !combinedEnv[name]?.trim());
  if (missing.length) throw new Error(`Missing required deployment bindings: ${missing.join(', ')}`);

  for (const name of RUNTIME_NAMES) {
    if (combinedEnv[name] && /[\r\n\0]/.test(combinedEnv[name])) {
      throw new Error(`${name} must be a single-line value.`);
    }
  }
  if (combinedEnv.VIDNEST_API_SECRET.length < 32) {
    throw new Error('VIDNEST_API_SECRET must contain at least 32 characters.');
  }

  validateHttpsUrl(combinedEnv, 'NEXT_PUBLIC_APP_URL', { originOnly: true });
  validateHttpsUrl(combinedEnv, 'NEXT_PUBLIC_SUPABASE_URL', { originOnly: true });
  validateHttpsUrl(combinedEnv, 'TMDB_API_BASE_URL');
  validateHttpsUrl(combinedEnv, 'VIDNEST_API_URL', { originOnly: true });
  if (combinedEnv.VIDNEST_CDN_BASE_URL) {
    validateHttpsUrl(combinedEnv, 'VIDNEST_CDN_BASE_URL', { path: '/media' });
  }

  const bindings = Object.fromEntries(RUNTIME_NAMES.map((name) => [
    name,
    name === 'NEXTJS_ENV' ? combinedEnv[name] || 'production' : combinedEnv[name] ?? '',
  ]));
  const cleanEnvironment = { ...inherited };
  for (const name of [...RUNTIME_NAMES, ...AUTH_NAMES]) delete cleanEnvironment[name];
  const buildEnvironment = { ...cleanEnvironment };
  for (const name of RUNTIME_NAMES) buildEnvironment[name] = '';
  for (const name of PUBLIC_BUILD_NAMES) buildEnvironment[name] = bindings[name];
  buildEnvironment.TMDB_API_BASE_URL = bindings.TMDB_API_BASE_URL;
  buildEnvironment.VIDNEST_API_URL = bindings.VIDNEST_API_URL;
  const authEnvironment = { ...cleanEnvironment };
  for (const name of AUTH_NAMES) {
    if (inherited[name]) authEnvironment[name] = inherited[name];
  }
  return { authEnvironment, bindings, buildEnvironment };
}

function run(label, executable, args, environment) {
  console.log(`${label}...`);
  const result = spawnSync(process.execPath, [executable, ...args], {
    cwd: ROOT,
    env: environment,
    stdio: 'inherit',
  });
  if (result.error) throw new Error(`${label} failed to start.`);
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status ?? 'unknown'}.`);
}

function stageBindings(bindings) {
  const directory = mkdtempSync(join(tmpdir(), 'lumora-cloudflare-'));
  const path = join(directory, 'runtime-secrets.json');
  writeFileSync(path, JSON.stringify(bindings), { mode: 0o600, flag: 'wx' });
  chmodSync(path, 0o600);
  return { directory, path };
}

async function main() {
  const { authEnvironment, bindings, buildEnvironment } = validatedEnvironment();
  const wranglerBuildEnvironment = { ...buildEnvironment, OPEN_NEXT_DEPLOY: 'true' };
  const wranglerAuthEnvironment = { ...authEnvironment, OPEN_NEXT_DEPLOY: 'true' };
  run('Checking Cloudflare authentication', WRANGLER_CLI, [
    'whoami',
    '--env-file',
    SAFE_ENV_FILE,
  ], authEnvironment);
  run('Building the OpenNext Worker', OPEN_NEXT_CLI, ['build'], buildEnvironment);
  run('Validating the Worker upload', WRANGLER_CLI, [
    'deploy',
    '--dry-run',
    '--env-file',
    SAFE_ENV_FILE,
  ], wranglerBuildEnvironment);
  if (DRY_RUN) return;

  const staged = stageBindings(bindings);
  try {
    run('Deploying the Lumora Worker', WRANGLER_CLI, [
      'deploy',
      '--keep-vars',
      '--strict',
      '--secrets-file',
      staged.path,
      '--env-file',
      SAFE_ENV_FILE,
    ], wranglerAuthEnvironment);
  } finally {
    rmSync(staged.directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Cloudflare deployment failed.');
  process.exitCode = 1;
});
