import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { PROVIDER_CONFIGS, VIDUP_PROVIDER_CONFIG } from '@/lib/providers/config';
import type { ProviderDbRow } from '@/lib/providers/db-providers';

const mocks = vi.hoisted(() => ({
  features: { supabaseConfigured: true },
  rows: [] as ProviderDbRow[],
  read: vi.fn(), service: vi.fn(), publicClient: vi.fn(), sessionClient: vi.fn(), commerce: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/env', () => ({ features: mocks.features }));
vi.mock('@/lib/supabase/service', () => ({ getSupabaseServiceClient: mocks.service }));
vi.mock('@/lib/supabase/public', () => ({ getSupabasePublicClient: mocks.publicClient }));
vi.mock('@/lib/supabase/server', () => ({ getSupabaseServerClient: mocks.sessionClient }));
vi.mock('@/features/commerce/queries', () => ({ getPlaybackCommerceContext: mocks.commerce }));

function providerRow(key: string, enabled = true, config: unknown = {}): ProviderDbRow {
  return {
    key, enabled, name: 'Private operator provider label',
    base_url: 'https://embed.example', allowed_domains: ['embed.example'],
    movie_path_template: '/movie/{id}?lang=en', series_path_template: '/tv/{id}',
    episode_path_template: '/tv/{id}/{season}/{episode}?lang=en', shorthand_episode_template: '/tv/{id}-{season}-{episode}',
    priority: 100, timeout_ms: 5000, enabled_regions: ['*'], consent_required: true, test_title_id: null, config,
  };
}

function projectedRows() {
  return mocks.rows.map(({ config, ...row }) => {
    const options = config && typeof config === 'object' && !Array.isArray(config)
      ? config as Record<string, unknown> : {};
    return structuredClone({ ...row, preferred_id: options.preferred_id ?? null, start_param: options.start_param ?? null });
  });
}

async function apiSource(query = 'type=movie&tmdbId=27205&start=120') {
  const { GET } = await import('@/app/api/playback/route');
  const response = await GET(new NextRequest(`https://app.example/api/playback?${query}`));
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  const body = await response.json();
  expect(body.sources).toHaveLength(1);
  expect(body.sources[0]).toMatchObject({ id: 'server-1', label: 'Server 1', kind: 'embed', consentRequired: true });
  expect(JSON.stringify(body)).not.toMatch(/providerId|providerLabel|startParam|Private operator/);
  return new URL(body.sources[0].url as string);
}

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'synthetic-operator-key');
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network is disabled in this suite'); }));
  mocks.features.supabaseConfigured = true;
  mocks.rows = PROVIDER_CONFIGS.map((config) => providerRow(config.id, config.id === VIDUP_PROVIDER_CONFIG.id));
  mocks.read.mockImplementation(async () => ({ data: projectedRows(), count: mocks.rows.length, error: null }));
  mocks.service.mockReturnValue({ from(table: string) {
    expect(table).toBe('providers');
    return { select(columns: string, options: unknown) {
      expect(columns).toBe('key,name,enabled,base_url,allowed_domains,movie_path_template,series_path_template,' +
        'episode_path_template,shorthand_episode_template,priority,timeout_ms,enabled_regions,consent_required,' +
        'test_title_id,preferred_id:config->preferred_id,start_param:config->start_param');
      expect(options).toEqual({ count: 'exact' });
      return {
        order(column: string) { expect(column).toBe('key'); return this; },
        limit(count: number) { expect(count).toBe(65); return this; },
        retry(enabled: boolean) { expect(enabled).toBe(false); return this; },
        abortSignal: mocks.read,
      };
    } };
  } });
  mocks.publicClient.mockImplementation(() => { throw new Error('External-only playback must not query local titles'); });
  mocks.sessionClient.mockImplementation(() => { throw new Error('No session client is needed for this public request'); });
  mocks.commerce.mockResolvedValue({ ads: { enabled: false }, entitlements: { resolved: false, adFree: false } });
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  expect(mocks.publicClient).not.toHaveBeenCalled();
  expect(mocks.sessionClient).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('/api/playback consumes the persisted active provider resume contract', () => {
  it('inherits the built-in resume key only when the saved option is omitted', async () => {
    const url = await apiSource();
    expect(url.href).toBe('https://embed.example/movie/27205?lang=en&startAt=120');
    expect(mocks.read).toHaveBeenCalledTimes(1);
    expect(mocks.service).toHaveBeenCalledTimes(1);
  });

  it.each(['', ' \t\n '])('honors an explicit persisted clear %j instead of restoring the built-in key', async (startParam) => {
    mocks.rows.find((row) => row.key === VIDUP_PROVIDER_CONFIG.id)!.config = { start_param: startParam };
    const url = await apiSource();
    expect(url.href).toBe('https://embed.example/movie/27205?lang=en');
    const { getActiveProviderConfigs } = await import('@/lib/providers/registry');
    expect(getActiveProviderConfigs().find((config) => config.id === VIDUP_PROVIDER_CONFIG.id)?.startParam).toBeUndefined();
  });

  it('uses a trimmed persisted override rather than the built-in resume name', async () => {
    mocks.rows.find((row) => row.key === VIDUP_PROVIDER_CONFIG.id)!.config = { start_param: '  resumeAt  ' };
    const url = await apiSource('type=tv&tmdbId=1396&season=0&episode=1&start=125');
    expect(url.href).toBe('https://embed.example/tv/1396/0/1?lang=en&resumeAt=125');
    expect(url.searchParams.has('startAt')).toBe(false);
    expect(mocks.read).toHaveBeenCalledTimes(1);
  });

  it('supports a custom DB-only provider using its configured resume parameter', async () => {
    mocks.rows.forEach((row) => { row.enabled = false; });
    mocks.rows.push(providerRow('custom-resume', true, { start_param: 'position_seconds', preferred_id: 'tmdb' }));
    const url = await apiSource();
    expect(url.href).toBe('https://embed.example/movie/27205?lang=en&position_seconds=120');
    expect(mocks.read).toHaveBeenCalledTimes(1);
  });

  it('reflects persisted override, clear and re-enable after the same refresh used by admin saves', async () => {
    expect((await apiSource()).searchParams.get('startAt')).toBe('120');
    const { refreshProviderRegistry } = await import('@/lib/providers/registry');
    for (const startParam of ['resumeAt', '', 'offset']) {
      mocks.rows.find((row) => row.key === VIDUP_PROVIDER_CONFIG.id)!.config = { start_param: startParam, unrelated: 'preserved' };
      await refreshProviderRegistry();
      const url = await apiSource();
      expect([...url.searchParams]).toEqual([['lang', 'en'], ...(startParam ? [[startParam, '120']] : [])]);
    }
    // GET reuses the refreshed overlay; it must not add a second DB query.
    expect(mocks.read).toHaveBeenCalledTimes(4);
  });

  it('reloads a persisted clear in a fresh registry instance, not only the editor process cache', async () => {
    mocks.rows.find((row) => row.key === VIDUP_PROVIDER_CONFIG.id)!.config = { start_param: '' };
    expect((await apiSource()).searchParams.has('startAt')).toBe(false);
    vi.resetModules();
    expect((await apiSource()).searchParams.has('startAt')).toBe(false);
    expect(mocks.read).toHaveBeenCalledTimes(2);
  });

  it('reads active configs only after the initial provider overlay has finished loading', async () => {
    mocks.rows.find((row) => row.key === VIDUP_PROVIDER_CONFIG.id)!.config = { start_param: 'loadedPosition' };
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    mocks.read.mockImplementation(async () => {
      await ready;
      return { data: projectedRows(), count: mocks.rows.length, error: null };
    });
    const pending = apiSource();
    try {
      await vi.waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(1));
    } finally {
      release();
    }
    expect((await pending).searchParams.get('loadedPosition')).toBe('120');
    expect(mocks.read).toHaveBeenCalledTimes(1);
  });

  it.each([null, '', '0', '30', '-1', '31.5', 'NaN', 'Infinity', '120&autoplay=1'])('does not append a resume position for omitted, unsafe or too-small start=%s', async (start) => {
    const url = await apiSource(`type=movie&tmdbId=27205${start === null ? '' : `&start=${encodeURIComponent(start)}`}`);
    expect([...url.searchParams]).toEqual([['lang', 'en']]);
  });

  it('preserves the existing integer threshold and ignores caller-supplied parameter names', async () => {
    const url = await apiSource('type=movie&tmdbId=27205&start=31&startParam=autoplay');
    expect([...url.searchParams]).toEqual([['lang', 'en'], ['startAt', '31']]);
  });

  it.each(['seek&autoplay=1', 'seek#fragment', 'seek=value?other=1'])('encodes persisted name %j as one query key, not URL syntax', async (startParam) => {
    mocks.rows.find((row) => row.key === VIDUP_PROVIDER_CONFIG.id)!.config = { start_param: startParam };
    const url = await apiSource();
    expect(url.origin).toBe('https://embed.example');
    expect(url.pathname).toBe('/movie/27205');
    expect(url.hash).toBe('');
    expect([...url.searchParams]).toEqual([['lang', 'en'], [startParam, '120']]);
  });

  it('leaves a custom provider without a documented resume key unchanged', async () => {
    mocks.rows.forEach((row) => { row.enabled = false; });
    mocks.rows.push(providerRow('custom-no-resume'));
    expect((await apiSource()).href).toBe('https://embed.example/movie/27205?lang=en');
  });
});
