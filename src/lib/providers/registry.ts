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
 * registry reads the live `providers` rows through the SERVICE client
 * (`getSupabaseServiceClient`). RLS restricts `providers` to `provider.manage`
 * holders, so anonymous-viewer playback resolution cannot use the RLS-scoped
 * client — it reads with the service role and merges the rows into the built-in
 * list via `mergeProviderConfigs` (src/lib/providers/db-providers.ts). A DB row
 * whose `key` matches a built-in OVERRIDES it; extra rows are ADDED; the final
 * list is sorted by priority descending. The read is best-effort: any failure
 * falls back to the static built-ins and is logged, never thrown.
 *
 * Source selection considers priority and per-adapter success; language,
 * quality, region, and viewer preference weighting are TODO hooks for when more
 * providers and real source metadata exist (Spec Section 9).
 */

import type { PlaybackError, PlaybackRequest, PlaybackSource, ProviderAdapter } from './types';
import { PROVIDER_CONFIGS, type ProviderConfig } from './config';
import { createVidsrcAdapter } from './vidsrc';
import { mergeProviderConfigs, type ProviderDbRow } from './db-providers';
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
const BUILTIN_ENTRIES: readonly RegistryEntry[] = PROVIDER_CONFIGS.map((config) => ({
  config,
  adapter: createVidsrcAdapter(config),
}));

/**
 * The current merged registry. Starts as the static built-ins and is replaced
 * by {@link refreshProviderRegistry} whenever playback is resolved (DB rows
 * override/add built-ins). Kept mutable so the synchronous {@link getAdapter}
 * and {@link getActiveProviderConfigs} see the same final list `resolvePlayback`
 * used, without changing their signatures.
 */
let mergedEntries: RegistryEntry[] = [...BUILTIN_ENTRIES];

/**
 * (Re)load the `providers` rows and merge them into the built-in configs.
 *
 * Best-effort by design: playback must never fail because the providers table
 * is unreachable. On ANY error the registry falls back to the static
 * `PROVIDER_CONFIGS` and logs; the caller still gets a working (built-in-only)
 * resolution. No-ops when Supabase is not configured.
 */
export async function refreshProviderRegistry(): Promise<void> {
  if (!features.supabaseConfigured) return;
  try {
    const db = getSupabaseServiceClient();
    const { data, error } = await db.from('providers').select('*');
    if (error) throw new Error(error.message);
    const configs = mergeProviderConfigs(PROVIDER_CONFIGS, (data ?? []) as ProviderDbRow[]);
    mergedEntries = configs.map((config) => ({ config, adapter: createVidsrcAdapter(config) }));
  } catch (error) {
    mergedEntries = [...BUILTIN_ENTRIES];
    console.error('providers.registry.mergeFailed', {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/** The current final provider configs (built-ins merged/overridden by DB rows). */
export function getActiveProviderConfigs(): readonly ProviderConfig[] {
  return mergedEntries.map((entry) => entry.config);
}

export function getAdapter(id: string): ProviderAdapter | undefined {
  return mergedEntries.find((entry) => entry.config.id === id)?.adapter;
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
  await refreshProviderRegistry();

  const entries = mergedEntries
    .filter((entry) => entry.config.enabled)
    .sort((a, b) => b.config.defaultPriority - a.config.defaultPriority);

  const attempted: string[] = [];
  const collected: PlaybackSource[] = [];
  let lastError: PlaybackError | null = null;

  for (const entry of entries) {
    attempted.push(entry.config.id);
    try {
      const sources = await entry.adapter.resolve(request);
      if (sources.length > 0) {
        collected.push(...sources);
      } else {
        // Provider is enabled but produced no source (e.g. unsupported request).
        lastError = {
          code: 'not-found',
          message: 'No authorized source is available from this provider.',
          recoverable: true,
          providerId: entry.config.id,
        };
      }
    } catch (error) {
      lastError = entry.adapter.normalizeError(error);
    }
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
