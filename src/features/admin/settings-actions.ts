'use server';

import { getSupabaseServerClient, type SupabaseServerClient } from '@/lib/supabase/server';
import type { Json } from '@/lib/supabase/types';
import { requirePermission } from '@/lib/permissions/check';
import { PERMISSIONS } from '@/lib/permissions/permissions';
import { jsonValueSchema } from '@/lib/validation/settings';
import { GENERIC_SITE_SETTING_KEYS } from './setting-keys';

/**
 * Admin settings + feature-flag actions (Spec Section 10). Gated server-side
 * by settings.manage — the same key as the site_settings_admin_write and
 * feature_flags_admin_write RLS policies — and written through the RLS-scoped
 * server client, so every change is attributable to the signed-in admin.
 *
 * The generic editor accepts only explicitly registered public setting keys.
 * SMTP, private settings and specialized commerce settings must use their own
 * panels and validation; is_public alone is not permission to edit a key here.
 */

/** Uniform action result — honest, renderable errors for the admin UI. */
export interface SettingsActionResult {
  ok: boolean;
  error?: string;
}

const PERMISSION_ERROR = 'You need the settings.manage permission to edit settings.';

/** Permission gate: every exported action calls this first. */
async function ensurePermission(): Promise<string | null> {
  try {
    await requirePermission(PERMISSIONS.SETTINGS_MANAGE);
    return null;
  } catch {
    return PERMISSION_ERROR;
  }
}

/** Resolve the signed-in admin's account id (accounts.id), if any. */
async function actorId(db: SupabaseServerClient): Promise<string | null> {
  const { data } = await db.auth.getUser();
  return data.user?.id ?? null;
}

/**
 * Update (or create, if missing) an allowlisted public site setting by key.
 * Update-then-insert rather than a blanket upsert, so the write never clobbers
 * the `is_public` / `description` columns with their defaults.
 */
export async function updateSiteSettingAction(key: string, value: Json): Promise<SettingsActionResult> {
  const denied = await ensurePermission();
  if (denied) return { ok: false, error: denied };

  if (typeof key !== 'string' || !GENERIC_SITE_SETTING_KEYS.includes(key)) {
    return { ok: false, error: 'This setting is not editable here. Use its dedicated settings panel.' };
  }
  const parsed = jsonValueSchema.safeParse(value);
  if (!parsed.success) return { ok: false, error: 'The setting value must be valid JSON.' };

  const db = await getSupabaseServerClient();
  // Read metadata only, never the previous value (which could be private).
  const { data: existing, error: readError } = await db
    .from('site_settings')
    .select('key, is_public')
    .eq('key', key)
    .maybeSingle();
  if (readError) return { ok: false, error: 'Could not check the setting. Nothing was saved.' };
  if (existing && !existing.is_public) {
    return { ok: false, error: 'Private settings cannot be edited here. Use their dedicated settings panel.' };
  }

  const updatedBy = await actorId(db);
  const now = new Date().toISOString();
  if (existing) {
    const { data: saved, error } = await db
      .from('site_settings')
      .update({ value: parsed.data, updated_by: updatedBy, updated_at: now })
      .eq('key', key)
      .eq('is_public', true)
      .select('key')
      .maybeSingle();
    if (error || !saved) return { ok: false, error: 'Could not save the setting. Refresh and try again.' };
  } else {
    const { error } = await db
      .from('site_settings')
      .insert({ key, value: parsed.data, is_public: true, updated_by: updatedBy, updated_at: now });
    if (error) return { ok: false, error: 'Could not save the setting. Refresh and try again.' };
  }

  return { ok: true };
}

/** Toggle a feature flag on/off by name, updating the audit trail fields. */
export async function updateFeatureFlagAction(name: string, enabled: boolean): Promise<SettingsActionResult> {
  const denied = await ensurePermission();
  if (denied) return { ok: false, error: denied };

  const flagName = name.trim();
  if (!flagName) return { ok: false, error: 'A flag name is required.' };

  const db = await getSupabaseServerClient();
  const updatedBy = await actorId(db);
  const now = new Date().toISOString();

  const { data: existing } = await db.from('feature_flags').select('key').eq('key', flagName).maybeSingle();
  if (existing) {
    const { error } = await db
      .from('feature_flags')
      .update({ enabled, updated_by: updatedBy, updated_at: now })
      .eq('key', flagName);
    if (error) return { ok: false, error: `Could not update the flag: ${error.message}` };
  } else {
    const { error } = await db
      .from('feature_flags')
      .insert({ key: flagName, enabled, updated_by: updatedBy, updated_at: now });
    if (error) return { ok: false, error: `Could not update the flag: ${error.message}` };
  }

  return { ok: true };
}
