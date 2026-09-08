/**
 * Database-provider mapping (Spec Section 9 / /admin/providers).
 *
 * Admin-configured `providers` rows are stored in a column shape that is close
 * to — but not identical to — the runtime {@link ProviderConfig}. This module
 * is the pure, unit-testable translation layer between the two:
 *
 *   - {@link dbProviderRowToConfig} maps ONE `providers` row into a
 *     `ProviderConfig`, falling back to a matching built-in config for columns
 *     the row leaves null/empty so an override never silently drops a field the
 *     admin has not edited.
 *   - {@link mergeProviderConfigs} produces the FINAL ordered provider list the
 *     registry serves from: built-ins first, DB rows overriding their built-in
 *     when the keys match, extra rows appended, all sorted by priority
 *     descending (public "Server 1..N" order).
 *
 * The module intentionally does NOT import Supabase clients or the server-only
 * `env` module so it can run in plain unit tests.
 */

import type { ProviderConfig } from './config';

/**
 * The `providers` columns the registry actually consumes. Structurally a subset
 * of `Database['public']['Tables']['providers']['Row']` (see
 * `src/lib/supabase/types.ts` / migration 0003) — typed loosely here so tests
 * never need the generated Supabase `Json` type. `preferred_id` and
 * `start_param` live inside the `config` jsonb column, not as top-level columns.
 */
export interface ProviderDbRow {
  key: string;
  name: string;
  enabled: boolean;
  base_url: string | null;
  allowed_domains: string[];
  movie_path_template: string | null;
  series_path_template: string | null;
  episode_path_template: string | null;
  shorthand_episode_template: string | null;
  priority: number;
  timeout_ms: number;
  enabled_regions: string[];
  consent_required: boolean;
  test_title_id: string | null;
  /** jsonb; only `preferred_id` and `start_param` are read today. */
  config?: unknown;
}

/** Allowlist the runtime accepts for `preferredId`. */
export const PREFERRED_ID_VALUES = ['imdb', 'tmdb'] as const;
export type PreferredIdValue = (typeof PREFERRED_ID_VALUES)[number];

/** True when `value` is one of the documented provider-key id styles. */
export function isPreferredIdValue(value: unknown): value is PreferredIdValue {
  return value === 'imdb' || value === 'tmdb';
}

/** Return `row`'s `config` jsonb as a plain record, or `{}` when it is not one. */
function configObject(config: unknown): Record<string, unknown> {
  if (config !== null && typeof config === 'object' && !Array.isArray(config)) {
    return config as Record<string, unknown>;
  }
  return {};
}

/** First non-empty string among `values`, else `undefined`. */
function firstString(...values: Array<string | null | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

/** First non-empty list among `values`, else `[]`. */
function firstList(...values: Array<string[] | undefined>): string[] {
  for (const value of values) {
    if (value && value.length > 0) return value.map((v) => v.trim()).filter(Boolean);
  }
  return [];
}

/**
 * Map one `providers` row into a `ProviderConfig`.
 *
 * @param row  A `providers` row (only the fields in {@link ProviderDbRow}).
 * @param base The built-in config this row overrides (when `row.key` matches a
 *             built-in id). Its values fill any column the row leaves empty and
 *             supply `preferredId`/`startParam` when the row's `config` jsonb
 *             does not mention them. This keeps a row that was auto-created by
 *             a simple enable-toggle from silently dropping the built-in's
 *             documented resume/id preference.
 * @returns A complete `ProviderConfig`, or `null` when the row cannot produce a
 *          functional provider (no usable base URL, or an empty host allowlist
 *          with no built-in to fall back to). Callers skip nulls and log.
 */
export function dbProviderRowToConfig(row: ProviderDbRow, base?: ProviderConfig): ProviderConfig | null {
  const key = row.key.trim();
  if (!key) return null;

  const baseUrl = firstString(row.base_url, base?.baseUrl);
  if (!baseUrl) return null;

  const allowedDomains = firstList(row.allowed_domains, base?.allowedDomains);
  if (allowedDomains.length === 0) return null;

  const cfg = configObject(row.config);
  const preferredIdRaw = cfg.preferred_id;
  const preferredId = isPreferredIdValue(preferredIdRaw)
    ? preferredIdRaw
    : base && isPreferredIdValue(base.preferredId)
      ? base.preferredId
      : undefined;
  const startParam =
    firstString(typeof cfg.start_param === 'string' ? cfg.start_param : undefined, base?.startParam) ?? undefined;

  const name = row.name.trim();
  const moviePath = firstString(row.movie_path_template, base?.moviePathTemplate) ?? '';

  return {
    id: key,
    enabled: row.enabled,
    displayName: name || base?.displayName || key,
    baseUrl,
    allowedDomains,
    // TV route templates default to the movie route when a provider has not
    // documented a distinct series/episode shape — the URL stays inside the
    // allowlisted host and the built-in picker/episode flow still functions.
    moviePathTemplate: moviePath,
    tvSeriesPathTemplate: firstString(row.series_path_template, base?.tvSeriesPathTemplate) ?? moviePath,
    episodePathTemplate: firstString(row.episode_path_template, base?.episodePathTemplate) ?? moviePath,
    shorthandEpisodeTemplate:
      firstString(row.shorthand_episode_template, base?.shorthandEpisodeTemplate) ?? moviePath,
    defaultPriority: row.priority,
    timeoutMs: row.timeout_ms,
    enabledRegions: firstList(row.enabled_regions, base?.enabledRegions).length
      ? firstList(row.enabled_regions, base?.enabledRegions)
      : ['*'],
    consentRequired: row.consent_required,
    testTitleId: firstString(row.test_title_id, base?.testTitleId) ?? '',
    preferredId,
    startParam,
  };
}

/**
 * Build the FINAL ordered provider list for the registry.
 *
 * Merge semantics:
 *   1. Every built-in config starts in the list (keyed by id).
 *   2. Every DB row maps to a config; when its `key` matches a built-in id it
 *      OVERRIDES the built-in, otherwise the provider is ADDED.
 *   3. Rows that cannot map (see {@link dbProviderRowToConfig}) are skipped.
 *   4. The result is sorted by `defaultPriority` descending — the public
 *      "Server 1..N" order the player selector presents.
 *
 * @param builtins The static code-configured providers
 *                 (`PROVIDER_CONFIGS` in config.ts).
 * @param rows     All `providers` rows read from the DB (enabled AND disabled —
 *                 resolvePlayback filters, health checks need disabled adapters).
 */
export function mergeProviderConfigs(
  builtins: readonly ProviderConfig[],
  rows: readonly ProviderDbRow[],
): ProviderConfig[] {
  const baseById = new Map(builtins.map((config) => [config.id, config] as const));
  const merged = new Map<string, ProviderConfig>();

  for (const config of builtins) merged.set(config.id, config);
  for (const row of rows) {
    const mapped = dbProviderRowToConfig(row, baseById.get(row.key));
    if (mapped) merged.set(mapped.id, mapped);
  }

  return [...merged.values()].sort((a, b) => b.defaultPriority - a.defaultPriority);
}
