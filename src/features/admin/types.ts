import type { Tables } from '@/lib/supabase/types';

/**
 * Client-safe DTO types for the admin console (Spec Section 10).
 *
 * Type-only module: safe to import from both Server and Client Components.
 * The actual DB reads live in `./queries` (server-only); these shapes are what
 * crosses the server/client boundary.
 */

/** An `accounts` row, restricted to the support-safe columns (users.read). */
export type AdminAccountRow = Pick<
  Tables<'accounts'>,
  'id' | 'display_name' | 'is_suspended' | 'created_at'
>;

/** A `providers` row (provider.manage). */
export type AdminProviderRow = Tables<'providers'>;

/**
 * A `media_sources` row, restricted to the columns the admin sources UI needs
 * (provider.manage). Raw URLs/references never leave the admin surface.
 */
export type AdminMediaSourceRow = Pick<
  Tables<'media_sources'>,
  'id' | 'episode_id' | 'kind' | 'url' | 'reference' | 'label' | 'language' | 'quality' | 'priority' | 'is_default' | 'enabled' | 'consent_required'
>;

/** An `imports` row (catalog.create). */
export type AdminImportRow = Tables<'imports'>;

/** A `site_settings` row (settings.manage / is_public). */
export type AdminSiteSettingRow = Tables<'site_settings'>;

/** A `feature_flags` row (settings.manage / is_public). */
export type AdminFeatureFlagRow = Tables<'feature_flags'>;

/** `audit_logs.outcome` enum — the DB records success/failure only. */
export type AuditOutcome = 'success' | 'failure';

/** Display-ready audit event mapped from an `audit_logs` row (audit.read). */
export interface AdminAuditEvent {
  id: string;
  /** ISO timestamp (created_at). */
  timestamp: string;
  action: string;
  /** Human label for entity_type + entity_id. */
  target: string;
  /** Actor label — account id (shortened) or "system". */
  actor: string;
  outcome: AuditOutcome;
  before?: string;
  after?: string;
  reason?: string;
}

/** Live dashboard totals (Section 10 — honest counts, no deltas yet). */
export interface AdminCounts {
  titlesTotal: number;
  titlesPublished: number;
  accounts: number;
  profiles: number;
  playbackSessions: number;
}
