import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('environment normalization', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_APP_URL', undefined);
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('treats empty optional server settings as unconfigured', async () => {
    for (const name of [
      'NEXT_PUBLIC_SUPABASE_URL',
      'NEXT_PUBLIC_SUPABASE_ANON_KEY',
      'SUPABASE_SERVICE_ROLE_KEY',
      'TMDB_API_KEY',
      'ADSTERRA_KEY_LEADERBOARD',
      'ADSTERRA_KEY_RECTANGLE',
      'ADSTERRA_KEY_PREROLL',
    ]) vi.stubEnv(name, '');

    const { features, publicEnv, serverEnv } = await import('@/lib/env');
    expect(features.supabaseConfigured).toBe(false);
    expect(publicEnv.NEXT_PUBLIC_SUPABASE_URL).toBeUndefined();
    expect(publicEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY).toBeUndefined();
    expect(serverEnv()).toMatchObject({ TMDB_API_BASE_URL: 'https://api.themoviedb.org/3' });
    expect(serverEnv().ADSTERRA_KEY_LEADERBOARD).toBeUndefined();
    expect(serverEnv().ADSTERRA_KEY_RECTANGLE).toBeUndefined();
    expect(serverEnv().ADSTERRA_KEY_PREROLL).toBeUndefined();
  });

  it.each(['test', 'development'])('keeps the localhost default only for %s', async (mode) => {
    vi.stubEnv('NODE_ENV', mode);
    expect((await import('@/lib/env')).publicEnv.NEXT_PUBLIC_APP_URL).toBe('http://localhost:3000');
  });

  it('requires an explicit production canonical origin even when Netlify URL variables exist', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('URL', 'https://main-site.netlify.app');
    vi.stubEnv('DEPLOY_URL', 'https://deploy-id--main-site.netlify.app');
    vi.stubEnv('DEPLOY_PRIME_URL', 'https://preview--main-site.netlify.app');
    await expect(import('@/lib/env')).rejects.toThrow('NEXT_PUBLIC_APP_URL');
  });

  it('normalizes the explicit canonical origin without adopting Netlify deploy URLs or enabling accounts', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.example/');
    vi.stubEnv('URL', 'https://main-site.netlify.app');
    vi.stubEnv('DEPLOY_PRIME_URL', 'https://preview--main-site.netlify.app');
    const { publicEnv, features } = await import('@/lib/env');
    expect(publicEnv.NEXT_PUBLIC_APP_URL).toBe('https://app.example');
    expect(features.supabaseConfigured).toBe(false);
  });

  it.each([
    '', 'https://user:fixture-password@app.example', 'http://app.example', 'file:///private',
    'https://app.example/path', 'https://app.example/./', 'https://app.example?private=1', 'https://app.example#private',
    'https://app.example?', 'https://app.example#', ' https://app.example', 'https://app.\texample',
    'https://app.example\\private', 'http://localhost:3000', 'https://localhost', 'https://localhost.',
    'https://127.0.0.1', 'https://[::1]', 'https://10.0.0.1', 'https://app.internal',
  ])('rejects unsafe or non-origin production app URL %j without disclosing its value', async (value) => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', value);
    const rejected = import('@/lib/env');
    await expect(rejected).rejects.toThrow('NEXT_PUBLIC_APP_URL');
    await expect(rejected).rejects.not.toThrow('fixture-password');
  });

  it.each(['http://localhost:3100', 'http://127.0.0.1:3100', 'http://[::1]:3100'])('allows the explicit local development origin %s', async (value) => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', value);
    expect((await import('@/lib/env')).publicEnv.NEXT_PUBLIC_APP_URL).toBe(value);
  });
});
