import type { Tables } from '@/lib/supabase/types';
import type { TitleType } from '@/features/catalog/types';

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

/**
 * A `title_requests` row (viewer-submitted). Manual shape — the table exists in
 * the DB (migration 0007) but the generated Supabase types haven't caught up
 * yet, so reads/updates cast `as any` and this DTO carries the columns the
 * admin queue needs.
 */
export type TitleRequestStatus = 'pending' | 'imported' | 'rejected';

export interface AdminTitleRequestRow {
  id: string;
  /** The requesting account (RLS scopes viewer rows to it; editors read all). */
  account_id: string;
  title_name: string;
  media_type: 'movie' | 'tv';
  /** Release year hint (optional). */
  year: number | null;
  /** Free-text note from the viewer (optional). */
  note: string | null;
  status: TitleRequestStatus;
  created_at: string;
  updated_at: string;
}

/**
 * A storage-backed media source eligible for HLS transcoding (provider.manage).
 * Only rows whose `reference` points at an object in the private `media` bucket
 * qualify — remote URL rows have nothing on disk to transcode.
 */
export interface TranscodeCandidate {
  sourceId: string;
  titleId: string;
  titleName: string;
  titleType: TitleType;
  episodeId: string | null;
  kind: Tables<'media_sources'>['kind'];
  reference: string;
  label: string;
}

/** A `site_settings` row (settings.manage / is_public). */
export type AdminSiteSettingRow = Tables<'site_settings'>;

/**
 * SMTP values for the admin email panel (settings.manage). The stored password
 * is write-only and NEVER crosses to the client — the panel only learns
 * whether one exists so it can hint "leave blank to keep existing".
 */
export interface AdminEmailSettings {
  host: string;
  port: string;
  user: string;
  from: string;
  hasPassword: boolean;
}

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
