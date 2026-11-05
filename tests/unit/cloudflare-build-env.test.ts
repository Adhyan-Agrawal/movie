import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  buildCloudflare, cloudflareBuild, createBuildEnvironment, createCommandEnvironment,
  loadCloudflareEnvironment, PUBLIC_BUILD_NAMES, sanitizeEnvModule, sanitizeGeneratedEnvironment,
} from '../../scripts/build-cloudflare.mjs';
import { deployCloudflare } from '../../scripts/deploy-cloudflare.mjs';

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

  it.each([
    ['--preserve-runtime'],
    ['--preserve-runtime', '--skip-build', '--secrets-file', 'runtime.json'],
    ['--preserve-runtime', '--skip-build', '--secrets-file=runtime.json'],
  ])('rejects an ambiguous runtime-preserving release before invoking any command', async (...args) => {
    let invoked = false;
    await expect(deployCloudflare(args, { runCommand: () => { invoked = true; } }))
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
        await deployCloudflare(args, { runCommand: () => { invoked = true; } });
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
