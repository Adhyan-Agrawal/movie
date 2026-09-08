'use server';

import { revalidatePath } from 'next/cache';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import type { Database, Json, SourceHealthEnum } from '@/lib/supabase/types';
import { requirePermission } from '@/lib/permissions/check';
import { PERMISSIONS } from '@/lib/permissions/permissions';
import { getProviderConfig, type ProviderConfig } from '@/lib/providers/config';
import { getAdapter, refreshProviderRegistry } from '@/lib/providers/registry';
import type { HealthResult } from '@/lib/providers/types';

/**
 * Admin provider actions (Spec Sections 9, 10): enable/disable persistence,
 * on-demand health probes, and full CRUD for operator-added IFRAME providers.
 * Gated server-side by provider.manage — the same key as the providers_manage
 * RLS policy — and written through the RLS-scoped server client, so every
 * change is attributable to the signed-in admin.
 *
 * The DB row drives enablement and (once it exists) the provider's config:
 * toggling a provider that has no row yet creates one from its built-in config
 * (src/lib/providers/config.ts), so built-in cards and DB rows share one source
 * of truth. The playback registry reads `providers` with the SERVICE client
 * (anonymous viewers bypass RLS), so after any write here the in-process
 * registry is force-refreshed to keep getAdapter() / resolvePlayback() on the
 * final merged list immediately.
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
  config?: Json;
}

/** `config` jsonb derived from a built-in config (preferred id + resume param). */
function configJsonFromProviderConfig(config?: ProviderConfig): Json {
  const out: Record<string, string> = {};
  if (config?.preferredId) out.preferred_id = config.preferredId;
  if (config?.startParam) out.start_param = config.startParam;
  return out as Json;
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
        config: configJsonFromProviderConfig(config),
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

  // The new/updated row must drive playback + the next health probe immediately.
  await refreshProviderRegistry();

  return { ok: true };
}

/**
 * Run the adapter's live health probe for a provider and persist the mapped
 * status in providers.health. The full result (status, latency, checkedAt) is
 * returned to the UI — the table has no latency/checked-at columns.
 *
 * The registry is force-refreshed FIRST so the probe targets the FINAL merged
 * config for the key — a DB override's base URL / timeout, or a brand-new
 * custom provider the admin just saved.
 */
export async function runProviderHealthAction(providerId: string): Promise<ProviderActionResult> {
  const denied = await ensurePermission();
  if (denied) return { ok: false, error: denied };

  const key = providerId.trim();
  await refreshProviderRegistry();

  const adapter = getAdapter(key);
  if (!adapter) return { ok: false, error: 'Unknown provider.' };

  const result = await adapter.healthCheck();

  const persisted = await upsertProviderRow({ key, health: toStoredHealth(result.status) });
  if (persisted.error) return { ok: false, error: `Could not store the health result: ${persisted.error}` };

  return { ok: true, result };
}

// ---------------------------------------------------------------------------
// Full provider editor (add custom + edit any provider's DB row)
// ---------------------------------------------------------------------------

/** Serializable payload from the /admin/providers editor form. */
export interface ProviderSaveInput {
  /** Machine id — the registry key. Lowercased before persistence. */
  key: string;
  name: string;
  baseUrl: string;
  allowedDomains: string[];
  moviePathTemplate: string;
  tvSeriesPathTemplate: string;
  episodePathTemplate: string;
  shorthandEpisodeTemplate: string;
  priority: number;
  consentRequired: boolean;
  enabled: boolean;
  /** Provider's preferred media-id style: '' (unspecified), 'imdb', or 'tmdb'. */
  preferredId?: 'imdb' | 'tmdb' | '';
  /** Query param the embed accepts to resume at a position (e.g. "startAt"). */
  startParam?: string;
}

/** Strip a template down to its non-placeholder text and flag any stray braces. */
function templateHasForeignBraces(template: string): boolean {
  return /[{}]/.test(template.replace(/\{(?:id|season|episode)\}/g, ''));
}

/** Normalize a host list: allow scheme/path input, keep bare lowercased hosts. */
function normalizeDomains(domains: string[]): string[] {
  const out: string[] = [];
  for (const raw of domains) {
    let value = raw.trim().toLowerCase();
    if (!value) continue;
    if (value.includes('://')) {
      try {
        value = new URL(value).host;
      } catch {
        // leave as-is; the host allowlist below will simply not match it.
      }
    }
    value = value.replace(/^\.+/, '').replace(/[/?#].*$/, '');
    if (value && !out.includes(value)) out.push(value);
  }
  return out;
}

/** Validate the editor payload; returns a renderable error string or null. */
function validateProviderInput(input: ProviderSaveInput): string | null {
  const key = input.key.trim().toLowerCase();
  if (!key) return 'A provider key is required.';
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(key)) {
    return 'The provider key must start with a letter or digit and use only a-z, 0-9, ".", "_", or "-".';
  }
  if (!input.name.trim()) return 'A display name is required.';

  let base: URL;
  try {
    base = new URL(input.baseUrl.trim());
  } catch {
    return 'The base URL must be a valid absolute URL, e.g. https://example.com.';
  }
  if (base.protocol !== 'https:') return 'The base URL must use https.';

  const templates: Array<[string, string]> = [
    ['movie path template', input.moviePathTemplate],
    ['series path template', input.tvSeriesPathTemplate],
    ['episode path template', input.episodePathTemplate],
    ['shorthand episode template', input.shorthandEpisodeTemplate],
  ];
  for (const [label, template] of templates) {
    if (!template.trim()) return `The ${label} is required (use {id}, {season}, {episode}).`;
    if (templateHasForeignBraces(template.trim())) {
      return `The ${label} contains an unsupported placeholder. Only {id}, {season}, and {episode} are allowed.`;
    }
  }

  if (!Number.isInteger(input.priority)) return 'Priority must be a whole number.';
  if (input.preferredId && input.preferredId !== 'imdb' && input.preferredId !== 'tmdb') {
    return 'preferred_id must be imdb, tmdb, or blank.';
  }
  return null;
}

/**
 * Upsert a provider row from the editor form, creating it when the key has no
 * row yet. Editing a built-in provider writes/creates its DB row, which then
 * OVERRIDES the built-in config for playback (see registry.ts).
 */
export async function saveProviderAction(input: ProviderSaveInput): Promise<ProviderActionResult> {
  const denied = await ensurePermission();
  if (denied) return { ok: false, error: denied };

  const key = input.key.trim().toLowerCase();
  const validationError = validateProviderInput({ ...input, key });
  if (validationError) return { ok: false, error: validationError };

  const db = await getSupabaseServerClient();
  const config = getProviderConfig(key); // built-in defaults for a fresh row
  const base = new URL(input.baseUrl.trim());
  const domains = normalizeDomains(input.allowedDomains);
  const allowedDomains = domains.length > 0 ? domains : [base.hostname];
  const now = new Date().toISOString();

  // `config` jsonb carries the two editor fields with no dedicated column.
  const editorConfig: Record<string, string> = {};
  if (input.preferredId) editorConfig.preferred_id = input.preferredId;
  if (input.startParam?.trim()) editorConfig.start_param = input.startParam.trim();

  const { data: user } = await db.auth.getUser();
  const { data: existing } = await db.from('providers').select('id, config').eq('key', key).maybeSingle();

  if (existing) {
    // Merge into the stored jsonb so an edit never drops keys other tooling set.
    const stored =
      existing.config && typeof existing.config === 'object' && !Array.isArray(existing.config)
        ? (existing.config as Record<string, unknown>)
        : {};
    const { error } = await db.from('providers').update({
      name: input.name.trim(),
      base_url: base.origin,
      allowed_domains: allowedDomains,
      movie_path_template: input.moviePathTemplate.trim(),
      series_path_template: input.tvSeriesPathTemplate.trim(),
      episode_path_template: input.episodePathTemplate.trim(),
      shorthand_episode_template: input.shorthandEpisodeTemplate.trim(),
      priority: input.priority,
      consent_required: input.consentRequired,
      enabled: input.enabled,
      config: { ...stored, ...editorConfig } as Json,
      updated_at: now,
    }).eq('key', key);
    if (error) return { ok: false, error: `Could not save the provider: ${error.message}` };
  } else {
    const { error } = await db.from('providers').insert({
      key,
      name: input.name.trim(),
      adapter: 'generic',
      enabled: input.enabled,
      health: 'unknown',
      base_url: base.origin,
      allowed_domains: allowedDomains,
      movie_path_template: input.moviePathTemplate.trim(),
      series_path_template: input.tvSeriesPathTemplate.trim(),
      episode_path_template: input.episodePathTemplate.trim(),
      shorthand_episode_template: input.shorthandEpisodeTemplate.trim(),
      priority: input.priority,
      timeout_ms: config?.timeoutMs ?? 8000,
      enabled_regions: config?.enabledRegions ?? ['*'],
      consent_required: input.consentRequired,
      test_title_id: config?.testTitleId ?? null,
      config: editorConfig as Json,
      created_by: user.user?.id ?? null,
      updated_at: now,
    });
    if (error) return { ok: false, error: `Could not save the provider: ${error.message}` };
  }

  // The saved row must drive the merged registry immediately (playback + probes).
  await refreshProviderRegistry();
  revalidatePath('/admin/providers');
  return { ok: true };
}
