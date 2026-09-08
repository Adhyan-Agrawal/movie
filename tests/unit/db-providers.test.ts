import { describe, expect, it } from 'vitest';
import { dbProviderRowToConfig, mergeProviderConfigs, type ProviderDbRow } from '@/lib/providers/db-providers';
import { PROVIDER_CONFIGS, VIDUP_PROVIDER_CONFIG, type ProviderConfig } from '@/lib/providers/config';

/**
 * Contract tests for the DB → ProviderConfig mapping and the built-in merge
 * (Spec Section 9 / /admin/providers). These exercise the pure helpers only —
 * no Supabase is involved.
 */

function baseRow(overrides: Partial<ProviderDbRow> = {}): ProviderDbRow {
  return {
    key: 'custom',
    name: 'My Provider',
    enabled: true,
    base_url: 'https://embed.example.com',
    allowed_domains: ['embed.example.com'],
    movie_path_template: '/movie/{id}',
    series_path_template: '/tv/{id}',
    episode_path_template: '/tv/{id}/{season}/{episode}',
    shorthand_episode_template: '/tv/{id}-{season}-{episode}',
    priority: 150,
    timeout_ms: 9000,
    enabled_regions: ['*'],
    consent_required: true,
    test_title_id: '27205',
    ...overrides,
  };
}

describe('dbProviderRowToConfig', () => {
  it('maps every editable column onto the runtime ProviderConfig', () => {
    const config = dbProviderRowToConfig(
      baseRow({ config: { preferred_id: 'tmdb', start_param: 'startAt' } }),
    );

    expect(config).not.toBeNull();
    expect(config!.id).toBe('custom');
    expect(config!.displayName).toBe('My Provider');
    expect(config!.baseUrl).toBe('https://embed.example.com');
    expect(config!.allowedDomains).toEqual(['embed.example.com']);
    expect(config!.moviePathTemplate).toBe('/movie/{id}');
    expect(config!.tvSeriesPathTemplate).toBe('/tv/{id}');
    expect(config!.episodePathTemplate).toBe('/tv/{id}/{season}/{episode}');
    expect(config!.shorthandEpisodeTemplate).toBe('/tv/{id}-{season}-{episode}');
    expect(config!.defaultPriority).toBe(150);
    expect(config!.timeoutMs).toBe(9000);
    expect(config!.enabledRegions).toEqual(['*']);
    expect(config!.consentRequired).toBe(true);
    expect(config!.testTitleId).toBe('27205');
    expect(config!.preferredId).toBe('tmdb');
    expect(config!.startParam).toBe('startAt');
  });

  it('returns null when the row has no usable base URL and no built-in fallback', () => {
    expect(dbProviderRowToConfig(baseRow({ base_url: null }))).toBeNull();
  });

  it('returns null when the row has an empty host allowlist and no built-in fallback', () => {
    expect(dbProviderRowToConfig(baseRow({ allowed_domains: [] }))).toBeNull();
  });

  it('falls back to the built-in config for columns an overriding row leaves null', () => {
    const config = dbProviderRowToConfig(
      baseRow({ base_url: null, series_path_template: null, config: {} }),
      VIDUP_PROVIDER_CONFIG,
    );
    expect(config).not.toBeNull();
    // Base URL + whole-series route come from the vidup built-in.
    expect(config!.baseUrl).toBe(VIDUP_PROVIDER_CONFIG.baseUrl);
    expect(config!.tvSeriesPathTemplate).toBe(VIDUP_PROVIDER_CONFIG.tvSeriesPathTemplate);
    // Missing preferred_id/start_param in config jsonb fall back to the built-in.
    expect(config!.preferredId).toBe(VIDUP_PROVIDER_CONFIG.preferredId);
    expect(config!.startParam).toBe(VIDUP_PROVIDER_CONFIG.startParam);
  });

  it('prefers config-jsonb values over the built-in for preferred id / resume param', () => {
    const config = dbProviderRowToConfig(
      baseRow({ base_url: null, config: { preferred_id: 'imdb' } }),
      VIDUP_PROVIDER_CONFIG,
    );
    expect(config!.preferredId).toBe('imdb');
    expect(config!.startParam).toBe(VIDUP_PROVIDER_CONFIG.startParam);
  });

  it('ignores an invalid preferred_id from the config jsonb', () => {
    const config = dbProviderRowToConfig(baseRow({ config: { preferred_id: 'netflix' } }));
    expect(config!.preferredId).toBeUndefined();
  });

  it('defaults empty TV route templates to the movie route so URLs stay valid', () => {
    const config = dbProviderRowToConfig(
      baseRow({ series_path_template: null, episode_path_template: '', shorthand_episode_template: null }),
    );
    expect(config!.tvSeriesPathTemplate).toBe('/movie/{id}');
    expect(config!.episodePathTemplate).toBe('/movie/{id}');
    expect(config!.shorthandEpisodeTemplate).toBe('/movie/{id}');
  });
});

describe('mergeProviderConfigs', () => {
  it('returns the built-ins untouched when there are no DB rows', () => {
    const merged = mergeProviderConfigs(PROVIDER_CONFIGS, []);
    // Same providers, ordered by priority descending (the registry contract).
    expect(merged).toHaveLength(PROVIDER_CONFIGS.length);
    expect(new Set(merged.map((c) => c.id))).toEqual(new Set(PROVIDER_CONFIGS.map((c) => c.id)));
    const priorities = merged.map((c) => c.defaultPriority);
    expect(priorities).toEqual([...priorities].sort((a, b) => b - a));
  });

  it('adds an extra DB row and keeps built-ins in priority-descending order', () => {
    const merged = mergeProviderConfigs(PROVIDER_CONFIGS, [
      baseRow({ key: 'extra', name: 'Extra', priority: 250 }),
    ]);
    expect(merged.find((c) => c.id === 'extra')?.displayName).toBe('Extra');
    // vidsrc.mov (400) > extra (250) > 2embed (300)?? — priority order must be stable descending.
    const priorities = merged.map((c) => c.defaultPriority);
    expect(priorities).toEqual([...priorities].sort((a, b) => b - a));
  });

  it('lets a DB row override a built-in with the same key', () => {
    const merged = mergeProviderConfigs(PROVIDER_CONFIGS, [
      baseRow({ key: VIDUP_PROVIDER_CONFIG.id, name: 'VidUp (DB)', base_url: 'https://mirror.example.com', priority: 999 }),
    ]);
    const overridden = merged.find((c) => c.id === VIDUP_PROVIDER_CONFIG.id);
    expect(overridden).toBeDefined();
    expect(overridden!.displayName).toBe('VidUp (DB)');
    expect(overridden!.baseUrl).toBe('https://mirror.example.com');
    expect(overridden!.defaultPriority).toBe(999);
    // Still only one entry per key.
    expect(merged.filter((c) => c.id === VIDUP_PROVIDER_CONFIG.id)).toHaveLength(1);
    // Higher priority pushes it to the front of the merged list.
    expect(merged[0]!.id).toBe(VIDUP_PROVIDER_CONFIG.id);
  });

  it('skips rows that cannot map to a functional provider', () => {
    const merged = mergeProviderConfigs(PROVIDER_CONFIGS, [
      baseRow({ key: 'broken', base_url: null }),
      baseRow({ key: 'fine', name: 'Fine', priority: 50 }),
    ]);
    expect(merged.some((c) => c.id === 'broken')).toBe(false);
    expect(merged.find((c) => c.id === 'fine')).toBeDefined();
  });

  it('reuses the built-in id when mapping keeps its runtime key identical', () => {
    // Merge semantics must never duplicate ids — sanity check across the full set.
    const rows: ProviderDbRow[] = PROVIDER_CONFIGS.map((config) =>
      baseRow({
        key: config.id,
        name: `${config.displayName} row`,
        base_url: config.baseUrl,
        allowed_domains: config.allowedDomains,
      }),
    );
    const merged = mergeProviderConfigs(PROVIDER_CONFIGS, rows);
    const ids = merged.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('the merged config still builds a safe vidsrc-style URL', () => {
    // The mapping output must be directly usable by the shared embed adapter.
    const merged = mergeProviderConfigs(PROVIDER_CONFIGS, [
      baseRow({ key: 'custom', priority: 250, config: { preferred_id: 'tmdb' } }),
    ]);
    const custom = merged.find((c) => c.id === 'custom') as ProviderConfig;
    const url = new URL(custom.moviePathTemplate.replace('{id}', '27205'), custom.baseUrl);
    expect(url.hostname).toBe('embed.example.com');
    expect(custom.allowedDomains).toContain(url.hostname);
  });
});
