import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import nextEnv from '@next/env';

export const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
export const PUBLIC_BUILD_NAMES = [
  'NEXT_PUBLIC_APP_NAME',
  'NEXT_PUBLIC_APP_URL',
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
];
export const AUTH_NAMES = ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN'];
const MODES = ['production', 'development', 'test'];
const SYSTEM_NAMES = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'OS',
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
  'TEMP', 'TMP', 'TMPDIR', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
  'CI', 'TERM', 'FORCE_COLOR', 'NO_COLOR', 'NEXT_TELEMETRY_DISABLED',
]);
const ENV_ERROR = 'Invalid generated OpenNext environment. Rebuild with cf:build.';

export function validateHttpsUrl(environment, name, { originOnly = false } = {}) {
  const value = environment[name];
  let url;
  try {
    if (typeof value !== 'string' || value !== value.trim() || /[\u0000-\u0020\u007f]/.test(value)) throw new Error();
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a public HTTPS URL.`);
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (url.protocol !== 'https:' || url.username || url.password || url.hash
    || !host || isIP(host) !== 0 || host === 'localhost' || host.endsWith('.localhost')
    || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')
    || host.endsWith('.example') || host.endsWith('.invalid') || host.endsWith('.test')) {
    throw new Error(`${name} must be a public HTTPS URL without credentials or a fragment.`);
  }
  if (originOnly && (url.pathname !== '/' || url.search)) {
    throw new Error(`${name} must be an HTTPS origin without a path or query.`);
  }
}

export function validateBuildConfiguration(environment) {
  for (const name of [...PUBLIC_BUILD_NAMES, 'WATCH_PARTY_WORKER_URL']) {
    const value = environment[name];
    if (value !== undefined && (typeof value !== 'string' || /[\r\n\0]/.test(value) || value !== value.trim())) {
      throw new Error(`${name} must be a single-line string without surrounding whitespace.`);
    }
  }
  if (!environment.NEXT_PUBLIC_APP_NAME) throw new Error('NEXT_PUBLIC_APP_NAME is required for a Cloudflare build.');
  validateHttpsUrl(environment, 'NEXT_PUBLIC_APP_URL', { originOnly: true });
  const hasSupabaseUrl = Boolean(environment.NEXT_PUBLIC_SUPABASE_URL);
  const anonKey = environment.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (hasSupabaseUrl !== Boolean(anonKey)) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be configured together or both left empty.');
  }
  if (hasSupabaseUrl) {
    validateHttpsUrl(environment, 'NEXT_PUBLIC_SUPABASE_URL', { originOnly: true });
    let role;
    try { role = JSON.parse(Buffer.from(anonKey.split('.')[1], 'base64url').toString('utf8')).role; } catch { /* Opaque publishable keys are also supported. */ }
    if (anonKey.startsWith('sb_secret_') || role === 'service_role' || anonKey === environment.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error('NEXT_PUBLIC_SUPABASE_ANON_KEY must not contain a private Supabase key.');
    }
  }
  // This nonsecret origin builds the WebSocket CSP, not another public env export.
  if (environment.WATCH_PARTY_WORKER_URL) validateHttpsUrl(environment, 'WATCH_PARTY_WORKER_URL', { originOnly: true });
}

export function loadCloudflareEnvironment(root = ROOT, inherited = { ...process.env }) {
  const saved = { ...process.env };
  try {
    process.env.NODE_ENV = 'production';
    const silent = { info() {}, error() {}, warn() {} };
    const { combinedEnv } = nextEnv.loadEnvConfig(root, false, silent, true);
    const localNames = new Set();
    const files = new Set(['.env', '.env.local', ...MODES.flatMap((mode) => [`.env.${mode}`, `.env.${mode}.local`])]);
    for (const file of files) {
      const path = join(root, file);
      if (!existsSync(path)) continue;
      // Collect names only, including modes Next is not currently building.
      for (const match of readFileSync(path, 'utf8').matchAll(/^\s*(?:export\s+)?([\w.-]+)\s*(?:=|:\s)/gm)) {
        localNames.add(match[1]);
      }
    }
    return { environment: { ...combinedEnv, ...inherited }, localNames };
  } catch {
    throw new Error('Unable to load the Cloudflare build environment.');
  } finally {
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
  }
}

export function createCommandEnvironment(inherited, { auth = false } = {}) {
  const environment = Object.fromEntries(Object.entries(inherited).filter(([name, value]) =>
    value !== undefined && (SYSTEM_NAMES.has(name.toUpperCase()) || (auth && AUTH_NAMES.includes(name)))));
  environment.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = 'false';
  environment.CLOUDFLARE_INCLUDE_PROCESS_ENV = 'false';
  return environment;
}

export function createBuildEnvironment(inherited, environment, localNames, runtimeNames = []) {
  validateBuildConfiguration(environment);
  const clean = createCommandEnvironment(inherited);
  // Empty, rather than absent, prevents Next's dotenv loader from restoring private values.
  for (const name of [...localNames, ...runtimeNames]) {
    if (!PUBLIC_BUILD_NAMES.includes(name)) clean[name] = '';
  }
  for (const name of AUTH_NAMES) clean[name] = '';
  for (const name of [...PUBLIC_BUILD_NAMES, 'WATCH_PARTY_WORKER_URL']) {
    clean[name] = environment[name] ?? '';
  }
  clean.NODE_ENV = 'production';
  clean.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = 'false';
  clean.CLOUDFLARE_INCLUDE_PROCESS_ENV = 'false';
  return clean;
}

export function sanitizeEnvModule(source, publicEnvironment) {
  try {
    const exports = /^export const (production|development|test) = (\{[^\r\n]*\});[ \t]*\r?$/gm;
    const matches = [...source.matchAll(exports)];
    if (matches.length !== MODES.length || new Set(matches.map((match) => match[1])).size !== MODES.length
      || source.replace(exports, '').trim()) throw new Error();
    const environments = Object.fromEntries(matches.map((match) => {
      const parsed = JSON.parse(match[2]);
      const values = {};
      for (const name of PUBLIC_BUILD_NAMES) {
        const value = publicEnvironment?.[name] ?? parsed[name];
        if (value === undefined) continue;
        if (typeof value !== 'string' || /[\r\n\0]/.test(value)) throw new Error();
        values[name] = value;
      }
      return [match[1], values];
    }));
    return MODES.map((mode) => `export const ${mode} = ${JSON.stringify(environments[mode])};\n`).join('');
  } catch {
    // Never evaluate generated code or include JSON/parser errors containing its values.
    throw new Error(ENV_ERROR);
  }
}

export function sanitizeGeneratedEnvironment(root = ROOT, publicEnvironment) {
  const path = join(root, '.open-next', 'cloudflare', 'next-env.mjs');
  try {
    const source = readFileSync(path, 'utf8');
    const sanitized = sanitizeEnvModule(source, publicEnvironment);
    if (source !== sanitized) writeFileSync(path, sanitized);
    if (readFileSync(path, 'utf8') !== sanitized) throw new Error();
  } catch {
    throw new Error(ENV_ERROR);
  }
}

export function validateBuiltEnvironment(root, environment) {
  let modes;
  try {
    const source = sanitizeEnvModule(readFileSync(join(root, '.open-next', 'cloudflare', 'next-env.mjs'), 'utf8'));
    modes = [...source.matchAll(/^export const \w+ = (.*);$/gm)].map((match) => JSON.parse(match[1]));
  } catch {
    throw new Error(ENV_ERROR);
  }
  const mismatched = PUBLIC_BUILD_NAMES.filter((name) => modes.some((mode) => (mode[name] ?? '') !== (environment[name] ?? '')));
  if (mismatched.length) {
    throw new Error(`Built public configuration differs from runtime bindings: ${mismatched.join(', ')}. Rebuild with cf:build; do not patch the generated environment.`);
  }
  if (environment.WATCH_PARTY_WORKER_URL) {
    try {
      // Read the manifest bundled by this project's OpenNext server, not a newer .next build.
      const manifest = JSON.parse(readFileSync(join(root, '.open-next', 'server-functions', 'default', '.next', 'routes-manifest.json'), 'utf8'));
      const rules = manifest.headers.filter((rule) => rule.source === '/((?!api/ad-frame).*)');
      const policies = rules.flatMap((rule) => rule.headers.filter((header) => header.key.toLowerCase() === 'content-security-policy'));
      if (rules.length !== 1 || policies.length !== 1) throw new Error();
      const connect = policies[0].value.split(';').map((directive) => directive.trim().split(/\s+/))
        .find((directive) => directive[0] === 'connect-src');
      const expected = `wss://${new URL(environment.WATCH_PARTY_WORKER_URL).host}`;
      if (!connect?.includes(expected)) throw new Error();
    } catch {
      throw new Error('Built Watch Party CSP does not match WATCH_PARTY_WORKER_URL. Rebuild with cf:build.');
    }
  }
}

export function runCloudflareCommand(label, executable, args, environment, root = ROOT) {
  // eslint-disable-next-line no-console
  console.log(`${label}...`);
  const result = spawnSync(process.execPath, [executable, ...args], {
    cwd: root, env: environment, stdio: 'inherit',
  });
  if (result.error) throw new Error(`${label} failed to start.`);
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status ?? 'unknown'}.`);
}

export function buildCloudflare({ root = ROOT, buildEnvironment, skipBuild = false, runCommand = runCloudflareCommand }) {
  if (!skipBuild) {
    try {
      runCommand('Building the OpenNext Worker', join(root, 'node_modules', '@opennextjs', 'cloudflare', 'dist', 'cli', 'index.js'),
        ['build'], buildEnvironment, root);
    } finally {
      // Even a failed build must not leave an uploadable private dotenv module behind.
      if (existsSync(join(root, '.open-next', 'cloudflare', 'next-env.mjs'))) {
        sanitizeGeneratedEnvironment(root, buildEnvironment);
      }
    }
  }
  if (!existsSync(join(root, '.open-next', 'worker.js'))) {
    throw new Error('No built OpenNext Worker exists. Run cf:build first.');
  }
  sanitizeGeneratedEnvironment(root, skipBuild ? undefined : buildEnvironment);
  if (!skipBuild) validateBuiltEnvironment(root, buildEnvironment);
}

export function cloudflareBuild(args = process.argv.slice(2), { root = ROOT, inherited = { ...process.env }, runCommand = runCloudflareCommand } = {}) {
  if (args.some((arg) => !['--preview', '--dry-run', '--skip-build'].includes(arg))
    || (args.includes('--preview') && args.includes('--dry-run'))) throw new Error('Invalid Cloudflare build options.');
  let buildEnvironment;
  if (args.includes('--skip-build')) {
    // An artifact-only check has no new configuration to load or inline.
    buildEnvironment = createCommandEnvironment(inherited);
    for (const name of AUTH_NAMES) buildEnvironment[name] = '';
  } else {
    const { environment, localNames } = loadCloudflareEnvironment(root, inherited);
    buildEnvironment = createBuildEnvironment(inherited, environment, localNames);
  }
  buildCloudflare({ root, buildEnvironment, skipBuild: args.includes('--skip-build'), runCommand });
  if (args.includes('--preview') || args.includes('--dry-run')) {
    const preview = args.includes('--preview');
    runCommand(preview ? 'Previewing the OpenNext Worker' : 'Validating the Worker upload',
      join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js'),
      [preview ? 'dev' : 'deploy', ...(preview ? [] : ['--dry-run']), '--env-file', join(root, '.dev.vars.example')],
      { ...buildEnvironment, OPEN_NEXT_DEPLOY: 'true' }, root);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    cloudflareBuild();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Cloudflare build failed.');
    process.exitCode = 1;
  }
}
