import { AsyncLocalStorage } from 'node:async_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROVIDER_CONFIGS, VIDUP_PROVIDER_CONFIG } from '@/lib/providers/config';
import type { ProviderDbRow } from '@/lib/providers/db-providers';

const mocks = vi.hoisted(() => ({
  features: { supabaseConfigured: true },
  rows: [] as ProviderDbRow[],
  service: vi.fn(), from: vi.fn(), select: vi.fn(), order: vi.fn(), limit: vi.fn(), retry: vi.fn(), read: vi.fn(),
}));
vi.mock('@/lib/env', () => ({ features: mocks.features }));
vi.mock('@/lib/supabase/service', () => ({ getSupabaseServiceClient: mocks.service }));

const owners = new AsyncLocalStorage<string>();
const scalarColumns = [
  'key', 'name', 'enabled', 'base_url', 'allowed_domains', 'movie_path_template', 'series_path_template',
  'episode_path_template', 'shorthand_episode_template', 'priority', 'timeout_ms', 'enabled_regions',
  'consent_required', 'test_title_id',
] as const;
const columns = [...scalarColumns, 'preferred_id:config->preferred_id', 'start_param:config->start_param'].join(',');
const request = { titleId: 'synthetic-title', type: 'movie' as const, tmdbId: '27205' };

function providerRow(overrides: Partial<ProviderDbRow> = {}): ProviderDbRow {
  return {
    key: 'custom', name: 'Synthetic provider', enabled: true,
    base_url: 'https://embed.example', allowed_domains: ['embed.example'],
    movie_path_template: '/movie/{id}', series_path_template: '/tv/{id}',
    episode_path_template: '/tv/{id}/{season}/{episode}', shorthand_episode_template: '/tv/{id}-{season}-{episode}',
    priority: 100, timeout_ms: 8000, enabled_regions: ['*'], consent_required: true, test_title_id: null,
    ...overrides,
  };
}

function disabledRows(): ProviderDbRow[] {
  return PROVIDER_CONFIGS.map((config) => providerRow({ key: config.id, enabled: false }));
}

/** Synthetic PostgREST projection, not a real service client or HTTP response. */
function projectRows(rows: readonly ProviderDbRow[]): Record<string, unknown>[] {
  return rows.map((row) => {
    const config = row.config && typeof row.config === 'object' && !Array.isArray(row.config)
      ? row.config as Record<string, unknown> : {};
    return structuredClone({
      ...Object.fromEntries(scalarColumns.map((column) => [column, row[column]])),
      preferred_id: config.preferred_id ?? null, start_param: config.start_param ?? null,
    });
  });
}

interface QueryResult { data: unknown; error: unknown }
function deferredRead() {
  let resolve!: (result: QueryResult) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<QueryResult>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(0);
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'synthetic-operator-key');
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('HTTP is disabled in this suite'); }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.features.supabaseConfigured = true;
  mocks.rows = [];
  mocks.read.mockImplementation(async () => ({ data: projectRows(mocks.rows), error: null }));
  mocks.service.mockReturnValue({ from: mocks.from });
  mocks.from.mockImplementation((table: string) => {
    expect(table).toBe('providers');
    const owner = owners.getStore();
    const query = {
      order(column: string) { mocks.order(column); return query; },
      limit(count: number) { mocks.limit(count); return query; },
      retry(enabled: boolean) { mocks.retry(enabled); return query; },
      abortSignal(signal: AbortSignal) {
        expect(owners.getStore()).toBe(owner);
        return Promise.resolve(mocks.read(signal, owner)).then((result) => ({
          count: Array.isArray(result.data) ? result.data.length : null,
          ...result,
        }));
      },
    };
    return { select(selection: string, options: unknown) { mocks.select(selection, options); return query; } };
  });
});

afterEach(() => {
  try {
    expect(fetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});

describe('provider registry request ownership and publication', () => {
  it('keeps direct code providers available without database traffic when only public login is configured', async () => {
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '');
    const registry = await import('@/lib/providers/registry');
    await registry.refreshProviderRegistry();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    await registry.refreshProviderRegistry(false);
    expect(registry.getActiveProviderConfigs().map((config) => config.id)).toEqual(PROVIDER_CONFIGS.map((config) => config.id));
    expect(mocks.service).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it('never revives code defaults after an accepted override loses its private configuration key', async () => {
    const registry = await import('@/lib/providers/registry');
    mocks.rows = disabledRows();
    await registry.refreshProviderRegistry();
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '');
    await registry.refreshProviderRegistry();
    expect(registry.getActiveProviderConfigs().every((config) => !config.enabled)).toBe(true);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(registry.getActiveProviderConfigs()).toEqual([]);
    expect(mocks.read).toHaveBeenCalledTimes(1);
  });

  it('owns cold reads independently and fences an older completion after a newer disable', async () => {
    const registry = await import('@/lib/providers/registry');
    const older = deferredRead(), newer = deferredRead();
    mocks.read.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const first = owners.run('request-a', () => registry.resolvePlayback(request));
    const second = owners.run('request-b', () => registry.resolvePlayback(request));
    expect(mocks.read).toHaveBeenCalledTimes(2);
    expect(mocks.read.mock.calls.map((call) => call[1])).toEqual(['request-a', 'request-b']);
    expect(mocks.read.mock.calls[0]![0]).not.toBe(mocks.read.mock.calls[1]![0]);
    const firstFinished = vi.fn();
    void first.then(firstFinished);
    newer.resolve({ data: projectRows(disabledRows()), error: null });
    await expect(second).resolves.toMatchObject({ attempted: [], sources: [], error: { code: 'provider-disabled' } });
    expect(firstFinished).not.toHaveBeenCalled();
    // A completed config may be reused without ever joining request A's pending read.
    await expect(owners.run('request-c', () => registry.resolvePlayback(request))).resolves.toMatchObject({ attempted: [] });
    expect(mocks.read).toHaveBeenCalledTimes(2);
    older.resolve({ data: [], error: null });
    await expect(first).resolves.toMatchObject({ attempted: [], sources: [] });
    expect(registry.getActiveProviderConfigs().every((config) => !config.enabled)).toBe(true);
  });

  it('publishes a completed disable while a newer request still owns pending I/O', async () => {
    const registry = await import('@/lib/providers/registry');
    const older = deferredRead(), newer = deferredRead();
    mocks.read.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const first = registry.resolvePlayback(request);
    const second = registry.refreshProviderRegistry(false);
    older.resolve({ data: projectRows(disabledRows()), error: null });
    await expect(first).resolves.toMatchObject({ attempted: [], sources: [] });
    expect(registry.getAdapter('vidnest')?.id).toBe('vidnest');
    newer.resolve({ data: projectRows(disabledRows()), error: null });
    await second;
  });

  it('forces an independent post-save read during a pending TTL refresh without recursive extra reads', async () => {
    const registry = await import('@/lib/providers/registry');
    await registry.refreshProviderRegistry(false);
    await vi.advanceTimersByTimeAsync(60_000);
    const older = deferredRead(), forced = deferredRead();
    mocks.read.mockReturnValueOnce(older.promise).mockReturnValueOnce(forced.promise);
    const first = owners.run('viewer', () => registry.refreshProviderRegistry(false));
    const saved = owners.run('operator', () => registry.refreshProviderRegistry());
    expect(mocks.read).toHaveBeenCalledTimes(3);
    forced.resolve({ data: projectRows(disabledRows()), error: null });
    await saved;
    await registry.refreshProviderRegistry(false);
    expect(mocks.read).toHaveBeenCalledTimes(3);
    older.resolve({ data: [], error: null });
    await first;
    expect(mocks.read).toHaveBeenCalledTimes(3);
    expect(registry.getActiveProviderConfigs().every((config) => !config.enabled)).toBe(true);
  });

  it('does not let an older error shorten the newer completed config TTL', async () => {
    const registry = await import('@/lib/providers/registry');
    const older = deferredRead(), newer = deferredRead();
    mocks.read.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const first = registry.refreshProviderRegistry(false), second = registry.refreshProviderRegistry();
    newer.resolve({ data: projectRows(disabledRows()), error: null });
    await second;
    await vi.advanceTimersByTimeAsync(100);
    older.reject(new Error('synthetic private DB detail'));
    await first;
    await vi.advanceTimersByTimeAsync(59_899);
    await registry.refreshProviderRegistry(false);
    expect(mocks.read).toHaveBeenCalledTimes(2);
    expect(console.error).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await registry.refreshProviderRegistry(false);
    expect(mocks.read).toHaveBeenCalledTimes(3);
  });

  it('fences older success after a newer failure, preserving the disabled cache and 5s retry', async () => {
    const registry = await import('@/lib/providers/registry');
    mocks.rows = disabledRows();
    await registry.refreshProviderRegistry(false);
    const older = deferredRead(), newer = deferredRead();
    mocks.read.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const first = registry.refreshProviderRegistry(), second = registry.refreshProviderRegistry();
    newer.resolve({ data: null, error: { message: 'synthetic DB outage' } });
    await second;
    older.resolve({ data: [], error: null });
    await first;
    expect(registry.getActiveProviderConfigs().every((config) => !config.enabled)).toBe(true);
    await vi.advanceTimersByTimeAsync(4999);
    await registry.refreshProviderRegistry(false);
    expect(mocks.read).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    await registry.refreshProviderRegistry(false);
    expect(mocks.read).toHaveBeenCalledTimes(4);
  });

  it('bounds each read at its own 1.5s deadline even when transport ignores abort, and ignores late results', async () => {
    const registry = await import('@/lib/providers/registry');
    const firstRead = deferredRead(), secondRead = deferredRead();
    mocks.read.mockReturnValueOnce(firstRead.promise).mockReturnValueOnce(secondRead.promise);
    const first = registry.refreshProviderRegistry(false);
    await vi.advanceTimersByTimeAsync(500);
    const second = registry.refreshProviderRegistry(false);
    const secondFinished = vi.fn();
    void second.then(secondFinished);
    await vi.advanceTimersByTimeAsync(999);
    expect((mocks.read.mock.calls[0]![0] as AbortSignal).aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await first;
    expect((mocks.read.mock.calls[0]![0] as AbortSignal).aborted).toBe(true);
    expect((mocks.read.mock.calls[1]![0] as AbortSignal).aborted).toBe(false);
    expect(secondFinished).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    await second;
    expect((mocks.read.mock.calls[1]![0] as AbortSignal).aborted).toBe(true);
    mocks.rows = disabledRows();
    await registry.refreshProviderRegistry();
    firstRead.resolve({ data: [], error: null });
    secondRead.resolve({ data: [], error: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(registry.getActiveProviderConfigs().every((config) => !config.enabled)).toBe(true);
    expect(console.error).toHaveBeenNthCalledWith(1, 'providers.registry.mergeFailed', { reason: 'timeout' });
    expect(console.error).toHaveBeenNthCalledWith(2, 'providers.registry.mergeFailed', { reason: 'timeout' });
  });
});

describe('provider registry TTL, stale age and safe fallback', () => {
  it('reuses only completed config for 60s and starts its TTL at completion', async () => {
    const registry = await import('@/lib/providers/registry');
    const read = deferredRead();
    mocks.read.mockReturnValueOnce(read.promise);
    const loading = registry.refreshProviderRegistry(false);
    await vi.advanceTimersByTimeAsync(1499);
    read.resolve({ data: [], error: null });
    await loading;
    await vi.advanceTimersByTimeAsync(59_999);
    await registry.refreshProviderRegistry(false);
    expect(mocks.read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await registry.refreshProviderRegistry(false);
    expect(mocks.read).toHaveBeenCalledTimes(2);
    await registry.refreshProviderRegistry();
    expect(mocks.read).toHaveBeenCalledTimes(3);
  });

  it('keeps enabled:false and custom providers during failures without extending their five-minute maximum age', async () => {
    const registry = await import('@/lib/providers/registry');
    mocks.rows = [...disabledRows(), providerRow({ key: 'custom-disabled', enabled: false })];
    await registry.refreshProviderRegistry(false);
    mocks.read.mockResolvedValue({ data: null, error: { message: 'synthetic private DB details' } });
    for (const elapsed of [60_000, 5000, 234_999]) {
      await vi.advanceTimersByTimeAsync(elapsed);
      await registry.refreshProviderRegistry(false);
      expect(registry.getActiveProviderConfigs()).toHaveLength(PROVIDER_CONFIGS.length + 1);
      expect(registry.getActiveProviderConfigs().every((config) => !config.enabled)).toBe(true);
      await expect(registry.getAdapter('vidup')!.healthCheck()).resolves.toMatchObject({ status: 'disabled' });
    }
    // Age enforcement is synchronous, including while retry backoff is still active.
    await vi.advanceTimersByTimeAsync(1);
    expect(registry.getActiveProviderConfigs()).toEqual([]);
    expect(registry.getAdapter('vidup')).toBeUndefined();
    await expect(registry.resolvePlayback(request)).resolves.toMatchObject({ attempted: [], sources: [], error: { code: 'provider-disabled' } });
    expect(mocks.read).toHaveBeenCalledTimes(4);
    mocks.features.supabaseConfigured = false;
    expect(registry.getActiveProviderConfigs()).toEqual([]);
    mocks.features.supabaseConfigured = true;
    mocks.read.mockImplementation(async () => ({ data: projectRows(mocks.rows), error: null }));
    await registry.refreshProviderRegistry();
    expect(registry.getActiveProviderConfigs()).toHaveLength(PROVIDER_CONFIGS.length + 1);
    expect(registry.getActiveProviderConfigs().every((config) => !config.enabled)).toBe(true);
  });

  it('intentionally permits built-ins for a first-run transport outage only within a bounded startup grace', async () => {
    const registry = await import('@/lib/providers/registry');
    mocks.read.mockRejectedValue(new Error('synthetic unreachable DB'));
    await registry.refreshProviderRegistry(false);
    expect(registry.getActiveProviderConfigs()).toHaveLength(PROVIDER_CONFIGS.length);
    await vi.advanceTimersByTimeAsync(4999);
    await registry.refreshProviderRegistry(false);
    expect(mocks.read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await registry.refreshProviderRegistry(false);
    expect(mocks.read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(294_999);
    expect(registry.getAdapter('vidnest')).toBeDefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(registry.getActiveProviderConfigs()).toEqual([]);
    await registry.refreshProviderRegistry(false);
    expect(registry.getActiveProviderConfigs()).toEqual([]);
    mocks.read.mockResolvedValue({ data: [], error: null });
    await registry.refreshProviderRegistry();
    expect(registry.getActiveProviderConfigs()).toHaveLength(PROVIDER_CONFIGS.length);
  });

  it('intentionally uses static built-ins without any DB read when Supabase is unconfigured', async () => {
    mocks.features.supabaseConfigured = false;
    const registry = await import('@/lib/providers/registry');
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    await registry.refreshProviderRegistry();
    const result = await registry.resolvePlayback(request);
    expect(result.sources).toHaveLength(PROVIDER_CONFIGS.length);
    expect(result.providerId).toBe('vidnest');
    expect(mocks.service).not.toHaveBeenCalled();
  });

  it('does not leak error details from returned DB errors or service-client exceptions', async () => {
    const registry = await import('@/lib/providers/registry');
    const error = { details: 'synthetic private DB details', hint: 'synthetic credentials', code: 'private' };
    Object.defineProperty(error, 'message', { get() { throw new Error('DB details must not be inspected'); } });
    mocks.read.mockResolvedValue({ data: null, error });
    await expect(registry.refreshProviderRegistry(false)).resolves.toBeUndefined();
    mocks.service.mockImplementation(() => { throw new Error('synthetic service-role exception'); });
    await expect(registry.refreshProviderRegistry()).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledTimes(2);
    expect(console.error).toHaveBeenNthCalledWith(1, 'providers.registry.mergeFailed', { reason: 'unavailable' });
    expect(console.error).toHaveBeenNthCalledWith(2, 'providers.registry.mergeFailed', { reason: 'unavailable' });
  });
});

describe('provider registry projection and bounded admission', () => {
  it('projects consumed columns and only two JSON subkeys, retains disabled rows, and disables implicit HTTP retries', async () => {
    mocks.rows = [providerRow({
      key: 'vidup', enabled: false,
      config: { preferred_id: '', start_param: '', unused_private_blob: 'synthetic'.repeat(150_000) },
    })];
    const registry = await import('@/lib/providers/registry');
    await registry.refreshProviderRegistry(false);
    expect(mocks.select).toHaveBeenCalledWith(columns, { count: 'exact' });
    expect(mocks.order).toHaveBeenCalledWith('key');
    expect(mocks.limit).toHaveBeenCalledWith(65);
    expect(mocks.retry).toHaveBeenCalledWith(false);
    expect(mocks.read).toHaveBeenCalledTimes(1);
    const projected = projectRows(mocks.rows);
    expect(new TextEncoder().encode(JSON.stringify(projected)).byteLength).toBeLessThan(1024);
    expect(new TextEncoder().encode(JSON.stringify(mocks.rows)).byteLength).toBeGreaterThan(1_000_000);
    const config = registry.getActiveProviderConfigs().find((entry) => entry.id === 'vidup')!;
    expect(config.enabled).toBe(false);
    expect(config.preferredId).toBeUndefined();
    expect(config.startParam).toBeUndefined();
    expect(JSON.stringify(registry.getActiveProviderConfigs())).not.toContain('unused_private_blob');
  });

  it('preserves custom providers, explicit empty/whitespace clears, omitted fallbacks and finite negative priorities', async () => {
    mocks.rows = [...disabledRows(), providerRow({ key: 'custom-resume', priority: 999, config: { preferred_id: 'tmdb', start_param: 'seek&one=1' } })];
    const vidup = mocks.rows.find((row) => row.key === 'vidup')!;
    vidup.enabled = true;
    vidup.config = { preferred_id: '', start_param: '  \t\n ' };
    mocks.rows.find((row) => row.key === 'vidcore')!.priority = -1;
    const registry = await import('@/lib/providers/registry');
    await registry.refreshProviderRegistry(false);
    const configs = registry.getActiveProviderConfigs();
    expect(configs[0]).toMatchObject({ id: 'custom-resume', preferredId: 'tmdb', startParam: 'seek&one=1' });
    expect(configs.find((config) => config.id === 'vidup')).toMatchObject({ enabled: true, preferredId: undefined, startParam: undefined });
    expect(configs.find((config) => config.id === 'vidcore')).toMatchObject({ preferredId: 'tmdb', startParam: 'startAt', defaultPriority: -1 });
    const resolved = await registry.resolvePlayback(request);
    expect(resolved.attempted).toEqual(['custom-resume', 'vidup']);
    expect(resolved.sources.map((source) => source.providerId)).toEqual(resolved.attempted);
    vidup.config = {};
    await registry.refreshProviderRegistry();
    expect(registry.getActiveProviderConfigs().find((config) => config.id === 'vidup')?.startParam).toBe(VIDUP_PROVIDER_CONFIG.startParam);
  });

  it('normalizes a padded built-in key before merging so disabled nullable overrides cannot be skipped', async () => {
    mocks.rows = [providerRow({
      key: ' vidup ', enabled: false, base_url: null, allowed_domains: [],
      movie_path_template: null, series_path_template: null, episode_path_template: null, shorthand_episode_template: null,
      enabled_regions: [],
    })];
    const registry = await import('@/lib/providers/registry');
    await registry.refreshProviderRegistry(false);
    expect(registry.getActiveProviderConfigs().find((config) => config.id === 'vidup')).toMatchObject({
      enabled: false, baseUrl: VIDUP_PROVIDER_CONFIG.baseUrl, startParam: VIDUP_PROVIDER_CONFIG.startParam,
    });
    expect(registry.getActiveProviderConfigs()).toHaveLength(PROVIDER_CONFIGS.length);
  });

  it('does not share mutable response rows, config objects, adapters, or resolved playback sources', async () => {
    const rows = projectRows([providerRow({ key: 'vidup', enabled: false })]);
    mocks.read.mockResolvedValue({ data: rows, error: null });
    const registry = await import('@/lib/providers/registry');
    await registry.refreshProviderRegistry(false);
    const config = registry.getActiveProviderConfigs().find((entry) => entry.id === 'vidup')!;
    expect(Object.isFrozen(config)).toBe(true);
    expect(() => { config.enabled = true; }).toThrow();
    expect(() => config.allowedDomains.push('untrusted.example')).toThrow();
    expect(Object.isFrozen(registry.getAdapter('vidup'))).toBe(true);
    (rows[0]!.allowed_domains as string[])[0] = 'untrusted.example';
    expect(config.allowedDomains).toEqual(['embed.example']);
    const first = await registry.resolvePlayback(request);
    const second = await registry.resolvePlayback({ ...request, titleId: 'another-title', tmdbId: '1396' });
    expect(first.sources).not.toBe(second.sources);
    expect(first.source).not.toBe(second.source);
    expect(first.source?.url).toContain('tmdbId=27205');
    expect(second.source?.url).toContain('tmdbId=1396');
    expect(mocks.read).toHaveBeenCalledTimes(1);
    expect(config.enabled).toBe(false);
  });

  it('accepts 64 complete rows and rejects the 65th sentinel instead of silently losing disabled overrides', async () => {
    mocks.rows = [...disabledRows(), ...Array.from({ length: 58 }, (_, i) => providerRow({ key: `custom-${i}`, enabled: false }))];
    const registry = await import('@/lib/providers/registry');
    await registry.refreshProviderRegistry(false);
    expect(registry.getActiveProviderConfigs()).toHaveLength(64);
    mocks.rows.push(providerRow({ key: 'overflow', enabled: false }));
    await registry.refreshProviderRegistry();
    expect(registry.getActiveProviderConfigs()).toHaveLength(64);
    expect(registry.getActiveProviderConfigs().every((config) => !config.enabled)).toBe(true);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(registry.getActiveProviderConfigs()).toEqual([]);
    expect(console.error).toHaveBeenCalledWith('providers.registry.mergeFailed', { reason: 'invalid-config' });
  });

  it('rejects a valid-looking truncated prefix instead of restoring defaults for omitted disabled rows', async () => {
    mocks.rows = disabledRows();
    const registry = await import('@/lib/providers/registry');
    await registry.refreshProviderRegistry(false);
    mocks.read.mockResolvedValue({ data: projectRows([providerRow({ key: 'vidup' })]), count: 2, error: null });
    await registry.refreshProviderRegistry();
    expect(registry.getActiveProviderConfigs().every((config) => !config.enabled)).toBe(true);
    expect(console.error).toHaveBeenCalledWith('providers.registry.mergeFailed', { reason: 'invalid-config' });
  });

  it('rejects an unmappable enabled built-in row instead of resurrecting its disabled default', async () => {
    mocks.rows = disabledRows();
    const registry = await import('@/lib/providers/registry');
    await registry.refreshProviderRegistry(false);
    const vidup = mocks.rows.find((row) => row.key === 'vidup')!;
    vidup.enabled = true;
    vidup.allowed_domains = ['   '];
    await registry.refreshProviderRegistry();
    expect(registry.getActiveProviderConfigs().every((config) => !config.enabled)).toBe(true);
    expect(console.error).toHaveBeenCalledWith('providers.registry.mergeFailed', { reason: 'invalid-config' });
  });

  it.each([null, undefined, -1, NaN, Infinity, 65, 0, 1.5])('fails closed on missing, excessive or inconsistent count metadata: %s', async (count) => {
    mocks.read.mockResolvedValue({ data: projectRows([providerRow()]), count, error: null });
    const registry = await import('@/lib/providers/registry');
    await registry.refreshProviderRegistry(false);
    expect(registry.getActiveProviderConfigs()).toEqual([]);
    expect(console.error).toHaveBeenCalledWith('providers.registry.mergeFailed', { reason: 'invalid-config' });
  });

  it.each([
    ['key', { key: 'x'.repeat(65) }],
    ['display name', { name: 'x'.repeat(257) }],
    ['base URL', { base_url: 'x'.repeat(2049) }],
    ['movie template', { movie_path_template: 'x'.repeat(2049) }],
    ['series template', { series_path_template: 'x'.repeat(2049) }],
    ['episode template', { episode_path_template: 'x'.repeat(2049) }],
    ['shorthand template', { shorthand_episode_template: 'x'.repeat(2049) }],
    ['test id', { test_title_id: 'x'.repeat(65) }],
    ['domain count', { allowed_domains: Array.from({ length: 33 }, () => 'embed.example') }],
    ['domain length', { allowed_domains: ['x'.repeat(254)] }],
    ['region count', { enabled_regions: Array.from({ length: 65 }, () => 'US') }],
    ['region length', { enabled_regions: ['x'.repeat(17)] }],
    ['resume string', { start_param: 'x'.repeat(257) }],
    ['preferred JSON object', { preferred_id: { nested: 'imdb' } }],
    ['resume JSON array', { start_param: ['startAt'] }],
    ['serialized option bytes', { start_param: '\u0001'.repeat(200) }],
  ])('rejects an oversized or structured %s without replacing the disabled snapshot', async (_label, patch) => {
    const registry = await import('@/lib/providers/registry');
    mocks.rows = disabledRows();
    await registry.refreshProviderRegistry(false);
    const bad = { ...projectRows([providerRow({ key: 'vidup' })])[0], ...patch };
    mocks.read.mockResolvedValue({ data: [bad], error: null });
    await registry.refreshProviderRegistry();
    expect(registry.getActiveProviderConfigs().every((config) => !config.enabled)).toBe(true);
    expect(console.error).toHaveBeenCalledWith('providers.registry.mergeFailed', { reason: 'invalid-config' });
  });

  it('rejects a row above 16KiB even when individual fields are within their caps', async () => {
    mocks.rows = [providerRow({
      base_url: 'x'.repeat(2048), allowed_domains: Array.from({ length: 32 }, () => 'd'.repeat(253)),
      movie_path_template: 'x'.repeat(2048), series_path_template: 'x'.repeat(2048),
      episode_path_template: 'x'.repeat(2048), shorthand_episode_template: 'x'.repeat(2048),
    })];
    const registry = await import('@/lib/providers/registry');
    await registry.refreshProviderRegistry(false);
    expect(registry.getActiveProviderConfigs()).toEqual([]);
    expect(console.error).toHaveBeenCalledWith('providers.registry.mergeFailed', { reason: 'invalid-config' });
  });

  it('rejects a total snapshot above 128KiB even when row counts and individual row sizes are within caps', async () => {
    mocks.rows = Array.from({ length: 32 }, (_, i) => providerRow({
      key: `custom-${i}`, movie_path_template: 'x'.repeat(1024), series_path_template: 'x'.repeat(1024),
      episode_path_template: 'x'.repeat(1024), shorthand_episode_template: 'x'.repeat(1024),
    }));
    expect(new TextEncoder().encode(JSON.stringify(projectRows(mocks.rows))).byteLength).toBeGreaterThan(128 * 1024);
    const registry = await import('@/lib/providers/registry');
    await registry.refreshProviderRegistry(false);
    expect(registry.getActiveProviderConfigs()).toEqual([]);
    expect(console.error).toHaveBeenCalledWith('providers.registry.mergeFailed', { reason: 'invalid-config' });
  });

  it.each([
    null, {}, [null], [[]],
    [{ key: 'vidup', name: 'Incomplete disable', enabled: false }],
    [{ ...projectRows([providerRow({ key: 'vidup' })])[0], enabled: 'false' }],
    [{ ...projectRows([providerRow()])[0], priority: NaN }],
    [{ ...projectRows([providerRow()])[0], timeout_ms: 0 }],
    [{ ...projectRows([providerRow()])[0], timeout_ms: 60_001 }],
    [{ ...projectRows([providerRow()])[0], allowed_domains: [null] }],
    [{ ...projectRows([providerRow()])[0], preferred_id: 'invalid' }],
    projectRows([providerRow({ key: 'vidup' }), providerRow({ key: ' vidup ', enabled: false })]),
    projectRows([providerRow({ key: 'unmappable', enabled: false, base_url: null, allowed_domains: [] })]),
  ])('fails closed on malformed initial config %j rather than treating it as empty successful config', async (data) => {
    mocks.read.mockResolvedValue({ data, error: null });
    const registry = await import('@/lib/providers/registry');
    await registry.refreshProviderRegistry(false);
    expect(registry.getActiveProviderConfigs()).toEqual([]);
    expect(registry.getAdapter('vidup')).toBeUndefined();
    await expect(registry.resolvePlayback(request)).resolves.toMatchObject({ attempted: [], sources: [] });
    expect(mocks.read).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith('providers.registry.mergeFailed', { reason: 'invalid-config' });
    mocks.features.supabaseConfigured = false;
    expect(registry.getActiveProviderConfigs()).toEqual([]);
  });
});
