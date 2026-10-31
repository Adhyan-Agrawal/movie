import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const WRANGLER_CONFIG = 'wrangler.jsonc';
const EDGE_PATH = '/media';
const AUTH_KEYS = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'];

function unquote(value, lineNumber) {
  if (!value.startsWith('"') && !value.startsWith("'")) return value.trim();
  const quote = value[0];
  if (!value.endsWith(quote) || value.length < 2) {
    throw new Error(`Invalid quoted value on .dev.vars line ${lineNumber}.`);
  }
  const inner = value.slice(1, -1);
  if (quote === "'") return inner;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`Invalid quoted value on .dev.vars line ${lineNumber}.`);
  }
}

export function parseDevVars(source) {
  const values = {};
  for (const [index, rawLine] of source.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const declaration = line.startsWith('export ') ? line.slice(7).trimStart() : line;
    const separator = declaration.indexOf('=');
    const name = separator >= 0 ? declaration.slice(0, separator).trim() : '';
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
      throw new Error(`Invalid variable name on .dev.vars line ${index + 1}.`);
    }
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

export function validateOrigin(value) {
  if (typeof value !== 'string' || !value || value !== value.trim() || /[\r\n\0]/.test(value)) {
    throw new Error('VIDNEST_ORIGIN_URL must be a public HTTPS origin.');
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('VIDNEST_ORIGIN_URL must be a public HTTPS origin.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || value.includes('?') || value.includes('#')
    || url.pathname !== '/' || privateOrReservedHostname(url.hostname)) {
    throw new Error('VIDNEST_ORIGIN_URL must be a public HTTPS origin without credentials, path, query, hash, or an IP literal.');
  }
  return url.origin;
}

export function validatePublicUrl(value) {
  if (typeof value !== 'string' || !value || value !== value.trim() || /[\r\n\0]/.test(value)) {
    throw new Error('VIDNEST_CDN_PUBLIC_URL must be a public HTTPS URL ending in /media.');
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('VIDNEST_CDN_PUBLIC_URL must be a public HTTPS URL ending in /media.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || url.pathname !== EDGE_PATH || privateOrReservedHostname(url.hostname)) {
    throw new Error('VIDNEST_CDN_PUBLIC_URL must be a public HTTPS URL ending exactly in /media.');
  }
  return url.href;
}

export function validateSecret(value) {
  if (typeof value !== 'string' || value.length < 32 || /[\r\n\0]/.test(value)) {
    throw new Error('VIDNEST_API_SECRET must be at least 32 characters and contain no line breaks.');
  }
  return value;
}

function valueFrom(environment, localValues, name) {
  return Object.hasOwn(environment, name) ? environment[name] : localValues[name];
}

export function deploymentConfig(environment = process.env, localSource = '') {
  const localValues = parseDevVars(localSource);
  const origin = validateOrigin(valueFrom(environment, localValues, 'VIDNEST_ORIGIN_URL'));
  const publicUrl = validatePublicUrl(valueFrom(environment, localValues, 'VIDNEST_CDN_PUBLIC_URL'));
  const secret = validateSecret(valueFrom(environment, localValues, 'VIDNEST_API_SECRET'));
  const accountId = valueFrom(environment, localValues, 'CLOUDFLARE_ACCOUNT_ID');
  if (accountId && !/^[a-f0-9]{32}$/i.test(accountId)) {
    throw new Error('CLOUDFLARE_ACCOUNT_ID must be a 32-character hexadecimal account ID.');
  }
  const auth = {};
  for (const name of AUTH_KEYS) {
    const value = environment[name];
    if (value) auth[name] = value;
  }
  return { auth, origin, publicUrl, secret };
}

export function deploymentSteps(origin, secretsFile) {
  return [
    {
      label: 'Checking Cloudflare authentication',
      args: ['whoami'],
    },
    {
      label: 'Atomically deploying Worker code and bindings',
      args: ['deploy', '--config', WRANGLER_CONFIG, '--strict', '--var', `VIDNEST_ORIGIN_URL:${origin}`,
        '--secrets-file', secretsFile],
    },
  ];
}

function wranglerCli() {
  const path = join(PACKAGE_ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  if (!existsSync(path)) throw new Error('Wrangler is not installed. Run npm ci in workers/vidnest-cdn first.');
  return path;
}

function runStep(step, environment) {
  console.log(`${step.label}...`);
  const options = {
    cwd: PACKAGE_ROOT,
    env: environment,
  };
  if (step.input === undefined) options.stdio = 'inherit';
  else {
    options.input = step.input;
    options.stdio = ['pipe', 'inherit', 'inherit'];
  }
  const result = spawnSync(process.execPath, [wranglerCli(), ...step.args], options);
  if (result.error) throw new Error(`${step.label} failed to start.`);
  if (result.status !== 0) throw new Error(`${step.label} failed with exit code ${result.status ?? 'unknown'}.`);
}

function stageSecret(secret) {
  const directory = mkdtempSync(join(tmpdir(), 'lumora-vidnest-cdn-'));
  const path = join(directory, 'worker-secrets.json');
  writeFileSync(path, JSON.stringify({ VIDNEST_API_SECRET: secret }), { mode: 0o600, flag: 'wx' });
  chmodSync(path, 0o600);
  return { directory, path };
}

async function fetchWithDeadline(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    return await fetch(url, { ...init, redirect: 'error', signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function verifyOrigin(origin) {
  const response = await fetchWithDeadline(`${origin}/api/vidnest?token=deployment-probe`);
  await response.body?.cancel();
  if (response.status !== 403) throw new Error('VIDNEST_ORIGIN_URL does not expose Lumora\'s protected /api/vidnest route.');
}

async function verifyDeployment(publicUrl) {
  let lastStatus;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const response = await fetchWithDeadline(publicUrl, { method: 'OPTIONS' });
      lastStatus = response.status;
      const cors = response.headers.get('access-control-allow-origin');
      await response.body?.cancel();
      if (response.status === 204 && cors === '*') return;
    } catch {
      // The workers.dev route can take a moment to propagate after deployment.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
  }
  throw new Error(`Deployed Worker failed its public /media probe${lastStatus ? ` (HTTP ${lastStatus})` : ''}.`);
}

export async function main() {
  const devVarsPath = join(PACKAGE_ROOT, '.dev.vars');
  const localSource = existsSync(devVarsPath) ? readFileSync(devVarsPath, 'utf8') : '';
  const config = deploymentConfig(process.env, localSource);
  const childEnvironment = { ...process.env, ...config.auth };
  delete childEnvironment.VIDNEST_API_SECRET;
  delete childEnvironment.VIDNEST_ORIGIN_URL;
  delete childEnvironment.VIDNEST_CDN_PUBLIC_URL;

  await verifyOrigin(config.origin);
  const staged = stageSecret(config.secret);
  try {
    for (const step of deploymentSteps(config.origin, staged.path)) runStep(step, childEnvironment);
  } finally {
    rmSync(staged.directory, { recursive: true, force: true });
  }
  await verifyDeployment(config.publicUrl);
  console.log(`Deployment complete and verified. Configure the application with VIDNEST_CDN_BASE_URL=${config.publicUrl}`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath && invokedPath === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : 'Worker deployment failed.';
    console.error(message);
    process.exitCode = 1;
  });
}
