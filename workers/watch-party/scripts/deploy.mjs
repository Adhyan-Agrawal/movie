import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const AUTH_KEYS = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'];

function unquote(value, lineNumber) {
  if (!value.startsWith('"') && !value.startsWith("'")) return value.trim();
  const quote = value[0];
  if (!value.endsWith(quote) || value.length < 2) throw new Error(`Invalid quoted value on .dev.vars line ${lineNumber}.`);
  if (quote === "'") return value.slice(1, -1);
  try { return JSON.parse(value); } catch { throw new Error(`Invalid quoted value on .dev.vars line ${lineNumber}.`); }
}

export function parseDevVars(source) {
  const values = {};
  for (const [index, rawLine] of source.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const declaration = line.startsWith('export ') ? line.slice(7).trimStart() : line;
    const separator = declaration.indexOf('=');
    const name = separator >= 0 ? declaration.slice(0, separator).trim() : '';
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) throw new Error(`Invalid variable name on .dev.vars line ${index + 1}.`);
    if (Object.hasOwn(values, name)) throw new Error(`Duplicate ${name} in .dev.vars.`);
    values[name] = unquote(declaration.slice(separator + 1).trim(), index + 1);
  }
  return values;
}

function privateOrReservedHostname(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  return !host || isIP(host) !== 0 || host === 'localhost' || host.endsWith('.localhost')
    || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')
    || host.endsWith('.example') || host.endsWith('.invalid') || host.endsWith('.test');
}

function publicOrigin(value, name) {
  if (typeof value !== 'string' || !value || value !== value.trim() || /[\r\n\0]/.test(value)) {
    throw new Error(`${name} must be a public HTTPS origin.`);
  }
  let url;
  try { url = new URL(value); } catch { throw new Error(`${name} must be a public HTTPS origin.`); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/'
    || url.search || url.hash || privateOrReservedHostname(url.hostname)) {
    throw new Error(`${name} must be a public HTTPS origin without credentials, path, query, hash, or an IP literal.`);
  }
  return url.origin;
}

export function validateAllowedOrigins(value) {
  if (typeof value !== 'string') throw new Error('ALLOWED_ORIGINS must contain public HTTPS origins.');
  const origins = value.split(',').map((origin) => publicOrigin(origin.trim(), 'ALLOWED_ORIGINS'));
  if (!origins.length || new Set(origins).size !== origins.length) {
    throw new Error('ALLOWED_ORIGINS must contain unique public HTTPS origins.');
  }
  return origins.join(',');
}

export function validateSecret(value) {
  if (typeof value !== 'string' || value.length < 32 || /[\r\n\0]/.test(value)) {
    throw new Error('WATCH_PARTY_SECRET must be at least 32 characters and contain no line breaks.');
  }
  return value;
}

function valueFrom(environment, localValues, name) {
  return Object.hasOwn(environment, name) ? environment[name] : localValues[name];
}

export function deploymentConfig(environment = process.env, localSource = '') {
  const localValues = parseDevVars(localSource);
  const secret = validateSecret(valueFrom(environment, localValues, 'WATCH_PARTY_SECRET'));
  const allowedOrigins = validateAllowedOrigins(valueFrom(environment, localValues, 'ALLOWED_ORIGINS'));
  const publicUrl = publicOrigin(valueFrom(environment, localValues, 'WATCH_PARTY_PUBLIC_URL'), 'WATCH_PARTY_PUBLIC_URL');
  const accountId = valueFrom(environment, localValues, 'CLOUDFLARE_ACCOUNT_ID');
  if (accountId && !/^[a-f0-9]{32}$/i.test(accountId)) {
    throw new Error('CLOUDFLARE_ACCOUNT_ID must be a 32-character hexadecimal account ID.');
  }
  const auth = {};
  for (const name of AUTH_KEYS) if (environment[name]) auth[name] = environment[name];
  return { secret, allowedOrigins, publicUrl, auth };
}

export function deploymentSteps(allowedOrigins, secretsFile) {
  return [
    { label: 'Checking Cloudflare authentication', args: ['whoami'] },
    { label: 'Deploying Watch Party Worker and Durable Object', args: ['deploy', '--strict',
      '--var', `ALLOWED_ORIGINS:${allowedOrigins}`, '--secrets-file', secretsFile] },
  ];
}

function wranglerCli() {
  const path = join(PACKAGE_ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  if (!existsSync(path)) throw new Error('Wrangler is not installed. Run npm ci in workers/watch-party first.');
  return path;
}

function runStep(step, environment) {
  console.log(`${step.label}...`);
  const result = spawnSync(process.execPath, [wranglerCli(), ...step.args], {
    cwd: PACKAGE_ROOT,
    env: environment,
    stdio: 'inherit',
  });
  if (result.error) throw new Error(`${step.label} failed to start.`);
  if (result.status !== 0) throw new Error(`${step.label} failed with exit code ${result.status ?? 'unknown'}.`);
}

function stageSecret(secret) {
  const directory = mkdtempSync(join(tmpdir(), 'lumora-watch-party-'));
  const path = join(directory, 'worker-secrets.json');
  writeFileSync(path, JSON.stringify({ WATCH_PARTY_SECRET: secret }), { mode: 0o600, flag: 'wx' });
  chmodSync(path, 0o600);
  return { directory, path };
}

async function fetchWithDeadline(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try { return await fetch(url, { redirect: 'error', signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

async function verifyDeployment(publicUrl) {
  let lastStatus;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const response = await fetchWithDeadline(`${publicUrl}/healthz`);
      lastStatus = response.status;
      const body = await response.json();
      if (response.status === 200 && body?.ok === true && body?.protocol === 1) return;
    } catch {
      // A workers.dev route can take a moment to propagate.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
  }
  throw new Error(`Deployed Worker failed its health probe${lastStatus ? ` (HTTP ${lastStatus})` : ''}.`);
}

export async function main() {
  const devVarsPath = join(PACKAGE_ROOT, '.dev.vars');
  const localSource = existsSync(devVarsPath) ? readFileSync(devVarsPath, 'utf8') : '';
  const config = deploymentConfig(process.env, localSource);
  const childEnvironment = { ...process.env, ...config.auth };
  delete childEnvironment.WATCH_PARTY_SECRET;
  delete childEnvironment.ALLOWED_ORIGINS;
  delete childEnvironment.WATCH_PARTY_PUBLIC_URL;
  const staged = stageSecret(config.secret);
  try {
    for (const step of deploymentSteps(config.allowedOrigins, staged.path)) runStep(step, childEnvironment);
  } finally {
    rmSync(staged.directory, { recursive: true, force: true });
  }
  await verifyDeployment(config.publicUrl);
  console.log(`Deployment verified at ${config.publicUrl}.`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath && invokedPath === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Watch Party deployment failed.');
    process.exitCode = 1;
  });
}
