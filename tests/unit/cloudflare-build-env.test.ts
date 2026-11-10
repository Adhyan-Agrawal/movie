import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  buildCloudflare, cloudflareBuild, createBuildEnvironment, createCommandEnvironment,
  loadCloudflareEnvironment, PUBLIC_BUILD_NAMES, sanitizeEnvModule, sanitizeGeneratedEnvironment,
  validateBuiltEnvironment,
} from '../../scripts/build-cloudflare.mjs';
import { deployCloudflare, validateRuntimeBindings } from '../../scripts/deploy-cloudflare.mjs';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const modes = ['production', 'development', 'test'];
const publicValues = {
  NEXT_PUBLIC_APP_NAME: 'Build Fixture',
  NEXT_PUBLIC_APP_URL: 'https://app.fixture.dev',
  NEXT_PUBLIC_SUPABASE_URL: 'https://public.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'synthetic-public-anon-key',
};
// Synthetic fixtures only. Assertions report booleans, never environment contents.
const privateValue = 'synthetic-private-fixture-value';
const authValue = 'synthetic-auth-fixture-value';
const privateValues = {
  NEXTJS_ENV: 'production',
  TMDB_API_KEY: privateValue,
  TMDB_API_BASE_URL: 'https://api.themoviedb.org/3',
  VIDNEST_API_SECRET: 'synthetic-capability-fixture-key-at-least-32-characters',
  SUPABASE_SERVICE_ROLE_KEY: privateValue,
  DB_PASSWORD: privateValue,
  UNKNOWN_PRIVATE_BINDING: privateValue,
  NEXT_PUBLIC_UNKNOWN_KEY: privateValue,
  VIDNEST_API_URL: 'https://retired.fixture.dev',
  VIDNEST_CDN_BASE_URL: 'https://retired.fixture.dev/media',
  VIDNEST_ORIGIN_URL: 'https://retired.fixture.dev',
  VIDNEST_CDN_PUBLIC_URL: 'https://retired.fixture.dev/media',
};
const inherited = {
  NODE_ENV: 'production' as const,
  PATH: process.env.PATH ?? process.env.Path ?? '',
  SystemRoot: process.env.SystemRoot ?? '',
  CLOUDFLARE_API_TOKEN: authValue,
  CLOUDFLARE_ACCOUNT_ID: 'synthetic-account',
  UNLISTED_INHERITED_SECRET: privateValue,
  NODE_OPTIONS: '--env-file=.env',
};
const directories: string[] = [];
const generatedPath = (root: string) => join(root, '.open-next', 'cloudflare', 'next-env.mjs');
const generatedSource = (values: Record<string, string> = { ...publicValues, ...privateValues }) =>
  modes.map((mode) => `export const ${mode} = ${JSON.stringify(values)};\n`).join('');

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'lumora-cloudflare-env-test-'));
  directories.push(root);
  mkdirSync(join(root, '.open-next', 'cloudflare'), { recursive: true });
  writeFileSync(join(root, '.env'), Object.entries({ ...publicValues, ...privateValues,
    CLOUDFLARE_API_TOKEN: authValue,
  }).map(([name, value]) => `${name}=${value}`).join('\n'));
  writeFileSync(join(root, '.env.development.local'), `DEVELOPMENT_ONLY_SECRET=${privateValue}\n`);
  writeFileSync(join(root, '.env.test.local'), `TEST_ONLY_SECRET=${privateValue}\n`);
  writeFileSync(join(root, '.dev.vars.example'), 'NEXTJS_ENV=development\n');
  return root;
}

function emitBuild(root: string) {
  writeFileSync(join(root, '.open-next', 'worker.js'), 'export default {};\n');
  writeFileSync(generatedPath(root), generatedSource());
}

function emitPartyCsp(root: string, connectSource: string) {
  const directory = join(root, '.open-next', 'server-functions', 'default', '.next');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'routes-manifest.json'), JSON.stringify({ headers: [{
    source: '/((?!api/ad-frame).*)', headers: [{ key: 'Content-Security-Policy', value: `default-src 'self'; connect-src 'self' https: ${connectSource}` }],
  }] }));
}

function assertPublicModule(source: string) {
  expect(source.includes(privateValue)).toBe(false);
  expect(source.includes(authValue)).toBe(false);
  for (const name of Object.keys(privateValues)) expect(source.includes(`"${name}"`)).toBe(false);
  const lines = source.trim().split('\n');
  expect(lines.length).toBe(modes.length);
  for (const [index, mode] of modes.entries()) {
    const match = lines[index]?.match(new RegExp(`^export const ${mode} = (.*);$`));
    expect(Boolean(match)).toBe(true);
    const values = JSON.parse(match![1]!);
    expect(Object.keys(values)).toEqual(PUBLIC_BUILD_NAMES);
    for (const name of PUBLIC_BUILD_NAMES) expect(values[name] === publicValues[name as keyof typeof publicValues]).toBe(true);
  }
}

afterEach(() => {
  for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('Cloudflare build environment gate', () => {
  // Cold OpenNext/dotenvx imports can exceed 15s on Windows under concurrent builds.
  it('confirms the installed OpenNext generator includes arbitrary dotenv defaults independently of child env', async () => {
    const root = fixture();
    const packageJson = JSON.parse(readFileSync(join(projectRoot, 'node_modules', '@opennextjs', 'cloudflare', 'package.json'), 'utf8'));
    expect(packageJson.version).toBe('1.20.14');
    const compiler = await import(pathToFileURL(join(projectRoot, 'node_modules', '@opennextjs', 'cloudflare',
      'dist', 'cli', 'build', 'open-next', 'compile-env-files.js')).href);
    compiler.compileEnvFiles({ monorepoRoot: root, appPath: root, outputDir: join(root, '.open-next') });
    const source = readFileSync(generatedPath(root), 'utf8');
    expect(source.includes('"DB_PASSWORD"')).toBe(true);
    expect(source.includes('"VIDNEST_API_URL"')).toBe(true);
    expect(source.includes('"UNKNOWN_PRIVATE_BINDING"')).toBe(true);
    sanitizeGeneratedEnvironment(root);
    assertPublicModule(readFileSync(generatedPath(root), 'utf8'));
  }, 60_000);

  it('loads production public fields with normal local-file and inherited precedence without mutating the caller env', () => {
    const root = fixture();
    writeFileSync(join(root, '.env.production'), 'NEXT_PUBLIC_APP_NAME=Production Fixture\n');
    writeFileSync(join(root, '.env.local'), 'NEXT_PUBLIC_APP_NAME=Local Fixture\n');
    writeFileSync(join(root, '.env.production.local'), 'NEXT_PUBLIC_APP_NAME=Production Local Fixture\n');
    const before = { ...process.env };
    const loaded = loadCloudflareEnvironment(root, inherited);
    expect(loaded.environment.NEXT_PUBLIC_APP_NAME === 'Production Local Fixture').toBe(true);
    const override = loadCloudflareEnvironment(root, { ...inherited, NEXT_PUBLIC_APP_NAME: 'Inherited Fixture' });
    expect(override.environment.NEXT_PUBLIC_APP_NAME === 'Inherited Fixture').toBe(true);
    expect(JSON.stringify(process.env) === JSON.stringify(before)).toBe(true);
    expect(loaded.localNames.has('DEVELOPMENT_ONLY_SECRET')).toBe(true);
    expect(loaded.localNames.has('TEST_ONLY_SECRET')).toBe(true);
  });

  it('blanks every local private name, strips unrelated inherited values, and preserves only known public values', () => {
    const root = fixture();
    const { environment, localNames } = loadCloudflareEnvironment(root, inherited);
    const clean = createBuildEnvironment(inherited, environment, localNames);
    for (const name of [...Object.keys(privateValues), 'DEVELOPMENT_ONLY_SECRET', 'TEST_ONLY_SECRET', 'CLOUDFLARE_API_TOKEN']) {
      expect(clean[name] === '').toBe(true);
    }
    expect(clean.UNLISTED_INHERITED_SECRET === undefined).toBe(true);
    expect(clean.NODE_OPTIONS === undefined).toBe(true);
    expect(clean.NODE_ENV === 'production').toBe(true);
    expect(clean.PATH === inherited.PATH).toBe(true);
    expect(clean.SystemRoot === inherited.SystemRoot).toBe(true);
    for (const name of PUBLIC_BUILD_NAMES) expect(clean[name] === publicValues[name as keyof typeof publicValues]).toBe(true);
    const auth = createCommandEnvironment(inherited, { auth: true });
    expect(auth.CLOUDFLARE_API_TOKEN === authValue).toBe(true);
    expect(auth.UNLISTED_INHERITED_SECRET === undefined).toBe(true);
  });

  it('preserves each generated mode public field and explicit CI public overrides, but never a public-prefix wildcard', () => {
    assertPublicModule(sanitizeEnvModule(generatedSource()));
    const ci = { ...publicValues, NEXT_PUBLIC_APP_NAME: 'CI Fixture' };
    const source = sanitizeEnvModule(generatedSource(), ci);
    expect(source.includes(privateValue)).toBe(false);
    for (const line of source.trim().split('\n')) {
      const values = JSON.parse(line.slice(line.indexOf(' = ') + 3, -1));
      expect(Object.keys(values)).toEqual(PUBLIC_BUILD_NAMES);
      expect(values.NEXT_PUBLIC_APP_NAME === 'CI Fixture').toBe(true);
    }
    expect(sanitizeEnvModule(source)).toBe(source);
  });

  it.each([
    'export const production = {"UNKNOWN_PRIVATE_BINDING":"synthetic-private-fixture-value"};\n',
    generatedSource() + 'globalThis.generatedEnvWasExecuted = true;\n',
    generatedSource().replace('export const test', 'export const production'),
    generatedSource().replace('"NEXT_PUBLIC_APP_NAME":"Build Fixture"', '"NEXT_PUBLIC_APP_NAME":null'),
    'export const production = {"UNKNOWN_PRIVATE_BINDING":synthetic-private-fixture-value};\n',
  ])('rejects unexpected generated syntax or public types without evaluating it or reflecting any values', (source) => {
    let message = '';
    try { sanitizeEnvModule(source); } catch (error) { message = (error as Error).message; }
    expect(message === 'Invalid generated OpenNext environment. Rebuild with cf:build.').toBe(true);
    expect(message.includes(privateValue)).toBe(false);
    expect('generatedEnvWasExecuted' in globalThis).toBe(false);
  });

  const scripts = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')).scripts as Record<string, string>;
  const officialModes = ['cf:build', 'cf:preview', 'cf:dry-run', 'cf:dry-run:built',
    'cf:deploy', 'cf:deploy:validate', 'cf:deploy:built'];
  it.each(officialModes)('%s sanitizes before every build, preview, dry-run, and upload with public fields preserved', async (name) => {
    const root = fixture();
    const originalEnvFile = readFileSync(join(root, '.env'), 'utf8');
    const script = scripts[name]!;
    expect(/^node scripts\/(?:build|deploy)-cloudflare\.mjs(?: |$)/.test(script)).toBe(true);
    const args = script.split(' ').slice(2);
    if (args.includes('--skip-build')) emitBuild(root);
    const commands: string[] = [];
    let stagedPath = '';
    const runCommand = (_label: string, executable: string, commandArgs: string[], environment: Record<string, string>) => {
      const command = commandArgs[0]!;
      commands.push(command);
      const authenticated = command === 'whoami' || (command === 'deploy' && !commandArgs.includes('--dry-run'));
      expect(environment.CLOUDFLARE_API_TOKEN === (authenticated ? authValue : '')).toBe(true);
      expect(environment.UNLISTED_INHERITED_SECRET === undefined).toBe(true);
      expect(environment.NODE_OPTIONS === undefined).toBe(true);
      expect(Object.values(environment).includes(privateValue)).toBe(false);
      if (command === 'build') {
        expect(executable.includes('@opennextjs')).toBe(true);
        for (const key of Object.keys(privateValues)) expect(environment[key] === '').toBe(true);
        for (const key of PUBLIC_BUILD_NAMES) expect(environment[key] === publicValues[key as keyof typeof publicValues]).toBe(true);
        emitBuild(root);
      } else if (command !== 'whoami') {
        assertPublicModule(readFileSync(generatedPath(root), 'utf8'));
        expect(commandArgs.includes('--env-file')).toBe(true);
        expect(commandArgs[commandArgs.indexOf('--env-file') + 1] === join(root, '.dev.vars.example')).toBe(true);
        if (authenticated) {
          stagedPath = commandArgs[commandArgs.indexOf('--secrets-file') + 1]!;
          const keys = Object.keys(JSON.parse(readFileSync(stagedPath, 'utf8')));
          expect(keys.includes('VIDNEST_API_SECRET')).toBe(true);
          expect(keys.includes('DB_PASSWORD')).toBe(false);
          expect(keys.includes('VIDNEST_API_URL')).toBe(false);
          expect(keys.includes('UNKNOWN_PRIVATE_BINDING')).toBe(false);
        }
      }
    };
    if (script.includes('scripts/deploy-cloudflare.mjs')) await deployCloudflare(args, { root, inherited, runCommand });
    else cloudflareBuild(args, { root, inherited, runCommand });
    assertPublicModule(readFileSync(generatedPath(root), 'utf8'));
    expect(commands.includes('build')).toBe(!args.includes('--skip-build'));
    expect(readFileSync(join(root, '.env'), 'utf8') === originalEnvFile).toBe(true);
    if (stagedPath) expect(existsSync(stagedPath)).toBe(false);
  });

  it('sanitizes direct deploy --skip-build before validation and again immediately before uploading', async () => {
    const root = fixture();
    emitBuild(root);
    let uploaded = false;
    await deployCloudflare(['--skip-build'], { root, inherited, runCommand: (_label, _executable, args) => {
      expect(args[0] === 'build').toBe(false);
      if (args.includes('--dry-run')) {
        assertPublicModule(readFileSync(generatedPath(root), 'utf8'));
        writeFileSync(generatedPath(root), generatedSource());
      } else if (args[0] === 'deploy') {
        assertPublicModule(readFileSync(generatedPath(root), 'utf8'));
        uploaded = true;
      }
    } });
    expect(uploaded).toBe(true);
  });

  it('preserves existing runtime secrets for a guarded code-only release without loading local bindings', async () => {
    const root = fixture();
    emitBuild(root);
    writeFileSync(join(root, '.env'), `UNKNOWN_PRIVATE_BINDING=${privateValue}\n`);
    const commands: string[][] = [];
    await deployCloudflare(['--skip-build', '--preserve-runtime'], { root, inherited,
      runCommand: (_label, _executable, args, environment) => {
        commands.push(args);
        expect(Object.values(environment).includes(privateValue)).toBe(false);
        expect(environment.NODE_OPTIONS).toBeUndefined();
        expect(args.includes('--secrets-file')).toBe(false);
        if (args[0] === 'deploy') {
          assertPublicModule(readFileSync(generatedPath(root), 'utf8'));
          expect(args).toContain('--env-file');
          if (!args.includes('--dry-run')) {
            expect(args).toContain('--keep-vars');
            expect(args).toContain('--strict');
            expect(environment.CLOUDFLARE_API_TOKEN === authValue).toBe(true);
          }
        }
      },
    });
    expect(commands.map((args) => args[0])).toEqual(['whoami', 'deploy', 'deploy']);
    expect(commands[1]).toContain('--dry-run');
  });

  it('validates an existing artifact without requiring or loading new local public settings', () => {
    const root = fixture();
    emitBuild(root);
    writeFileSync(join(root, '.env'), 'NEXT_PUBLIC_APP_NAME=\nNEXT_PUBLIC_APP_URL=not-an-origin\n');
    let invoked = false;
    cloudflareBuild(['--dry-run', '--skip-build'], { root, inherited, runCommand: (_label, _executable, args, environment) => {
      expect(args).toContain('--dry-run');
      expect(environment.NEXT_PUBLIC_APP_URL).toBeUndefined();
      assertPublicModule(readFileSync(generatedPath(root), 'utf8'));
      invoked = true;
    } });
    expect(invoked).toBe(true);
  });

  it.each([
    ['--preserve-runtime'],
    ['--preserve-runtime', '--skip-build', '--secrets-file', 'runtime.json'],
    ['--preserve-runtime', '--skip-build', '--secrets-file=runtime.json'],
  ])('rejects an ambiguous runtime-preserving release before invoking any command', async (...args) => {
    let invoked = false;
    await expect(deployCloudflare(args, { root: fixture(), inherited, runCommand: () => { invoked = true; } }))
      .rejects.toThrow('Runtime-preserving deploy requires --skip-build without --secrets-file.');
    expect(invoked).toBe(false);
  });

  it.each(['joined', 'separate'])('keeps the existing CI secrets-file interface guarded and filtered (%s arguments)', async (style) => {
    const root = fixture();
    emitBuild(root);
    writeFileSync(join(root, '.env'), `UNKNOWN_PRIVATE_BINDING=${privateValue}\n`);
    const inputPath = join(root, 'ci-runtime.json');
    const input = JSON.stringify({ ...publicValues, ...privateValues, CLOUDFLARE_API_TOKEN: privateValue });
    writeFileSync(inputPath, input);
    let uploaded = false;
    let stagedPath = '';
    const fileArgs = style === 'joined' ? [`--secrets-file=${inputPath}`] : ['--secrets-file', inputPath];
    await deployCloudflare(['--skip-build', ...fileArgs], { root, inherited, runCommand: (_label, _executable, args, env) => {
      expect(args[0] === 'build').toBe(false);
      expect(Object.values(env).includes(privateValue)).toBe(false);
      if (args[0] === 'deploy') {
        assertPublicModule(readFileSync(generatedPath(root), 'utf8'));
        if (!args.includes('--dry-run')) {
          expect(env.CLOUDFLARE_API_TOKEN === authValue).toBe(true);
          stagedPath = args[args.indexOf('--secrets-file') + 1]!;
          expect(stagedPath === inputPath).toBe(false);
          const values = JSON.parse(readFileSync(stagedPath, 'utf8'));
          expect(values.VIDNEST_API_SECRET === privateValues.VIDNEST_API_SECRET).toBe(true);
          for (const name of ['DB_PASSWORD', 'UNKNOWN_PRIVATE_BINDING', 'VIDNEST_API_URL', 'VIDNEST_CDN_BASE_URL', 'CLOUDFLARE_API_TOKEN']) {
            expect(Object.hasOwn(values, name)).toBe(false);
          }
          uploaded = true;
        }
      }
    } });
    expect(uploaded).toBe(true);
    expect(existsSync(stagedPath)).toBe(false);
    expect(readFileSync(inputPath, 'utf8') === input).toBe(true);
  });

  it('redacts invalid runtime-file errors and refuses upload before authentication or build', async () => {
    const root = fixture();
    const path = join(root, 'ci-runtime.json');
    writeFileSync(path, `{"UNKNOWN_PRIVATE_BINDING":${privateValue}}`);
    let invoked = false;
    let message = '';
    try {
      await deployCloudflare(['--skip-build', `--secrets-file=${path}`], { root, inherited, runCommand: () => { invoked = true; } });
    } catch (error) { message = (error as Error).message; }
    expect(invoked).toBe(false);
    expect(message === 'Invalid runtime bindings JSON file.').toBe(true);
    expect(message.includes(privateValue)).toBe(false);
  });

  it.each([{ args: ['--secrets-file'] }, { args: ['--secrets-file='] }, { args: ['--unknown=synthetic-private-fixture-value'] }])(
    'rejects incomplete or unknown deploy flags without reflecting option values', async ({ args }) => {
      let invoked = false;
      let message = '';
      try {
        await deployCloudflare(args, { root: fixture(), inherited, runCommand: () => { invoked = true; } });
      } catch (error) { message = (error as Error).message; }
      expect(invoked).toBe(false);
      expect(message === 'Invalid Cloudflare deploy options.').toBe(true);
      expect(message.includes(privateValue)).toBe(false);
    });

  it('blocks stale malformed skip-build output before any upload and redacts parsing failures', async () => {
    const root = fixture();
    emitBuild(root);
    writeFileSync(generatedPath(root), generatedSource() + privateValue);
    let uploadAttempted = false;
    let message = '';
    try {
      await deployCloudflare(['--skip-build'], { root, inherited, runCommand: (_label, _executable, args) => {
        if (args[0] === 'deploy') uploadAttempted = true;
      } });
    } catch (error) { message = (error as Error).message; }
    expect(uploadAttempted).toBe(false);
    expect(message.includes(privateValue)).toBe(false);
    expect(message === 'Invalid generated OpenNext environment. Rebuild with cf:build.').toBe(true);
  });

  it('requires a built Worker and generated env module on all skip-build paths', () => {
    const root = fixture();
    expect(() => buildCloudflare({ root, buildEnvironment: {}, skipBuild: true })).toThrow('Run cf:build first.');
    writeFileSync(join(root, '.open-next', 'worker.js'), 'export default {};\n');
    expect(() => buildCloudflare({ root, buildEnvironment: {}, skipBuild: true })).toThrow('Invalid generated OpenNext environment.');
  });

  it('cleans generated private defaults even when the build fails before writing the Worker', () => {
    const root = fixture();
    expect(() => buildCloudflare({ root, buildEnvironment: publicValues, runCommand: () => {
      writeFileSync(generatedPath(root), generatedSource());
      throw new Error('Synthetic build failure.');
    } })).toThrow('Synthetic build failure.');
    assertPublicModule(readFileSync(generatedPath(root), 'utf8'));
  });
});

describe('Cloudflare feature configuration boundaries', () => {
  const configuration = { ...publicValues, ...privateValues };
  const party = { WATCH_PARTY_WORKER_URL: 'https://party.fixture.dev', WATCH_PARTY_SECRET: 'synthetic-party-signing-key-at-least-32-characters' };

  it('permits auth-only public Supabase configuration without granting service-role access', async () => {
    const root = fixture();
    emitBuild(root);
    const inputPath = join(root, 'auth-only.json');
    writeFileSync(inputPath, JSON.stringify({ ...configuration, SUPABASE_SERVICE_ROLE_KEY: '' }));
    let uploaded = false;
    await deployCloudflare(['--skip-build', '--secrets-file', inputPath], { root, inherited,
      runCommand: (_label, _executable, args) => {
        if (!args.includes('--secrets-file')) return;
        const bindings = JSON.parse(readFileSync(args[args.indexOf('--secrets-file') + 1]!, 'utf8'));
        expect(bindings.SUPABASE_SERVICE_ROLE_KEY === '').toBe(true);
        expect(bindings.NEXT_PUBLIC_SUPABASE_ANON_KEY === publicValues.NEXT_PUBLIC_SUPABASE_ANON_KEY).toBe(true);
        uploaded = true;
      },
    });
    expect(uploaded).toBe(true);
  });

  it('keeps auth and guest Watch Party independent and rejects half-configured services', () => {
    const noAuth = { ...configuration, NEXT_PUBLIC_SUPABASE_URL: '', NEXT_PUBLIC_SUPABASE_ANON_KEY: '', SUPABASE_SERVICE_ROLE_KEY: '' };
    expect(validateRuntimeBindings(noAuth).NEXT_PUBLIC_SUPABASE_URL === '').toBe(true);
    expect(validateRuntimeBindings({ ...noAuth, ...party }).WATCH_PARTY_SECRET === party.WATCH_PARTY_SECRET).toBe(true);
    expect(() => validateRuntimeBindings({ ...configuration, NEXT_PUBLIC_SUPABASE_ANON_KEY: '' })).toThrow('configured together');
    expect(() => validateRuntimeBindings({ ...configuration, NEXT_PUBLIC_SUPABASE_URL: '' })).toThrow('configured together');
    expect(() => validateRuntimeBindings({ ...noAuth, SUPABASE_SERVICE_ROLE_KEY: privateValue })).toThrow('requires the public Supabase');
    expect(() => validateRuntimeBindings({ ...configuration, WATCH_PARTY_SECRET: party.WATCH_PARTY_SECRET })).toThrow('configured together');
    expect(() => validateRuntimeBindings({ ...configuration, WATCH_PARTY_WORKER_URL: party.WATCH_PARTY_WORKER_URL })).toThrow('configured together');
  });

  it('accepts public anon JWTs and publishable keys while defaulting only the runtime mode', () => {
    for (const key of ['sb_publishable_synthetic_fixture',
      `eyJhbGciOiJIUzI1NiJ9.${Buffer.from('{"role":"anon"}').toString('base64url')}.synthetic`]) {
      const bindings = validateRuntimeBindings({ ...configuration, NEXTJS_ENV: '', NEXT_PUBLIC_SUPABASE_ANON_KEY: key });
      expect(bindings.NEXT_PUBLIC_SUPABASE_ANON_KEY === key).toBe(true);
      expect(bindings.NEXTJS_ENV === 'production').toBe(true);
      expect(Object.hasOwn(bindings, 'UNKNOWN_PRIVATE_BINDING')).toBe(false);
    }
  });

  it.each([
    ['private key prefix', 'sb_secret_synthetic_fixture'],
    ['privileged JWT', `eyJhbGciOiJIUzI1NiJ9.${Buffer.from('{"role":"service_role"}').toString('base64url')}.synthetic`],
    ['same private key', privateValue],
  ])('rejects a %s in the public Supabase field before building or uploading', async (_label, key) => {
    const values = { ...configuration, NEXT_PUBLIC_SUPABASE_ANON_KEY: key };
    expect(() => createBuildEnvironment(inherited, values, new Set())).toThrow('must not contain a private Supabase key');
    const root = fixture();
    const path = join(root, 'private-key.json');
    writeFileSync(path, JSON.stringify(values));
    let invoked = false;
    let message = '';
    try { await deployCloudflare(['--secrets-file', path], { root, inherited, runCommand: () => { invoked = true; } }); }
    catch (error) { message = (error as Error).message; }
    expect(invoked).toBe(false);
    expect(message.includes(key)).toBe(false);
  });

  it.each([
    ['insecure app URL', { NEXT_PUBLIC_APP_URL: 'http://app.fixture.dev' }],
    ['private IP', { NEXT_PUBLIC_APP_URL: 'https://127.0.0.1' }],
    ['local host', { NEXT_PUBLIC_APP_URL: 'https://localhost' }],
    ['reserved host', { NEXT_PUBLIC_APP_URL: 'https://app.invalid' }],
    ['credentials', { NEXT_PUBLIC_APP_URL: `https://viewer:${privateValue}@app.fixture.dev` }],
    ['fragment', { NEXT_PUBLIC_APP_URL: `https://app.fixture.dev/#${privateValue}` }],
    ['non-origin app URL', { NEXT_PUBLIC_APP_URL: 'https://app.fixture.dev/private' }],
    ['invalid provider URL', { TMDB_API_BASE_URL: privateValue }],
    ['insecure provider URL', { TMDB_API_BASE_URL: 'http://api.fixture.dev/3' }],
    ['app whitespace', { NEXT_PUBLIC_APP_URL: ' https://app.fixture.dev' }],
    ['embedded URL tab', { NEXT_PUBLIC_APP_URL: 'https://app.\tfixture.dev' }],
    ['empty required key', { TMDB_API_KEY: '' }],
    ['secret whitespace', { VIDNEST_API_SECRET: ' '.repeat(40) }],
    ['short signing key', { VIDNEST_API_SECRET: 'short' }],
    ['secret newline', { VIDNEST_API_SECRET: `${privateValue}\n` }],
    ['runtime test mode', { NEXTJS_ENV: 'test' }],
    ['runtime development mode', { NEXTJS_ENV: 'development' }],
    ['party path', { ...party, WATCH_PARTY_WORKER_URL: 'https://party.fixture.dev/v1/ws' }],
    ['short party key', { ...party, WATCH_PARTY_SECRET: 'short' }],
    ['non-string binding', { TMDB_API_KEY: 123 }],
  ])('rejects %s with a value-free validation error', (_label, overrides) => {
    let message = '';
    try { validateRuntimeBindings({ ...configuration, ...overrides }); } catch (error) { message = (error as Error).message; }
    expect(Boolean(message)).toBe(true);
    expect(message.includes(privateValue)).toBe(false);
  });

  it.each(PUBLIC_BUILD_NAMES)('blocks stale compiled %s before any command without rewriting public values', async (name) => {
    const root = fixture();
    emitBuild(root);
    const stale = { ...publicValues, [name]: name === 'NEXT_PUBLIC_APP_NAME' ? 'Old Fixture' : '' };
    writeFileSync(generatedPath(root), generatedSource(stale));
    let invoked = false;
    await expect(deployCloudflare(['--skip-build'], { root, inherited, runCommand: () => { invoked = true; } }))
      .rejects.toThrow(`differs from runtime bindings: ${name}`);
    expect(invoked).toBe(false);
    expect(readFileSync(generatedPath(root), 'utf8') === generatedSource(stale)).toBe(true);
  });

  it('checks every generated mode and rechecks after dry-run before uploading', async () => {
    const root = fixture();
    emitBuild(root);
    let uploaded = false;
    await expect(deployCloudflare(['--skip-build'], { root, inherited, runCommand: (_label, _executable, args) => {
      if (args.includes('--dry-run')) {
        writeFileSync(generatedPath(root), modes.map((mode) => `export const ${mode} = ${JSON.stringify({
          ...publicValues, NEXT_PUBLIC_APP_NAME: mode === 'test' ? 'Stale Fixture' : publicValues.NEXT_PUBLIC_APP_NAME,
        })};\n`).join(''));
      } else if (args[0] === 'deploy') uploaded = true;
    } })).rejects.toThrow('differs from runtime bindings: NEXT_PUBLIC_APP_NAME');
    expect(uploaded).toBe(false);
  });

  it('passes only the nonsecret party origin into the actual CSP build and keeps four public env exports', async () => {
    const environment = createBuildEnvironment(inherited, { ...configuration, ...party }, new Set(Object.keys(party)));
    expect(environment.WATCH_PARTY_WORKER_URL === party.WATCH_PARTY_WORKER_URL).toBe(true);
    expect(environment.WATCH_PARTY_SECRET === '').toBe(true);
    expect(sanitizeEnvModule(generatedSource({ ...configuration, ...party }), environment).includes('WATCH_PARTY')).toBe(false);
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('WATCH_PARTY_WORKER_URL', environment.WATCH_PARTY_WORKER_URL);
    const { default: nextConfig } = await import('../../next.config.mjs');
    expect(typeof nextConfig.headers).toBe('function');
    const rules = await nextConfig.headers!();
    const policy = rules[0]!.headers.find((header) => header.key === 'Content-Security-Policy')?.value ?? '';
    expect(policy.includes('wss://party.fixture.dev')).toBe(true);
    expect(policy.includes(party.WATCH_PARTY_SECRET)).toBe(false);
    expect(policy.includes("'unsafe-eval'")).toBe(false);
  });

  it('requires the configured party WebSocket origin in the bundled CSP, not a newer root manifest', async () => {
    const root = fixture();
    emitBuild(root);
    const bindings = { ...configuration, ...party };
    const path = join(root, 'party-runtime.json');
    writeFileSync(path, JSON.stringify(bindings));
    mkdirSync(join(root, '.next'));
    writeFileSync(join(root, '.next', 'routes-manifest.json'), JSON.stringify({ headers: [{
      source: '/((?!api/ad-frame).*)', headers: [{ key: 'Content-Security-Policy', value: "connect-src 'self' wss://party.fixture.dev" }],
    }] }));
    let invoked = false;
    await expect(deployCloudflare(['--skip-build', '--secrets-file', path], { root, inherited, runCommand: () => { invoked = true; } }))
      .rejects.toThrow('Built Watch Party CSP does not match');
    expect(invoked).toBe(false);
    emitPartyCsp(root, 'wss://other.fixture.dev');
    expect(() => validateBuiltEnvironment(root, bindings)).toThrow('Built Watch Party CSP does not match');
    emitPartyCsp(root, 'wss://party.fixture.dev');
    expect(() => validateBuiltEnvironment(root, bindings)).not.toThrow();
    await deployCloudflare(['--skip-build', '--secrets-file', path], { root, inherited, runCommand: () => { invoked = true; } });
    expect(invoked).toBe(true);
  });

  it('keeps manual CI on the shared validator and supplies the same public/CSP build inputs', () => {
    const workflow = readFileSync(join(projectRoot, '.github', 'workflows', 'deploy-lumora-cloudflare.yml'), 'utf8');
    const buildStep = workflow.split('- name: Build OpenNext Worker')[1]!.split('- name: Validate Worker upload')[0]!;
    for (const name of [...PUBLIC_BUILD_NAMES, 'WATCH_PARTY_WORKER_URL']) expect(buildStep.includes(`${name}:`)).toBe(true);
    expect(buildStep.includes('secrets.')).toBe(false);
    expect(workflow.includes('validateRuntimeBindings(process.env)')).toBe(true);
    expect(workflow.includes('new URL(process.env')).toBe(false);
    expect(workflow.includes('workflow_dispatch:')).toBe(true);
    expect(/^\s+(?:push|pull_request):/m.test(workflow)).toBe(false);
    expect(workflow.includes('workers/watch-party')).toBe(false);
  });
});
