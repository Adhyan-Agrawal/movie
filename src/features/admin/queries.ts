import 'server-only';

import { getSupabaseServerClient } from '@/lib/supabase/server';
import { repoListTitlesPaged } from '@/features/catalog/repository';
import type { Title, TitleType } from '@/features/catalog/types';
import type { Json } from '@/lib/supabase/types';
import type {
  AdminAccountRow,
  AdminAuditEvent,
  AdminCounts,
  AdminEmailSettings,
  AdminFeatureFlagRow,
  AdminImportRow,
  AdminMediaSourceRow,
  AdminProviderRow,
  AdminSiteSettingRow,
  AdminTitleRequestRow,
  TranscodeCandidate,
} from './types';
import { SMTP_SETTING_KEYS } from './email/mailer';

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
// Media sources (uploads + remote streams)
// ---------------------------------------------------------------------------

/**
 * All media sources attached to a title (every episode slot included), ordered
 * by priority descending — the same order playback resolution considers them
 * in. Read through the RLS-scoped server client: the `media_sources_manage`
 * policy already allows provider.manage holders, so no service key is needed
 * for reads.
 */
export async function listMediaSourcesForTitle(titleId: string): Promise<AdminMediaSourceRow[]> {
  const db = await getSupabaseServerClient();
  const { data, error } = await db
    .from('media_sources')
    .select(
      'id, episode_id, kind, url, reference, label, language, quality, priority, is_default, enabled, consent_required',
    )
    .eq('title_id', titleId)
    .order('priority', { ascending: false })
    .order('created_at', { ascending: true });
  if (error) throw new Error(`listMediaSourcesForTitle failed: ${error.message}`);
  return data ?? [];
}

/**
 * Storage-backed media sources across the catalog, for the HLS transcode
 * console (provider.manage). Remote URL rows have nothing on disk to transcode,
 * so only rows with a non-null `reference` are returned, joined to their title
 * for display. Same RLS-scoped read as the rest of this module.
 */
export async function listTranscodeCandidates(limit = 500): Promise<TranscodeCandidate[]> {
  const db = await getSupabaseServerClient();
  const { data: sources, error } = await db
    .from('media_sources')
    .select('id, title_id, episode_id, kind, reference, label')
    .not('reference', 'is', null)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`listTranscodeCandidates failed: ${error.message}`);

  const storageSources = (sources ?? []).filter(
    (s): s is typeof s & { reference: string } => s.reference !== null,
  );
  const titleIds = [...new Set(storageSources.map((s) => s.title_id))];
  if (titleIds.length === 0) return [];

  const { data: titles, error: titleError } = await db.from('titles').select('id, name, type').in('id', titleIds);
  if (titleError) throw new Error(`listTranscodeCandidates (titles) failed: ${titleError.message}`);

  const titleById = new Map((titles ?? []).map((t) => [t.id, t]));
  return storageSources.flatMap((s) => {
    const title = titleById.get(s.title_id);
    if (!title) return [];
    return [
      {
        sourceId: s.id,
        titleId: s.title_id,
        titleName: title.name,
        titleType: title.type,
        episodeId: s.episode_id,
        kind: s.kind,
        reference: s.reference,
        label: s.label,
      },
    ];
  });
}

/**
 * A single title by id for the admin console (RLS-scoped, so drafts show for
 * catalog holders too). Returns undefined when the id matches nothing.
 */
export async function getAdminTitleById(titleId: string): Promise<Title | undefined> {
  const db = await getSupabaseServerClient();
  const { data, error } = await db.from('titles').select('*').eq('id', titleId).maybeSingle();
  if (error) throw new Error(`getAdminTitleById failed: ${error.message}`);
  return (data as Title | null) ?? undefined;
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
// Title requests
// ---------------------------------------------------------------------------

/**
 * Viewer-submitted title requests (Spec Section 4), newest first.
 *
 * Read through the RLS-scoped server client: the `title_requests_admin_read`
 * policy lets anyone holding `catalog.read` see the whole queue, and the admin
 * console gate already restricts who reaches this route. Viewers only ever see
 * their own rows, but this query is for editors, so it returns the full queue.
 *
 * `title_requests` exists in the DB (migration 0007) but is not yet in the
 * generated Supabase types — cast pragmatically.
 */
export async function listTitleRequests(limit = 200): Promise<AdminTitleRequestRow[]> {
  const db = await getSupabaseServerClient();
  const { data, error } = await (db as any)
    .from('title_requests')
    .select('id, account_id, title_name, media_type, year, note, status, created_at, updated_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`listTitleRequests failed: ${error.message}`);
  return (data ?? []) as AdminTitleRequestRow[];
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

/**
 * SMTP values for the admin email panel, decoded from the `smtp.*` rows in
 * `site_settings` (settings.manage / RLS-scoped read). Port is normalised to a
 * string for the form; the stored password is reduced to a `hasPassword`
 * boolean so the secret never crosses into the client bundle.
 */
export async function getEmailSettings(): Promise<AdminEmailSettings> {
  const db = await getSupabaseServerClient();
  const { data, error } = await db
    .from('site_settings')
    .select('key, value')
    .in('key', Object.values(SMTP_SETTING_KEYS));
  if (error) throw new Error(`getEmailSettings failed: ${error.message}`);

  const values = new Map((data ?? []).map((row) => [row.key, row.value]));
  const str = (key: string): string => {
    const value = values.get(key);
    return typeof value === 'string' ? value : '';
  };

  const portRaw = values.get(SMTP_SETTING_KEYS.port);
  const port = typeof portRaw === 'number' ? String(portRaw) : typeof portRaw === 'string' ? portRaw : '';
  const pass = values.get(SMTP_SETTING_KEYS.pass);

  return {
    host: str(SMTP_SETTING_KEYS.host),
    port,
    user: str(SMTP_SETTING_KEYS.user),
    from: str(SMTP_SETTING_KEYS.from),
    hasPassword: typeof pass === 'string' && pass.length > 0,
  };
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

// ---------------------------------------------------------------------------
// Playback reports (migration 0008)
// ---------------------------------------------------------------------------

/** Client-safe shape for one viewer "Report playback issue" submission. */
export interface AdminPlaybackReport {
  id: string;
  titleId: string;
  titleName?: string;
  serverLabel?: string;
  playerState?: string;
  message?: string;
  hasAccount: boolean;
  createdAt: string;
}

/**
 * Viewer playback reports, newest first, with the public title name resolved.
 * `playback_reports` is admin-read-only (analytics.read RLS) and not yet in the
 * generated types — cast pragmatically, like `listTitleRequests`.
 */
export async function listPlaybackReports(limit = 15): Promise<AdminPlaybackReport[]> {
  const db = await getSupabaseServerClient();
  const { data, error } = await (db as any)
    .from('playback_reports')
    .select('id, title_id, server_label, player_state, message, created_at, account_id')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`listPlaybackReports failed: ${error.message}`);

  const rows = (data ?? []) as Array<{
    id: string;
    title_id: string;
    server_label: string | null;
    player_state: string | null;
    message: string | null;
    created_at: string;
    account_id: string | null;
  }>;
  if (rows.length === 0) return [];

  const ids = [...new Set(rows.map((r) => r.title_id))];
  const nameById = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 100) {
    const part = ids.slice(i, i + 100);
    const { data: titles } = await db.from('titles').select('id, name').in('id', part);
    for (const t of titles ?? []) nameById.set(t.id, t.name);
  }

  return rows.map((r) => ({
    id: r.id,
    titleId: r.title_id,
    ...(nameById.get(r.title_id) ? { titleName: nameById.get(r.title_id) } : {}),
    ...(r.server_label ? { serverLabel: r.server_label } : {}),
    ...(r.player_state ? { playerState: r.player_state } : {}),
    ...(r.message ? { message: r.message } : {}),
    hasAccount: r.account_id != null,
    createdAt: r.created_at,
  }));
}
