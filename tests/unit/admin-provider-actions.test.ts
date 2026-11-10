import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ permission: vi.fn(), server: vi.fn(), refresh: vi.fn(), revalidate: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }));
vi.mock('@/lib/permissions/check', () => ({ requirePermission: mocks.permission }));
vi.mock('@/lib/supabase/server', () => ({ getSupabaseServerClient: mocks.server }));
vi.mock('@/lib/providers/registry', () => ({ refreshProviderRegistry: mocks.refresh, getAdapter: vi.fn() }));

import { saveProviderAction, setProviderEnabledAction, type ProviderSaveInput } from '@/features/admin/provider-actions';
import { VIDUP_PROVIDER_CONFIG } from '@/lib/providers/config';
import { dbProviderRowToConfig, type ProviderDbRow } from '@/lib/providers/db-providers';

const input: ProviderSaveInput = {
  key: VIDUP_PROVIDER_CONFIG.id,
  name: 'Fixture Provider',
  baseUrl: 'https://embed.example.com',
  allowedDomains: ['embed.example.com'],
  moviePathTemplate: '/movie/{id}',
  tvSeriesPathTemplate: '/tv/{id}',
  episodePathTemplate: '/tv/{id}/{season}/{episode}',
  shorthandEpisodeTemplate: '/tv/{id}-{season}-{episode}',
  priority: 140,
  consentRequired: true,
  enabled: true,
};
const storedOptions = {
  preferred_id: 'tmdb', start_param: 'startAt', theme: { color: 'blue' }, subtitles: true,
};
const existingProvider: ProviderDbRow = {
  key: input.key, name: input.name, enabled: true, base_url: input.baseUrl,
  allowed_domains: input.allowedDomains, movie_path_template: input.moviePathTemplate,
  series_path_template: input.tvSeriesPathTemplate, episode_path_template: input.episodePathTemplate,
  shorthand_episode_template: input.shorthandEpisodeTemplate, priority: 100, timeout_ms: 12000,
  enabled_regions: ['IN'], consent_required: true, test_title_id: '27205', config: storedOptions,
};
let stored: ProviderDbRow | null;
let readError: { message: string } | null;
let writeError: { message: string } | null;
let writes: { operation: string; patch: Record<string, unknown> }[];
const fetchMock = vi.fn<typeof fetch>();

function database() {
  return {
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'fixture-admin' } } })) },
    from: vi.fn((table: string) => {
      if (table !== 'providers') throw new Error(`Unexpected table: ${table}`);
      let operation = '';
      let patch: Record<string, unknown> = {};
      const query = {
        select: vi.fn(() => query),
        eq: vi.fn(() => query),
        maybeSingle: vi.fn(async () => ({ data: stored ? { id: 'fixture-provider', config: stored.config } : null, error: readError })),
        update: vi.fn((value: Record<string, unknown>) => { operation = 'update'; patch = value; return query; }),
        insert: vi.fn((value: Record<string, unknown>) => { operation = 'insert'; patch = value; return query; }),
        then: (resolve: (value: { error: typeof writeError }) => unknown) => {
          if (!operation) throw new Error('Unexpected unmocked database operation.');
          writes.push({ operation, patch });
          if (!writeError) stored = { ...(stored ?? existingProvider), ...patch } as ProviderDbRow;
          return Promise.resolve({ error: writeError }).then(resolve);
        },
      };
      return query;
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  stored = { ...existingProvider, config: { ...storedOptions } };
  readError = null; writeError = null; writes = [];
  mocks.permission.mockResolvedValue(undefined);
  mocks.server.mockResolvedValue(database());
  mocks.refresh.mockResolvedValue(undefined);
  fetchMock.mockReset().mockRejectedValue(new Error('No live HTTP is permitted in provider editor tests.'));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  expect(fetchMock).not.toHaveBeenCalled();
  vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe('provider option persistence and mapping', () => {
  it('persists explicit clears without resurrecting old config or built-in defaults', async () => {
    expect(await saveProviderAction({ ...input, preferredId: '', startParam: '' })).toEqual({ ok: true });
    expect(stored!.config).toEqual({ ...storedOptions, preferred_id: '', start_param: '' });
    const mapped = dbProviderRowToConfig(stored!, VIDUP_PROVIDER_CONFIG)!;
    expect(mapped.preferredId).toBeUndefined();
    expect(mapped.startParam).toBeUndefined();
    expect(mapped.timeoutMs).toBe(12000);
    expect(mapped.enabledRegions).toEqual(['IN']);
    expect(mapped.testTitleId).toBe('27205');
    expect(writes[0]!.patch).not.toHaveProperty('timeout_ms');
    expect(writes[0]!.patch).not.toHaveProperty('health');
    expect(mocks.permission).toHaveBeenCalledWith('provider.manage');
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(mocks.revalidate).toHaveBeenCalledWith('/admin/providers');
  });

  it('treats whitespace-only resume input as an explicit clear', async () => {
    expect(await saveProviderAction({ ...input, startParam: ' \t\n ' })).toEqual({ ok: true });
    expect(stored!.config).toEqual({ ...storedOptions, start_param: '' });
    expect(dbProviderRowToConfig(stored!, VIDUP_PROVIDER_CONFIG)!.startParam).toBeUndefined();
  });

  it.each([{}, { preferredId: undefined, startParam: undefined }])(
    'preserves both options when omitted: %j', async (options) => {
      expect(await saveProviderAction({ ...input, ...options })).toEqual({ ok: true });
      expect(stored!.config).toEqual(storedOptions);
      const mapped = dbProviderRowToConfig(stored!, VIDUP_PROVIDER_CONFIG)!;
      expect(mapped.preferredId).toBe('tmdb');
      expect(mapped.startParam).toBe('startAt');
    },
  );

  it('clears preferred id without clearing an omitted resume parameter', async () => {
    await saveProviderAction({ ...input, preferredId: '' });
    expect(stored!.config).toEqual({ ...storedOptions, preferred_id: '' });
    const mapped = dbProviderRowToConfig(stored!, VIDUP_PROVIDER_CONFIG)!;
    expect(mapped.preferredId).toBeUndefined(); expect(mapped.startParam).toBe('startAt');
  });

  it('preserves clear markers when a later edit omits those fields', async () => {
    await saveProviderAction({ ...input, preferredId: '', startParam: '' });
    expect(await saveProviderAction({ ...input, name: 'Renamed Provider' })).toEqual({ ok: true });
    expect(stored!.config).toEqual({ ...storedOptions, preferred_id: '', start_param: '' });
    expect(stored!.name).toBe('Renamed Provider');
    const mapped = dbProviderRowToConfig(stored!, VIDUP_PROVIDER_CONFIG)!;
    expect(mapped.preferredId).toBeUndefined(); expect(mapped.startParam).toBeUndefined();
  });

  it('retains clear markers when a later enable toggle patches other columns', async () => {
    await saveProviderAction({ ...input, preferredId: '', startParam: '' });
    expect(await setProviderEnabledAction(input.key, false)).toEqual({ ok: true });
    expect(stored!.enabled).toBe(false);
    expect(stored!.config).toEqual({ ...storedOptions, preferred_id: '', start_param: '' });
    expect(writes[1]!.patch).not.toHaveProperty('config');
  });

  it.each([VIDUP_PROVIDER_CONFIG.id, 'custom-provider'])('persists clears for a newly created row: %s', async (key) => {
    stored = null;
    expect(await saveProviderAction({ ...input, key, preferredId: '', startParam: '' })).toEqual({ ok: true });
    expect(writes[0]!.operation).toBe('insert');
    expect(stored!.config).toEqual({ preferred_id: '', start_param: '' });
    const mapped = dbProviderRowToConfig(stored!, key === VIDUP_PROVIDER_CONFIG.id ? VIDUP_PROVIDER_CONFIG : undefined)!;
    expect(mapped.preferredId).toBeUndefined(); expect(mapped.startParam).toBeUndefined();
  });

  it('inherits built-in options when a new row omits them rather than clearing them', async () => {
    stored = null;
    expect(await saveProviderAction(input)).toEqual({ ok: true });
    expect(stored!.config).toEqual({});
    const mapped = dbProviderRowToConfig(stored!, VIDUP_PROVIDER_CONFIG)!;
    expect(mapped.preferredId).toBe(VIDUP_PROVIDER_CONFIG.preferredId);
    expect(mapped.startParam).toBe(VIDUP_PROVIDER_CONFIG.startParam);
  });

  it('saves valid replacement values and preserves unedited JSON options', async () => {
    expect(await saveProviderAction({ ...input, preferredId: 'imdb', startParam: '  resumeAt  ' })).toEqual({ ok: true });
    expect(stored!.config).toEqual({ ...storedOptions, preferred_id: 'imdb', start_param: 'resumeAt' });
    const mapped = dbProviderRowToConfig(stored!, VIDUP_PROVIDER_CONFIG)!;
    expect(mapped.preferredId).toBe('imdb'); expect(mapped.startParam).toBe('resumeAt');
  });
});

describe('provider edit validation and failures', () => {
  it('checks permission before database access', async () => {
    mocks.permission.mockRejectedValueOnce(new Error('Denied'));
    expect((await saveProviderAction(input)).ok).toBe(false);
    expect(mocks.server).not.toHaveBeenCalled(); expect(writes).toEqual([]);
  });

  it.each([
    { preferredId: 'unsupported' }, { preferredId: null }, { preferredId: false },
    { startParam: 123 }, { startParam: null }, { priority: 1.5 },
    { key: 'invalid/key' }, { name: '' }, { baseUrl: 'http://embed.example.com' },
    { moviePathTemplate: '/movie/{secret}' }, { episodePathTemplate: '' },
  ])('does not weaken input validation while accepting clears: %j', async (values) => {
    expect((await saveProviderAction({ ...input, ...values } as ProviderSaveInput)).ok).toBe(false);
    expect(mocks.server).not.toHaveBeenCalled(); expect(writes).toEqual([]);
    expect(mocks.refresh).not.toHaveBeenCalled(); expect(mocks.revalidate).not.toHaveBeenCalled();
  });

  it('does not treat a failed config read as a missing row and overwrite unknown options', async () => {
    stored = null; readError = { message: 'Mocked read error' };
    expect(await saveProviderAction({ ...input, preferredId: '', startParam: '' })).toMatchObject({
      ok: false, error: expect.stringContaining('Could not read'),
    });
    expect(writes).toEqual([]); expect(mocks.refresh).not.toHaveBeenCalled(); expect(mocks.revalidate).not.toHaveBeenCalled();
  });

  it.each([false, true])('does not refresh or claim success when persistence fails (new row: %s)', async (isNew) => {
    if (isNew) stored = null;
    writeError = { message: 'Mocked write error' };
    expect((await saveProviderAction({ ...input, preferredId: '', startParam: '' })).ok).toBe(false);
    expect(stored?.config).toEqual(isNew ? undefined : storedOptions);
    expect(mocks.refresh).not.toHaveBeenCalled(); expect(mocks.revalidate).not.toHaveBeenCalled();
  });
});
