import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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
  const clean = createCommandEnvironment(inherited);
  // Empty, rather than absent, prevents Next's dotenv loader from restoring private values.
  for (const name of [...localNames, ...runtimeNames]) {
    if (!PUBLIC_BUILD_NAMES.includes(name)) clean[name] = '';
  }
  for (const name of AUTH_NAMES) clean[name] = '';
  for (const name of PUBLIC_BUILD_NAMES) {
    if (environment[name] !== undefined) clean[name] = environment[name];
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
}

export function cloudflareBuild(args = process.argv.slice(2), { root = ROOT, inherited = { ...process.env }, runCommand = runCloudflareCommand } = {}) {
  if (args.some((arg) => !['--preview', '--dry-run', '--skip-build'].includes(arg))
    || (args.includes('--preview') && args.includes('--dry-run'))) throw new Error('Invalid Cloudflare build options.');
  const { environment, localNames } = loadCloudflareEnvironment(root, inherited);
  const buildEnvironment = createBuildEnvironment(inherited, environment, localNames);
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
