import { afterEach, describe, expect, it, vi } from 'vitest';

describe('environment normalization', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('treats empty optional Cloudflare bindings as unconfigured', async () => {
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
});
