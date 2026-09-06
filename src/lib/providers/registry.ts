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
import { type ProviderConfig, VIDSRC_PROVIDER_CONFIG } from './config';
import { createVidsrcAdapter } from './vidsrc';

interface RegistryEntry {
  config: ProviderConfig;
  adapter: ProviderAdapter;
}

const REGISTRY: readonly RegistryEntry[] = [
  { config: VIDSRC_PROVIDER_CONFIG, adapter: createVidsrcAdapter(VIDSRC_PROVIDER_CONFIG) },
];

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
 * Resolve a sanitized playback source for a request. Never throws — every
 * failure is normalized into `error` so the player can render an honest
 * unavailable/blocked state with retry.
 */
export async function resolvePlayback(request: PlaybackRequest): Promise<ResolvedPlayback> {
  const entries = REGISTRY.filter((entry) => entry.config.enabled).sort(
    (a, b) => b.config.defaultPriority - a.config.defaultPriority,
  );

  const attempted: string[] = [];
  let lastError: PlaybackError | null = null;

  for (const entry of entries) {
    attempted.push(entry.config.id);
    try {
      const sources = await entry.adapter.resolve(request);
      if (sources.length > 0) {
        const best = sources[0]!;
        return { source: best, sources, error: null, providerId: entry.config.id, attempted };
      }
      // Provider is enabled but produced no source (e.g. unsupported request).
      lastError = {
        code: 'not-found',
        message: 'No authorized source is available from this provider.',
        recoverable: true,
        providerId: entry.config.id,
      };
    } catch (error) {
      lastError = entry.adapter.normalizeError(error);
    }
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
