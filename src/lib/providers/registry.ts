/**
 * Provider registry + source selection (Spec Section 9).
 *
 * Maps provider id -> adapter and resolves a request by trying enabled
 * providers in priority order (highest `defaultPriority` first), returning the
 * first sanitized source. Every provider — the code-configured built-ins AND
 * the operator-added rows in the `providers` table — is served through the same
 * template-driven embed adapter; the differences are entirely configuration.
 *
 * DB MERGE (Spec Section 10 / /admin/providers): before building sources the
 * registry caches completed public provider configs for one minute through the SERVICE client
 * (`getSupabaseServiceClient`). RLS restricts `providers` to `provider.manage`
 * holders, so anonymous-viewer playback resolution cannot use the RLS-scoped
 * client — it reads with the service role and merges the rows into the built-in
 * list via `mergeProviderConfigs` (src/lib/providers/db-providers.ts). A DB row
 * whose `key` matches a built-in OVERRIDES it; extra rows are ADDED; the final
 * list is sorted by priority descending. Reads are request-owned, never shared
 * pending I/O. Failures retain validated config for at most five minutes;
 * static built-ins are only an intentional, bounded first-run fallback.
 *
 * Source selection considers priority and per-adapter success; language,
 * quality, region, and viewer preference weighting are TODO hooks for when more
 * providers and real source metadata exist (Spec Section 9).
 */

import type { PlaybackError, PlaybackRequest, PlaybackSource, ProviderAdapter } from './types';
import { PROVIDER_CONFIGS, type ProviderConfig } from './config';
import { createVidsrcAdapter } from './vidsrc';
import { createVidnestAdapter } from './vidnest';
import { dbProviderRowToConfig, mergeProviderConfigs, type ProviderDbRow } from './db-providers';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { features } from '@/lib/env';

interface RegistryEntry {
  config: ProviderConfig;
  adapter: ProviderAdapter;
}

/**
 * All adapters are built from the same template-driven embed adapter today —
 * the differences between providers are entirely configuration (domains, path
 * templates, priorities).
 */
function createAdapter(config: ProviderConfig): ProviderAdapter {
  return config.id === 'vidnest' ? createVidnestAdapter(config) : createVidsrcAdapter(config);
}

function createEntries(configs: readonly ProviderConfig[]): readonly RegistryEntry[] {
  return Object.freeze(configs.map((config) => {
    const snapshot = { ...config, allowedDomains: [...config.allowedDomains], enabledRegions: [...config.enabledRegions] };
    Object.freeze(snapshot.allowedDomains);
    Object.freeze(snapshot.enabledRegions);
    Object.freeze(snapshot);
    return Object.freeze({ config: snapshot, adapter: Object.freeze(createAdapter(snapshot)) });
  }));
}

const BUILTIN_ENTRIES = createEntries(PROVIDER_CONFIGS);
const EMPTY_ENTRIES: readonly RegistryEntry[] = Object.freeze([]);
const CONFIG_TTL_MS = 60_000;
const CONFIG_MAX_AGE_MS = 5 * 60_000;
const FAILURE_RETRY_MS = 5000;
const CONFIG_TIMEOUT_MS = 1500;
const MAX_CONFIG_ROWS = 64;
const MAX_ROW_BYTES = 16 * 1024;
const MAX_CONFIG_BYTES = 128 * 1024;
const MAX_OPTIONS_BYTES = 1024;
const CONFIG_COLUMNS = 'key,name,enabled,base_url,allowed_domains,movie_path_template,series_path_template,' +
  'episode_path_template,shorthand_episode_template,priority,timeout_ms,enabled_regions,consent_required,' +
  'test_title_id,preferred_id:config->preferred_id,start_param:config->start_param';

/** Admission limits apply after SDK decoding; never skip an override and enable its default. */
function validatedRows(data: unknown, count: unknown): ProviderDbRow[] {
  const invalid = () => new Error('Invalid provider configuration.');
  if (!Array.isArray(data) || data.length > MAX_CONFIG_ROWS
    || !Number.isSafeInteger(count) || count !== data.length) throw invalid();
  const keys = new Set<string>();
  const rows: ProviderDbRow[] = [];
  let totalBytes = 2;
  const encoder = new TextEncoder();
  const nullableLimits = {
    base_url: 2048, movie_path_template: 2048, series_path_template: 2048,
    episode_path_template: 2048, shorthand_episode_template: 2048, test_title_id: 64,
  } as const;
  for (const value of data) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
    const row = value as Record<string, unknown>;
    if (typeof row.key !== 'string' || row.key.length > 64 || !/^[a-z0-9][a-z0-9._-]*$/.test(row.key.trim())
      || typeof row.name !== 'string' || row.name.length > 256
      || typeof row.enabled !== 'boolean' || typeof row.consent_required !== 'boolean'
      || !Number.isSafeInteger(row.priority) || !Number.isSafeInteger(row.timeout_ms)
      || (row.timeout_ms as number) <= 0 || (row.timeout_ms as number) > 60_000) throw invalid();
    for (const [field, limit] of Object.entries(nullableLimits)) {
      if (row[field] !== null && (typeof row[field] !== 'string' || row[field].length > limit)) throw invalid();
    }
    for (const [field, count, length] of [['allowed_domains', 32, 253], ['enabled_regions', 64, 16]] as const) {
      const list = row[field];
      if (!Array.isArray(list) || list.length > count
        || list.some((item) => typeof item !== 'string' || item.length > length)) throw invalid();
    }
    if (row.preferred_id != null && row.preferred_id !== '' && row.preferred_id !== 'imdb' && row.preferred_id !== 'tmdb') {
      throw invalid();
    }
    if (row.start_param != null && (typeof row.start_param !== 'string' || row.start_param.length > 256)) throw invalid();
    const key = row.key.trim();
    if (keys.has(key)) throw invalid();
    keys.add(key);
    const config = { preferred_id: row.preferred_id ?? null, start_param: row.start_param ?? null };
    if (encoder.encode(JSON.stringify(config)).byteLength > MAX_OPTIONS_BYTES) throw invalid();
    // Only projected, validated fields survive; no operator metadata or other jsonb keys are cached.
    const parsed: ProviderDbRow = {
      key, name: row.name, enabled: row.enabled,
      base_url: row.base_url as string | null, allowed_domains: row.allowed_domains as string[],
      movie_path_template: row.movie_path_template as string | null,
      series_path_template: row.series_path_template as string | null,
      episode_path_template: row.episode_path_template as string | null,
      shorthand_episode_template: row.shorthand_episode_template as string | null,
      priority: row.priority as number, timeout_ms: row.timeout_ms as number,
      enabled_regions: row.enabled_regions as string[], consent_required: row.consent_required,
      test_title_id: row.test_title_id as string | null, config,
    };
    const bytes = encoder.encode(JSON.stringify(parsed)).byteLength;
    totalBytes += bytes + (rows.length ? 1 : 0);
    if (bytes > MAX_ROW_BYTES || totalBytes > MAX_CONFIG_BYTES) throw invalid();
    rows.push(parsed);
  }
  return rows;
}

/**
 * The current merged registry. Starts as the static built-ins and is replaced
 * by {@link refreshProviderRegistry} when the public config TTL expires (DB rows
 * override/add built-ins). Synchronous getters see the latest completed list;
 * playback captures its own entries before awaiting adapters.
 */
let mergedEntries: readonly RegistryEntry[] = BUILTIN_ENTRIES;
let usableUntil = Date.now() + CONFIG_MAX_AGE_MS;
let initialFallbackAllowed = true;
let refreshAfter = 0;
let refreshGeneration = 0;
let settledGeneration = 0;

function currentEntries(): readonly RegistryEntry[] {
  // Public login does not imply that private operator configuration is provisioned.
  // An accepted database override must never be replaced by defaults on key loss.
  if ((!features.supabaseConfigured || !process.env.SUPABASE_SERVICE_ROLE_KEY) && initialFallbackAllowed) return BUILTIN_ENTRIES;
  return Date.now() < usableUntil ? mergedEntries : EMPTY_ENTRIES;
}

/**
 * (Re)load the `providers` rows and merge them into the built-in configs.
 *
 * Each eligible invocation owns its query, abort controller and finite deadline.
 * Only validated completions and stateless adapters are shared across requests.
 * TTL is 60s; failure retry is 5s. Neither retries nor failures extend the 5-minute
 * maximum age. Initial transport outages may use built-ins within that grace;
 * malformed initial config fails closed immediately. Once DB config is accepted,
 * errors never restore defaults. Explicit admin refreshes bypass the TTL.
 */
export async function refreshProviderRegistry(force = true): Promise<void> {
  if (!features.supabaseConfigured || !process.env.SUPABASE_SERVICE_ROLE_KEY) return;
  if (!force && Date.now() < refreshAfter) return;
  const generation = ++refreshGeneration;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reason = 'unavailable';
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('Provider configuration timed out.'));
      }, CONFIG_TIMEOUT_MS);
    });
    const db = getSupabaseServiceClient();
    const { data, error, count } = await Promise.race([
      db.from('providers').select(CONFIG_COLUMNS, { count: 'exact' }).order('key').limit(MAX_CONFIG_ROWS + 1)
        .retry(false).abortSignal(controller.signal),
      deadline,
    ]);
    // Publish completed reads without waiting for newer pending I/O, but never
    // overwrite a newer settled operation (including its failure/backoff).
    if (generation < settledGeneration) return;
    if (error || controller.signal.aborted) throw new Error('Provider configuration unavailable.');
    reason = 'invalid-config';
    const rows = validatedRows(data, count);
    if (rows.some((row) => !dbProviderRowToConfig(row, PROVIDER_CONFIGS.find((config) => config.id === row.key)))) {
      throw new Error('Incomplete provider configuration.');
    }
    const configs = mergeProviderConfigs(PROVIDER_CONFIGS, rows);
    const entries = createEntries(configs);
    settledGeneration = generation;
    mergedEntries = entries;
    initialFallbackAllowed = false;
    usableUntil = Date.now() + CONFIG_MAX_AGE_MS;
    refreshAfter = Date.now() + CONFIG_TTL_MS;
  } catch {
    if (generation < settledGeneration) return;
    settledGeneration = generation;
    refreshAfter = Date.now() + FAILURE_RETRY_MS;
    if (initialFallbackAllowed && reason === 'invalid-config') {
      initialFallbackAllowed = false;
      usableUntil = 0;
    }
    console.error('providers.registry.mergeFailed', { reason: controller.signal.aborted ? 'timeout' : reason });
  } finally {
    clearTimeout(timer);
  }
}

/** The current final provider configs (built-ins merged/overridden by DB rows). */
export function getActiveProviderConfigs(): readonly ProviderConfig[] {
  return currentEntries().map((entry) => entry.config);
}

export function getAdapter(id: string): ProviderAdapter | undefined {
  return currentEntries().find((entry) => entry.config.id === id)?.adapter;
}

export interface ResolvedPlayback {
  /** Best source, or null when nothing could be resolved. */
  source: PlaybackSource | null;
  /** All sources offered by the winning provider (for the source selector). */
  sources: PlaybackSource[];
  /** Normalized failure when no source was produced. */
  error: PlaybackError | null;
  /** Winning provider id, or null. */
  providerId: string | null;
  /** Provider ids attempted, in order (safe diagnostics). */
  attempted: string[];
}

/**
 * Resolve sanitized playback sources for a request. Never throws — every
 * failure is normalized into `error` so the player can render an honest
 * unavailable/blocked state with retry.
 *
 * The DB merge runs first (best-effort), then every enabled provider is
 * attempted (in priority order) and its best source is collected, so the
 * player's source selector offers one entry per provider ("Server 1..N" in
 * priority order). `source` is the highest-priority success; a provider that
 * fails simply contributes no source — the viewer can still switch to the
 * others.
 */
export async function resolvePlayback(request: PlaybackRequest): Promise<ResolvedPlayback> {
  await refreshProviderRegistry(false);

  const entries = currentEntries()
    .filter((entry) => entry.config.enabled)
    .sort((a, b) => b.config.defaultPriority - a.config.defaultPriority);

  const attempted = entries.map((entry) => entry.config.id);
  const collected: PlaybackSource[] = [];
  let lastError: PlaybackError | null = null;

  // Providers are independent. Promise.all preserves priority/source numbering,
  // regardless of completion order, without caching any resolved source URLs.
  const results = await Promise.all(entries.map(async (entry) => {
    try {
      const sources = await entry.adapter.resolve(request);
      return {
        sources,
        error: sources.length > 0 ? null : {
          code: 'not-found',
          message: 'No authorized source is available from this provider.',
          recoverable: true,
          providerId: entry.config.id,
        } as PlaybackError,
      };
    } catch (error) {
      return { sources: [], error: entry.adapter.normalizeError(error) };
    }
  }));
  for (const result of results) {
    collected.push(...result.sources);
    if (result.error) lastError = result.error;
  }

  if (collected.length > 0) {
    const best = collected[0]!;
    return {
      source: best,
      sources: collected,
      error: null,
      providerId: best.providerId ?? null,
      attempted,
    };
  }

  if (entries.length === 0) {
    lastError = { code: 'provider-disabled', message: 'No playback providers are enabled.', recoverable: true };
  }

  return {
    source: null,
    sources: [],
    error: lastError ?? {
      code: 'provider-error',
      message: 'Playback is currently unavailable.',
      recoverable: true,
    },
    providerId: null,
    attempted,
  };
}
