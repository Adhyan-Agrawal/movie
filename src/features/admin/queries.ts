import 'server-only';

import { getSupabaseServerClient } from '@/lib/supabase/server';
import { repoListTitlesPaged } from '@/features/catalog/repository';
import type { Title, TitleType } from '@/features/catalog/types';
import type { Json } from '@/lib/supabase/types';
import type {
  AdminAccountRow,
  AdminAuditEvent,
  AdminCounts,
  AdminFeatureFlagRow,
  AdminImportRow,
  AdminProviderRow,
  AdminSiteSettingRow,
} from './types';

/**
 * Real admin-console reads (Spec Section 10).
 *
 * Every function here reads the LIVE database through the RLS-scoped server
 * client (anon key + the caller's session) — never the service client. The
 * admin layout already gates console entry behind admin permissions, and RLS
 * policies (accounts_admin_read, audit_logs_admin_read, …) enforce the rest,
 * so these queries simply return whatever the caller is allowed to see. Empty
 * results are honest empty results; nothing here fabricates data.
 *
 * `server-only` guards against this module (and the server Supabase client)
 * being pulled into a client bundle. Client components consume the DTO types
 * from `./types` instead.
 */

/** Render a JSON column (before/after diffs, setting values) for display. */
export function jsonToDisplay(value: Json | null): string | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// Dashboard counts
// ---------------------------------------------------------------------------

export async function getAdminCounts(): Promise<AdminCounts> {
  const db = await getSupabaseServerClient();

  const [titles, titlesPublished, accounts, profiles, playbackSessions] = await Promise.all([
    db.from('titles').select('*', { count: 'exact', head: true }),
    db.from('titles').select('*', { count: 'exact', head: true }).eq('status', 'published'),
    db.from('accounts').select('*', { count: 'exact', head: true }),
    db.from('profiles').select('*', { count: 'exact', head: true }),
    db.from('playback_sessions').select('*', { count: 'exact', head: true }),
  ]);

  const errors = [titles.error, titlesPublished.error, accounts.error, profiles.error, playbackSessions.error].filter(
    (e): e is NonNullable<typeof e> => Boolean(e),
  );
  if (errors.length > 0) {
    throw new Error(`admin counts failed: ${errors.map((e) => e.message).join('; ')}`);
  }

  return {
    titlesTotal: titles.count ?? 0,
    titlesPublished: titlesPublished.count ?? 0,
    accounts: accounts.count ?? 0,
    profiles: profiles.count ?? 0,
    playbackSessions: playbackSessions.count ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Catalog titles
// ---------------------------------------------------------------------------

/** One page of admin-catalog titles plus the exact matching total. */
export interface AdminTitlesPage {
  rows: Title[];
  /** Total rows matching the filters — never capped by a page/range limit. */
  total: number;
}

/**
 * Paged, searchable title listing for the admin catalog (Spec Section 10).
 *
 * Unlike the public catalog queries (which return a single filtered array and
 * would silently truncate at Supabase's default 1,000-row cap), this pages
 * in-DB via `.range()` and returns the exact matching count alongside the page,
 * so the console can show the TRUE total. It still reads through the
 * RLS-scoped server client, and `titles` is queried directly: the admin role
 * holds `catalog.read` (via the titles_editor_read policy), so drafts are
 * included alongside published titles — exactly what RLS allows the caller.
 */
export async function listAdminTitles({
  query,
  page = 1,
  pageSize = 50,
  type,
}: {
  query?: string;
  page?: number;
  pageSize?: number;
  type?: TitleType;
} = {}): Promise<AdminTitlesPage> {
  return repoListTitlesPaged({ query, page, pageSize, type });
}

// ---------------------------------------------------------------------------
// Users (accounts)
// ---------------------------------------------------------------------------

export async function listAdminAccounts(limit = 200): Promise<AdminAccountRow[]> {
  const db = await getSupabaseServerClient();
  const { data, error } = await db
    .from('accounts')
    .select('id, display_name, is_suspended, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`listAdminAccounts failed: ${error.message}`);
  return data ?? [];
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export async function listAuditEvents(limit = 50): Promise<AdminAuditEvent[]> {
  const db = await getSupabaseServerClient();
  const { data, error } = await db
    .from('audit_logs')
    .select('id, actor_account_id, action, entity_type, entity_id, reason, outcome, before, after, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`listAuditEvents failed: ${error.message}`);

  return (data ?? []).map((row) => ({
    id: row.id,
    timestamp: row.created_at,
    action: row.action,
    target: [row.entity_type, row.entity_id].filter(Boolean).join(' ') || '—',
    actor: row.actor_account_id ? `account ${row.actor_account_id.slice(0, 8)}` : 'system',
    outcome: row.outcome,
    before: jsonToDisplay(row.before),
    after: jsonToDisplay(row.after),
    reason: row.reason ?? undefined,
  }));
}

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

export async function listImportJobs(limit = 50): Promise<AdminImportRow[]> {
  const db = await getSupabaseServerClient();
  const { data, error } = await db
    .from('imports')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`listImportJobs failed: ${error.message}`);
  return data ?? [];
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

export async function listProviderRows(): Promise<AdminProviderRow[]> {
  const db = await getSupabaseServerClient();
  const { data, error } = await db.from('providers').select('*').order('priority', { ascending: false });
  if (error) throw new Error(`listProviderRows failed: ${error.message}`);
  return data ?? [];
}

// ---------------------------------------------------------------------------
// Settings + feature flags
// ---------------------------------------------------------------------------

export async function listSiteSettings(): Promise<AdminSiteSettingRow[]> {
  const db = await getSupabaseServerClient();
  const { data, error } = await db.from('site_settings').select('*').order('key');
  if (error) throw new Error(`listSiteSettings failed: ${error.message}`);
  return data ?? [];
}

export async function listFeatureFlags(): Promise<AdminFeatureFlagRow[]> {
  const db = await getSupabaseServerClient();
  const { data, error } = await db.from('feature_flags').select('*').order('key');
  if (error) throw new Error(`listFeatureFlags failed: ${error.message}`);
  return data ?? [];
}

// ---------------------------------------------------------------------------
// Ads
// ---------------------------------------------------------------------------

/** Public ad placements (ad_placements is public-readable when enabled). */
export async function listAdminAdPlacements(limit = 100): Promise<
  Array<{ key: string; name: string; format: string; enabled: boolean }>
> {
  const db = await getSupabaseServerClient();
  const { data, error } = await db
    .from('ad_placements')
    .select('key, name, format, enabled')
    .order('key')
    .limit(limit);
  if (error) throw new Error(`listAdminAdPlacements failed: ${error.message}`);
  return data ?? [];
}
