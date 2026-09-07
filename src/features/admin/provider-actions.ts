'use server';

import { getSupabaseServerClient } from '@/lib/supabase/server';
import type { Database, SourceHealthEnum } from '@/lib/supabase/types';
import { requirePermission } from '@/lib/permissions/check';
import { PERMISSIONS } from '@/lib/permissions/permissions';
import { getProviderConfig, type ProviderConfig } from '@/lib/providers/config';
import { getAdapter } from '@/lib/providers/registry';
import type { HealthResult } from '@/lib/providers/types';

/**
 * Admin provider actions (Spec Sections 9, 10): enable/disable persistence and
 * on-demand health probes. Gated server-side by provider.manage — the same key
 * as the providers_manage RLS policy — and written through the RLS-scoped
 * server client, so every change is attributable to the signed-in admin.
 *
 * The DB row drives enablement: toggling a provider that has no row yet
 * creates one from its built-in config (src/lib/providers/config.ts), so
 * built-in cards and DB rows share one source of truth.
 */

/** Uniform action result — honest, renderable errors for the admin UI. */
export interface ProviderActionResult {
  ok: boolean;
  error?: string;
  /** Fresh probe result from runProviderHealthAction, for live display. */
  result?: HealthResult;
}

const PERMISSION_ERROR = 'You need the provider.manage permission to manage providers.';

/** Permission gate: every exported action calls this first. */
async function ensurePermission(): Promise<string | null> {
  try {
    await requirePermission(PERMISSIONS.PROVIDER_MANAGE);
    return null;
  } catch {
    return PERMISSION_ERROR;
  }
}

/**
 * Map a probe status onto the providers.health enum (source_health has no
 * `disabled` / `unavailable` members, so they collapse to unknown/down).
 */
function toStoredHealth(status: HealthResult['status']): SourceHealthEnum {
  switch (status) {
    case 'healthy':
      return 'healthy';
    case 'degraded':
      return 'degraded';
    case 'unavailable':
      return 'down';
    default:
      return 'unknown';
  }
}

/** Columns a new providers row is seeded with from the built-in config. */
interface ProviderRowColumns {
  name: string;
  adapter?: string;
  base_url?: string | null;
  allowed_domains?: string[];
  movie_path_template?: string | null;
  series_path_template?: string | null;
  episode_path_template?: string | null;
  shorthand_episode_template?: string | null;
  priority?: number;
  timeout_ms?: number;
  enabled_regions?: string[];
  consent_required?: boolean;
  test_title_id?: string | null;
}

function configColumns(config: ProviderConfig | undefined, name: string): ProviderRowColumns {
  return config
    ? {
        name,
        adapter: 'generic',
        base_url: config.baseUrl,
        allowed_domains: config.allowedDomains,
        movie_path_template: config.moviePathTemplate,
        series_path_template: config.tvSeriesPathTemplate,
        episode_path_template: config.episodePathTemplate,
        shorthand_episode_template: config.shorthandEpisodeTemplate,
        priority: config.defaultPriority,
        timeout_ms: config.timeoutMs,
        enabled_regions: config.enabledRegions,
        consent_required: config.consentRequired,
        test_title_id: config.testTitleId,
      }
    : { name };
}

/**
 * Patch a providers row by key, creating it from the built-in config when it
 * does not exist yet. Only the fields provided are changed on an existing row
 * — a health check never clobbers the stored `enabled` state and a toggle
 * never clobbers the stored `health`.
 */
async function upsertProviderRow(input: {
  key: string;
  enabled?: boolean;
  health?: SourceHealthEnum;
}): Promise<{ error?: string }> {
  const db = await getSupabaseServerClient();
  const config = getProviderConfig(input.key);
  const { data: user } = await db.auth.getUser();
  const now = new Date().toISOString();

  const { data: existing } = await db.from('providers').select('id').eq('key', input.key).maybeSingle();
  if (existing) {
    const patch: Database['public']['Tables']['providers']['Update'] = { updated_at: now };
    if (input.enabled !== undefined) patch.enabled = input.enabled;
    if (input.health !== undefined) patch.health = input.health;
    const { error } = await db.from('providers').update(patch).eq('key', input.key);
    if (error) return { error: error.message };
  } else {
    const { error } = await db.from('providers').insert({
      key: input.key,
      enabled: input.enabled ?? config?.enabled ?? true,
      health: input.health ?? 'unknown',
      ...configColumns(config, config?.displayName ?? input.key),
      created_by: user.user?.id ?? null,
      updated_at: now,
    });
    if (error) return { error: error.message };
  }
  return {};
}

/** Enable or disable a provider, persisted in the providers table. */
export async function setProviderEnabledAction(providerId: string, enabled: boolean): Promise<ProviderActionResult> {
  const denied = await ensurePermission();
  if (denied) return { ok: false, error: denied };

  const key = providerId.trim();
  if (!key) return { ok: false, error: 'A provider id is required.' };

  const result = await upsertProviderRow({ key, enabled });
  if (result.error) return { ok: false, error: `Could not update the provider: ${result.error}` };

  return { ok: true };
}

/**
 * Run the adapter's live health probe for a provider and persist the mapped
 * status in providers.health. The full result (status, latency, checkedAt) is
 * returned to the UI — the table has no latency/checked-at columns.
 */
export async function runProviderHealthAction(providerId: string): Promise<ProviderActionResult> {
  const denied = await ensurePermission();
  if (denied) return { ok: false, error: denied };

  const key = providerId.trim();
  const adapter = getAdapter(key);
  if (!adapter) return { ok: false, error: 'Unknown provider.' };

  const result = await adapter.healthCheck();

  const persisted = await upsertProviderRow({ key, health: toStoredHealth(result.status) });
  if (persisted.error) return { ok: false, error: `Could not store the health result: ${persisted.error}` };

  return { ok: true, result };
}
