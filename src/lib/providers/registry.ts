/**
 * Provider registry + source selection (Spec Section 9).
 *
 * Maps provider id -> adapter and resolves a request by trying enabled
 * providers in priority order (highest `defaultPriority` first), returning the
 * first sanitized source. Only Vidsrc exists today, but the shape is ready for
 * additional providers, health-aware selection, and circuit breaking.
 *
 * Source selection considers priority and per-adapter success; language,
 * quality, region, and viewer preference weighting are TODO hooks for when more
 * providers and real source metadata exist (Spec Section 9).
 */

import type { PlaybackError, PlaybackRequest, PlaybackSource, ProviderAdapter } from './types';
import { type ProviderConfig, PROVIDER_CONFIGS } from './config';
import { createVidsrcAdapter } from './vidsrc';

interface RegistryEntry {
  config: ProviderConfig;
  adapter: ProviderAdapter;
}

/**
 * All adapters are built from the same template-driven embed adapter today —
 * the differences between providers are entirely configuration (domains, path
 * templates, priorities).
 */
const REGISTRY: readonly RegistryEntry[] = PROVIDER_CONFIGS.map((config) => ({
  config,
  adapter: createVidsrcAdapter(config),
}));

export function getAdapter(id: string): ProviderAdapter | undefined {
  return REGISTRY.find((entry) => entry.config.id === id)?.adapter;
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
 * Every enabled provider is attempted (in priority order) and its best source
 * is collected, so the player's source selector offers one entry per provider
 * ("Server 1..N" in priority order). `source` is the highest-priority success;
 * a provider that fails simply contributes no source — the viewer can still
 * switch to the others.
 */
export async function resolvePlayback(request: PlaybackRequest): Promise<ResolvedPlayback> {
  const entries = REGISTRY.filter((entry) => entry.config.enabled).sort(
    (a, b) => b.config.defaultPriority - a.config.defaultPriority,
  );

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
