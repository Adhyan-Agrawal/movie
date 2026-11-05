import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildCloudflare, createBuildEnvironment, createCommandEnvironment,
  loadCloudflareEnvironment, runCloudflareCommand, sanitizeGeneratedEnvironment,
} from './build-cloudflare.mjs';

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
const REQUIRED = [
  'NEXT_PUBLIC_APP_NAME',
  'NEXT_PUBLIC_APP_URL',
  'TMDB_API_KEY',
  'TMDB_API_BASE_URL',
  'VIDNEST_API_SECRET',
];
const RUNTIME_NAMES = [
  'NEXTJS_ENV',
  ...REQUIRED,
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'WYZIE_API_KEY',
  'WYZIE_SUBTITLE_TOKEN_SECRET',
  'WATCH_PARTY_SECRET',
  'WATCH_PARTY_WORKER_URL',
  'ADSTERRA_KEY_LEADERBOARD',
  'ADSTERRA_KEY_RECTANGLE',
  'ADSTERRA_KEY_PREROLL',
];

function invalidPublicHostname(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  return !host || isIP(host) !== 0 || host === 'localhost' || host.endsWith('.localhost')
    || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')
    || host.endsWith('.example') || host.endsWith('.invalid') || host.endsWith('.test');
}

function validateHttpsUrl(environment, name, { originOnly = false } = {}) {
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
}

function validatedEnvironment(root, inherited, secretsFile) {
  const { environment, localNames } = loadCloudflareEnvironment(root, inherited);
  let combinedEnv = environment;
  if (secretsFile) {
    try {
      const parsed = JSON.parse(readFileSync(resolve(root, secretsFile), 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      const names = RUNTIME_NAMES.filter((name) => Object.hasOwn(parsed, name));
      if (names.some((name) => typeof parsed[name] !== 'string')) throw new Error();
      combinedEnv = Object.fromEntries(names.map((name) => [name, parsed[name]]));
    } catch {
      throw new Error('Invalid runtime bindings JSON file.');
    }
  }
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
  const supabaseValues = ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'];
  const configuredSupabaseValues = supabaseValues.filter((name) => Boolean(combinedEnv[name]));
  if (configuredSupabaseValues.length !== 0 && configuredSupabaseValues.length !== supabaseValues.length) {
    throw new Error('All Supabase bindings must be configured together or all left empty.');
  }
  if (configuredSupabaseValues.length) validateHttpsUrl(combinedEnv, 'NEXT_PUBLIC_SUPABASE_URL', { originOnly: true });
  validateHttpsUrl(combinedEnv, 'TMDB_API_BASE_URL');
  const hasWatchPartySecret = Boolean(combinedEnv.WATCH_PARTY_SECRET);
  const hasWatchPartyUrl = Boolean(combinedEnv.WATCH_PARTY_WORKER_URL);
  if (hasWatchPartySecret !== hasWatchPartyUrl) throw new Error('WATCH_PARTY_SECRET and WATCH_PARTY_WORKER_URL must be configured together.');
  if (hasWatchPartySecret) {
    if (combinedEnv.WATCH_PARTY_SECRET.length < 32) throw new Error('WATCH_PARTY_SECRET must contain at least 32 characters.');
    validateHttpsUrl(combinedEnv, 'WATCH_PARTY_WORKER_URL', { originOnly: true });
  }

  const bindings = Object.fromEntries(RUNTIME_NAMES.map((name) => [
    name,
    name === 'NEXTJS_ENV' ? combinedEnv[name] || 'production' : combinedEnv[name] ?? '',
  ]));
  const buildEnvironment = createBuildEnvironment(inherited, bindings, localNames, RUNTIME_NAMES);
  const authEnvironment = createCommandEnvironment(inherited, { auth: true });
  return { authEnvironment, bindings, buildEnvironment };
}

function stageBindings(bindings) {
  const directory = mkdtempSync(join(tmpdir(), 'lumora-cloudflare-'));
  const path = join(directory, 'runtime-secrets.json');
  try {
    writeFileSync(path, JSON.stringify(bindings), { mode: 0o600, flag: 'wx' });
    chmodSync(path, 0o600);
    return { directory, path };
  } catch {
    rmSync(directory, { recursive: true, force: true });
    throw new Error('Unable to stage deployment bindings.');
  }
}

export async function deployCloudflare(args = process.argv.slice(2), {
  root = ROOT, inherited = { ...process.env }, runCommand = runCloudflareCommand,
} = {}) {
  let secretsFile;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (['--dry-run', '--skip-build', '--preserve-runtime'].includes(arg)) continue;
    const value = arg === '--secrets-file' ? args[++index]
      : arg.startsWith('--secrets-file=') ? arg.slice('--secrets-file='.length) : undefined;
    if (!value || value.startsWith('--') || secretsFile) throw new Error('Invalid Cloudflare deploy options.');
    secretsFile = value;
  }
  const dryRun = args.includes('--dry-run');
  const preserveRuntime = args.includes('--preserve-runtime');
  if (preserveRuntime && (!args.includes('--skip-build') || secretsFile)) {
    throw new Error('Runtime-preserving deploy requires --skip-build without --secrets-file.');
  }
  // A code-only release must not reload stale local secrets or re-enable disabled services.
  const { authEnvironment, bindings, buildEnvironment } = preserveRuntime
    ? { authEnvironment: createCommandEnvironment(inherited, { auth: true }), bindings: null, buildEnvironment: createCommandEnvironment(inherited) }
    : validatedEnvironment(root, inherited, secretsFile);
  const wranglerCli = join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  const safeEnvFile = join(root, '.dev.vars.example');
  const wranglerBuildEnvironment = { ...buildEnvironment, OPEN_NEXT_DEPLOY: 'true' };
  const wranglerAuthEnvironment = { ...authEnvironment, OPEN_NEXT_DEPLOY: 'true' };
  runCommand('Checking Cloudflare authentication', wranglerCli, [
    'whoami',
    '--env-file',
    safeEnvFile,
  ], authEnvironment, root);
  buildCloudflare({ root, buildEnvironment, skipBuild: args.includes('--skip-build'), runCommand });
  runCommand('Validating the Worker upload', wranglerCli, [
    'deploy',
    '--dry-run',
    '--env-file',
    safeEnvFile,
  ], wranglerBuildEnvironment, root);
  if (dryRun) return;

  const staged = bindings ? stageBindings(bindings) : null;
  try {
    sanitizeGeneratedEnvironment(root);
    runCommand('Deploying the Lumora Worker', wranglerCli, [
      'deploy',
      '--keep-vars',
      '--strict',
      ...(staged ? ['--secrets-file', staged.path] : []),
      '--env-file',
      safeEnvFile,
    ], wranglerAuthEnvironment, root);
  } finally {
    if (staged) rmSync(staged.directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  deployCloudflare().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Cloudflare deployment failed.');
    process.exitCode = 1;
  });
}
