import type { Title } from '@/features/catalog/types';

/**
 * Admin CMS mock operations data (Spec Section 10, 7, 9).
 *
 * This is the "graceful degradation" default so the console is fully runnable
 * before Supabase/analytics are wired. Nothing here contains real secrets or
 * service-role data — these are client-safe DTOs (Section 6). Once repositories
 * exist, swap the exported constants for repository-backed reads; consumers
 * (components/routes) keep the same shapes.
 */

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

export type HealthStatus = 'ok' | 'degraded' | 'down';
export type Outcome = 'success' | 'failure' | 'pending';

/** All dashboard time-series are reported in this zone (shown as a note). */
export const REPORTING_TIMEZONE = 'UTC';

/** Deterministic string hash for stable pseudo-random mock derivations. */
function hash(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i += 1) h = (h * 31 + input.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** Mask an email for support-safe display (Section 10 "safe metadata"). */
export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return '•••';
  const head = local.slice(0, 1);
  return `${head}${'•'.repeat(Math.max(3, local.length - 1))}@${domain}`;
}

/** Compact number formatting for dense tiles (1_234 -> "1.2k"). */
export function formatCompact(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${value}`;
}

// ---------------------------------------------------------------------------
// Dashboard KPIs (Section 10 "Dashboard")
// ---------------------------------------------------------------------------

export interface KpiMetric {
  id: string;
  label: string;
  /** Pre-formatted display value. */
  value: string;
  /** Signed percent change vs. the comparison window. */
  deltaPct: number;
  /** Which direction is a positive outcome for this metric. */
  goodDirection: 'up' | 'down';
  /** e.g. "vs. previous 7 days". */
  comparison: string;
  /** Sparkline series (oldest -> newest). */
  spark: number[];
  /** Plain-language definition (Section 10 "definitions"). */
  definition: string;
}

export const KPI_METRICS: KpiMetric[] = [
  {
    id: 'users',
    label: 'Registered users',
    value: '18,204',
    deltaPct: 4.1,
    goodDirection: 'up',
    comparison: 'vs. previous 7 days',
    spark: [17100, 17240, 17390, 17610, 17820, 17980, 18110, 18204],
    definition: 'Distinct accounts with at least one verified profile.',
  },
  {
    id: 'guests',
    label: 'Guests (24h)',
    value: '3,472',
    deltaPct: 8.6,
    goodDirection: 'up',
    comparison: 'vs. previous day',
    spark: [2600, 2720, 2910, 3050, 3180, 3260, 3390, 3472],
    definition: 'Unauthenticated sessions where guest browsing is enabled.',
  },
  {
    id: 'active-streams',
    label: 'Active streams',
    value: '412',
    deltaPct: 2.3,
    goodDirection: 'up',
    comparison: 'live, last 5 min',
    spark: [360, 372, 388, 395, 401, 405, 409, 412],
    definition: 'Playback sessions with a heartbeat inside the last 5 minutes.',
  },
  {
    id: 'views',
    label: 'Views (7d)',
    value: '96.4k',
    deltaPct: 6.2,
    goodDirection: 'up',
    comparison: 'vs. previous 7 days',
    spark: [12100, 12800, 13100, 13600, 14200, 13900, 14600, 12100],
    definition: 'Title-open events, de-duplicated per profile per hour.',
  },
  {
    id: 'watch-hours',
    label: 'Watch hours (7d)',
    value: '41.9k',
    deltaPct: 3.4,
    goodDirection: 'up',
    comparison: 'vs. previous 7 days',
    spark: [5200, 5600, 5900, 6100, 6000, 6300, 6500, 6300],
    definition: 'Summed heartbeat duration across completed and in-progress sessions.',
  },
  {
    id: 'ad-events',
    label: 'Ad events (7d)',
    value: '58.1k',
    deltaPct: 1.1,
    goodDirection: 'up',
    comparison: 'vs. previous 7 days',
    spark: [7600, 7800, 8100, 8000, 8300, 8250, 8400, 8300],
    definition: 'Impression + click events across enabled placements (consented).',
  },
  {
    id: 'error-rate',
    label: 'Playback error rate',
    value: '1.8%',
    deltaPct: -0.6,
    goodDirection: 'down',
    comparison: 'vs. previous 7 days',
    spark: [2.6, 2.4, 2.5, 2.2, 2.1, 1.9, 1.9, 1.8],
    definition: 'Share of play attempts ending in a provider or network error.',
  },
  {
    id: 'email-delivery',
    label: 'Email delivery',
    value: '99.2%',
    deltaPct: 0.3,
    goodDirection: 'up',
    comparison: 'vs. previous 7 days',
    spark: [98.4, 98.6, 98.9, 99.0, 99.1, 99.0, 99.2, 99.2],
    definition: 'Delivered / accepted transactional email over the window.',
  },
];

/** Daily view volume for the dashboard trend chart (oldest -> newest). */
export interface TimePoint {
  label: string;
  value: number;
}

export const VIEWS_BY_DAY: TimePoint[] = [
  { label: 'Aug 22', value: 11800 },
  { label: 'Aug 23', value: 12400 },
  { label: 'Aug 24', value: 13950 },
  { label: 'Aug 25', value: 12100 },
  { label: 'Aug 26', value: 12680 },
  { label: 'Aug 27', value: 13720 },
  { label: 'Aug 28', value: 15010 },
  { label: 'Aug 29', value: 14260 },
  { label: 'Aug 30', value: 13180 },
  { label: 'Aug 31', value: 13640 },
  { label: 'Sep 01', value: 14880 },
  { label: 'Sep 02', value: 15620 },
  { label: 'Sep 03', value: 16040 },
  { label: 'Sep 04', value: 9210 },
];

export interface TopTitle {
  id: string;
  name: string;
  type: 'movie' | 'tv';
  views: number;
  watchHours: number;
}

export const TOP_TITLES: TopTitle[] = [
  { id: 't-lantern', name: 'The Lantern District', type: 'tv', views: 21840, watchHours: 12420 },
  { id: 't-aurora', name: 'Aurora Drift', type: 'movie', views: 18320, watchHours: 8910 },
  { id: 't-signal', name: 'Signal Fire', type: 'tv', views: 15270, watchHours: 7640 },
  { id: 't-emberfall', name: 'Emberfall', type: 'tv', views: 12980, watchHours: 6180 },
  { id: 't-nightcall', name: 'Night Call', type: 'movie', views: 10410, watchHours: 3920 },
  { id: 't-tidewater', name: 'Tidewater', type: 'movie', views: 8360, watchHours: 3110 },
];

// ---------------------------------------------------------------------------
// System + provider health (Section 15 health checks; Section 10 dashboard)
// ---------------------------------------------------------------------------

export interface HealthService {
  id: string;
  label: string;
  status: HealthStatus;
  /** Short latency / capacity detail. */
  detail: string;
  lastChecked: string;
}

export const HEALTH_SERVICES: HealthService[] = [
  { id: 'database', label: 'Database', status: 'ok', detail: 'p95 42 ms · 12/100 conns', lastChecked: '2026-09-04T09:14:00Z' },
  { id: 'auth', label: 'Authentication', status: 'ok', detail: 'p95 88 ms · 0 lockouts', lastChecked: '2026-09-04T09:14:00Z' },
  { id: 'storage', label: 'Storage', status: 'degraded', detail: 'p95 310 ms · artwork CDN slow', lastChecked: '2026-09-04T09:13:00Z' },
  { id: 'tmdb', label: 'TMDB', status: 'ok', detail: '39/40 req budget · cache 94%', lastChecked: '2026-09-04T09:12:00Z' },
  { id: 'email', label: 'Email (SMTP)', status: 'ok', detail: 'queue 3 · 0 deferrals', lastChecked: '2026-09-04T09:14:00Z' },
  { id: 'ads', label: 'Ad delivery', status: 'ok', detail: 'fill 91% · 0 timeouts', lastChecked: '2026-09-04T09:11:00Z' },
  { id: 'playback', label: 'Playback', status: 'degraded', detail: 'VSEmbed p95 1.9 s · retries up', lastChecked: '2026-09-04T09:14:00Z' },
];

// ---------------------------------------------------------------------------
// Email delivery + imports (Section 10)
// ---------------------------------------------------------------------------

export interface EmailDelivery {
  sent: number;
  delivered: number;
  bounced: number;
  complained: number;
  queued: number;
}

export const EMAIL_DELIVERY: EmailDelivery = {
  sent: 4210,
  delivered: 4176,
  bounced: 22,
  complained: 3,
  queued: 9,
};

export interface ImportJob {
  id: string;
  source: string;
  kind: 'CSV' | 'JSON';
  status: 'completed' | 'dry-run' | 'failed' | 'running';
  rows: number;
  created: number;
  updated: number;
  errors: number;
  startedAt: string;
  actor: string;
}

export const IMPORT_JOBS: ImportJob[] = [
  { id: 'imp-4821', source: 'tmdb-collection-noir.csv', kind: 'CSV', status: 'completed', rows: 142, created: 128, updated: 11, errors: 3, startedAt: '2026-09-03T16:20:00Z', actor: 'e.okafor' },
  { id: 'imp-4820', source: 'weekly-sync.json', kind: 'JSON', status: 'dry-run', rows: 512, created: 0, updated: 0, errors: 7, startedAt: '2026-09-03T11:02:00Z', actor: 'system' },
  { id: 'imp-4817', source: 'staff-picks-q3.csv', kind: 'CSV', status: 'failed', rows: 64, created: 0, updated: 0, errors: 64, startedAt: '2026-09-01T09:44:00Z', actor: 'm.chen' },
];

// ---------------------------------------------------------------------------
// Providers (Section 9 — Vidsrc/VSEmbed adapter admin fields)
// ---------------------------------------------------------------------------

export interface Provider {
  id: string;
  name: string;
  displayName: string;
  kind: 'embed' | 'youtube' | 'native' | 'custom';
  enabled: boolean;
  priority: number;
  health: HealthStatus;
  lastChecked: string;
  description: string;
  // Section 9 required admin fields:
  baseUrl: string;
  allowedDomains: string[];
  timeoutMs: number;
  regions: string[];
  consentRequired: boolean;
  testTitleId: string;
  /** URL path templates (embed providers). Absent for non-embed kinds. */
  moviePathTemplate?: string;
  tvPathTemplate?: string;
  episodePathTemplate?: string;
  shorthandEpisodeTemplate?: string;
}

export const PROVIDERS: Provider[] = [
  {
    id: 'vidsrc',
    name: 'vidsrc',
    displayName: 'Vidsrc / VSEmbed',
    kind: 'embed',
    enabled: true,
    priority: 10,
    health: 'degraded',
    lastChecked: '2026-09-04T09:14:00Z',
    description:
      'Documented VSEmbed embed API. Server generates and validates URLs; only a sanitized iframe URL is returned to the client.',
    baseUrl: 'https://vsembed.su',
    allowedDomains: ['vsembed.su', 'vidsrc.su'],
    timeoutMs: 8000,
    regions: ['US', 'CA', 'GB', 'IN', 'AU'],
    consentRequired: true,
    testTitleId: 'tt1375666',
    moviePathTemplate: '/vidsrc/{tmdbOrImdbId}',
    tvPathTemplate: '/vidsrc/{tmdbOrImdbId}',
    episodePathTemplate: '/vidsrc/{tmdbId}/{season}/{episode}',
    shorthandEpisodeTemplate: '/vidsrc/{tmdbId}?s={season}&e={episode}',
  },
  {
    id: 'youtube',
    name: 'youtube',
    displayName: 'YouTube (official embed)',
    kind: 'youtube',
    enabled: true,
    priority: 30,
    health: 'ok',
    lastChecked: '2026-09-04T09:10:00Z',
    description: 'Official IFrame Player API for trailers and licensed clips. Origin-restricted.',
    baseUrl: 'https://www.youtube-nocookie.com',
    allowedDomains: ['youtube-nocookie.com', 'youtube.com'],
    timeoutMs: 6000,
    regions: ['*'],
    consentRequired: false,
    testTitleId: 'dQw4w9WgXcQ',
  },
  {
    id: 'lumora-origin',
    name: 'lumora-origin',
    displayName: 'Lumora origin (HLS/MP4)',
    kind: 'native',
    enabled: false,
    priority: 20,
    health: 'down',
    lastChecked: '2026-09-04T08:55:00Z',
    description: 'First-party HLS/MP4 delivery. Disabled until licensed masters and signed URLs are provisioned.',
    baseUrl: 'https://cdn.lumora.example',
    allowedDomains: ['cdn.lumora.example'],
    timeoutMs: 10000,
    regions: ['US', 'CA'],
    consentRequired: false,
    testTitleId: 't-aurora',
  },
];

// ---------------------------------------------------------------------------
// Catalog admin metadata (Title has no status/visibility/updated fields;
// these are the admin-owned columns Section 10 requires for the catalog table)
// ---------------------------------------------------------------------------

export type TitleStatus = 'published' | 'draft' | 'scheduled' | 'archived';
export type TitleVisibility = 'public' | 'private' | 'unlisted';

export interface CatalogAdminMeta {
  status: TitleStatus;
  visibility: TitleVisibility;
  updatedAt: string;
  editor: string;
}

const CATALOG_ADMIN_META: Record<string, CatalogAdminMeta> = {
  't-lantern': { status: 'published', visibility: 'public', updatedAt: '2026-09-03T14:20:00Z', editor: 'e.okafor' },
  't-aurora': { status: 'published', visibility: 'public', updatedAt: '2026-09-02T10:05:00Z', editor: 'm.chen' },
  't-signal': { status: 'published', visibility: 'public', updatedAt: '2026-08-30T18:40:00Z', editor: 'e.okafor' },
  't-emberfall': { status: 'scheduled', visibility: 'unlisted', updatedAt: '2026-09-04T08:15:00Z', editor: 'a.rivera' },
  't-meridian': { status: 'draft', visibility: 'private', updatedAt: '2026-09-01T12:00:00Z', editor: 'a.rivera' },
  't-glasshouse': { status: 'archived', visibility: 'private', updatedAt: '2026-07-19T09:30:00Z', editor: 'm.chen' },
  't-nightcall': { status: 'published', visibility: 'public', updatedAt: '2026-08-28T21:10:00Z', editor: 'e.okafor' },
  't-tidewater': { status: 'draft', visibility: 'unlisted', updatedAt: '2026-08-25T16:45:00Z', editor: 'a.rivera' },
};

/** Admin metadata for a title, with a deterministic fallback for unknown ids. */
export function catalogAdminMeta(id: string): CatalogAdminMeta {
  const known = CATALOG_ADMIN_META[id];
  if (known) return known;
  const h = hash(id);
  const statuses: TitleStatus[] = ['published', 'published', 'draft', 'scheduled', 'archived'];
  const visibilities: TitleVisibility[] = ['public', 'public', 'unlisted', 'private'];
  const status = statuses[h % statuses.length] ?? 'draft';
  const visibility = visibilities[h % visibilities.length] ?? 'private';
  const updatedAt = new Date(Date.UTC(2026, 8, 4) - (h % 45) * 86_400_000).toISOString();
  return { status, visibility, updatedAt, editor: 'system' };
}

export interface CatalogRow {
  title: Title;
  meta: CatalogAdminMeta;
}

// ---------------------------------------------------------------------------
// Users (Section 10 "Users" — safe metadata only)
// ---------------------------------------------------------------------------

export interface AdminUser {
  id: string;
  email: string;
  displayName: string;
  role: 'viewer' | 'editor' | 'ad_manager' | 'support' | 'admin' | 'owner';
  status: 'active' | 'suspended' | 'invited';
  profiles: number;
  lastActive: string;
}

export const ADMIN_USERS: AdminUser[] = [
  { id: 'u-001', email: 'jane.harper@example.com', displayName: 'Jane Harper', role: 'owner', status: 'active', profiles: 3, lastActive: '2026-09-04T08:50:00Z' },
  { id: 'u-002', email: 'e.okafor@lumora.example', displayName: 'Emeka Okafor', role: 'editor', status: 'active', profiles: 1, lastActive: '2026-09-04T09:02:00Z' },
  { id: 'u-003', email: 'm.chen@lumora.example', displayName: 'Mia Chen', role: 'editor', status: 'active', profiles: 2, lastActive: '2026-09-03T22:14:00Z' },
  { id: 'u-004', email: 'a.rivera@lumora.example', displayName: 'Ana Rivera', role: 'ad_manager', status: 'active', profiles: 1, lastActive: '2026-09-04T07:41:00Z' },
  { id: 'u-005', email: 'devon.support@lumora.example', displayName: 'Devon Blake', role: 'support', status: 'active', profiles: 1, lastActive: '2026-09-02T15:30:00Z' },
  { id: 'u-006', email: 'spam.actor@throwaway.test', displayName: 'Flagged Account', role: 'viewer', status: 'suspended', profiles: 1, lastActive: '2026-08-19T03:12:00Z' },
  { id: 'u-007', email: 'new.editor@lumora.example', displayName: 'Pending Invite', role: 'editor', status: 'invited', profiles: 0, lastActive: '—' },
  { id: 'u-008', email: 'sofia.kaur@example.com', displayName: 'Sofia Kaur', role: 'viewer', status: 'active', profiles: 4, lastActive: '2026-09-04T06:05:00Z' },
];

// ---------------------------------------------------------------------------
// Audit log (Section 7 audit_logs; Section 10 "Audit")
// ---------------------------------------------------------------------------

export interface AuditEvent {
  id: string;
  timestamp: string;
  actor: { name: string; handle: string; role: string };
  action: string;
  target: string;
  before?: string;
  after?: string;
  reason?: string;
  outcome: Outcome;
}

export const AUDIT_EVENTS: AuditEvent[] = [
  {
    id: 'a-1029',
    timestamp: '2026-09-04T08:15:00Z',
    actor: { name: 'Ana Rivera', handle: 'a.rivera', role: 'editor' },
    action: 'title.schedule',
    target: 'Emberfall',
    before: 'status: draft · visibility: private',
    after: 'status: scheduled (2026-09-10) · visibility: unlisted',
    reason: 'Season 1 marketing embargo lifts Sep 10',
    outcome: 'success',
  },
  {
    id: 'a-1028',
    timestamp: '2026-09-04T07:02:00Z',
    actor: { name: 'System', handle: 'system', role: 'service' },
    action: 'provider.healthcheck',
    target: 'Vidsrc / VSEmbed',
    before: 'health: ok',
    after: 'health: degraded (p95 1.9s)',
    reason: 'Automated 5-minute probe',
    outcome: 'success',
  },
  {
    id: 'a-1027',
    timestamp: '2026-09-03T22:40:00Z',
    actor: { name: 'Jane Harper', handle: 'j.harper', role: 'owner' },
    action: 'role.assign',
    target: 'm.chen@lumora.example',
    before: 'role: viewer',
    after: 'role: editor',
    reason: 'Promotion approved in ticket OPS-241',
    outcome: 'success',
  },
  {
    id: 'a-1026',
    timestamp: '2026-09-03T18:11:00Z',
    actor: { name: 'Devon Blake', handle: 'devon.support', role: 'support' },
    action: 'user.suspend',
    target: 'spam.actor@throwaway.test',
    before: 'status: active',
    after: 'status: suspended',
    reason: 'Abuse report #5521 — automated scraping',
    outcome: 'success',
  },
  {
    id: 'a-1025',
    timestamp: '2026-09-03T16:22:00Z',
    actor: { name: 'Emeka Okafor', handle: 'e.okafor', role: 'editor' },
    action: 'import.run',
    target: 'tmdb-collection-noir.csv',
    before: 'catalog: 512 titles',
    after: 'catalog: 640 titles (+128, 3 errors)',
    reason: 'Q3 noir collection build-out',
    outcome: 'success',
  },
  {
    id: 'a-1024',
    timestamp: '2026-09-03T11:30:00Z',
    actor: { name: 'Ana Rivera', handle: 'a.rivera', role: 'ad_manager' },
    action: 'settings.update',
    target: 'privacy.consent_mode',
    before: 'value: implied',
    after: 'value: explicit',
    reason: 'Legal review — align with regional policy',
    outcome: 'success',
  },
  {
    id: 'a-1023',
    timestamp: '2026-09-02T14:05:00Z',
    actor: { name: 'Mia Chen', handle: 'm.chen', role: 'editor' },
    action: 'secret.rotate',
    target: 'TMDB_API_KEY',
    before: 'key: ****3f9a (age 92d)',
    after: 'key: ****b1c7 (age 0d)',
    reason: 'Scheduled 90-day rotation',
    outcome: 'failure',
  },
];

// ---------------------------------------------------------------------------
// Settings (Section 10 — scope, default, validation, affected surfaces,
// editor, timestamp, rollback for every setting)
// ---------------------------------------------------------------------------

export type SettingScope = 'global' | 'brand' | 'playback' | 'privacy' | 'features';
export type SettingKind = 'text' | 'number' | 'toggle' | 'select' | 'color' | 'duration';

export interface Setting {
  key: string;
  label: string;
  scope: SettingScope;
  kind: SettingKind;
  value: string;
  defaultValue: string;
  validation: string;
  affectedSurfaces: string[];
  editor: string;
  updatedAt: string;
}

export interface SettingGroup {
  id: string;
  title: string;
  description: string;
  settings: Setting[];
}

export const SETTING_GROUPS: SettingGroup[] = [
  {
    id: 'brand',
    title: 'Brand',
    description: 'Identity shown across public surfaces and transactional email.',
    settings: [
      {
        key: 'brand.display_name',
        label: 'Display name',
        scope: 'brand',
        kind: 'text',
        value: 'Lumora',
        defaultValue: 'Lumora',
        validation: '1–40 characters, no control characters.',
        affectedSurfaces: ['Top bar', 'Email templates', 'SEO title'],
        editor: 'j.harper',
        updatedAt: '2026-08-12T10:00:00Z',
      },
      {
        key: 'brand.primary_color',
        label: 'Primary color',
        scope: 'brand',
        kind: 'color',
        value: '#7882ff',
        defaultValue: '#7882ff',
        validation: 'Hex color; must meet 4.5:1 contrast on base surface.',
        affectedSurfaces: ['Buttons', 'Links', 'Focus rings'],
        editor: 'j.harper',
        updatedAt: '2026-08-12T10:02:00Z',
      },
    ],
  },
  {
    id: 'playback',
    title: 'Playback',
    description: 'Resume behavior and default player experience.',
    settings: [
      {
        key: 'playback.resume_threshold',
        label: 'Resume threshold',
        scope: 'playback',
        kind: 'number',
        value: '30',
        defaultValue: '30',
        validation: 'Integer seconds, 5–120.',
        affectedSurfaces: ['Player', 'Continue watching row'],
        editor: 'e.okafor',
        updatedAt: '2026-08-28T09:20:00Z',
      },
      {
        key: 'playback.heartbeat_interval',
        label: 'Progress heartbeat interval',
        scope: 'playback',
        kind: 'duration',
        value: '15s',
        defaultValue: '15s',
        validation: 'Duration 5s–60s; lower increases write volume.',
        affectedSurfaces: ['Player', 'Watch progress writes'],
        editor: 'e.okafor',
        updatedAt: '2026-08-28T09:22:00Z',
      },
      {
        key: 'playback.autoplay_next',
        label: 'Autoplay next episode',
        scope: 'playback',
        kind: 'toggle',
        value: 'on',
        defaultValue: 'on',
        validation: 'Boolean. Disabled automatically under reduced-motion.',
        affectedSurfaces: ['Player', 'Episode list'],
        editor: 'm.chen',
        updatedAt: '2026-08-29T13:10:00Z',
      },
    ],
  },
  {
    id: 'privacy',
    title: 'Privacy & consent',
    description: 'Consent gating for analytics and advertising (Section 15).',
    settings: [
      {
        key: 'privacy.consent_mode',
        label: 'Consent mode',
        scope: 'privacy',
        kind: 'select',
        value: 'explicit',
        defaultValue: 'implied',
        validation: 'One of: implied | explicit. "explicit" blocks pre-consent personalization.',
        affectedSurfaces: ['Consent banner', 'Ad targeting', 'Analytics'],
        editor: 'a.rivera',
        updatedAt: '2026-09-03T11:30:00Z',
      },
      {
        key: 'privacy.guest_watch',
        label: 'Guest viewing',
        scope: 'privacy',
        kind: 'toggle',
        value: 'off',
        defaultValue: 'off',
        validation: 'Boolean. Independent from guest browsing (Section 8).',
        affectedSurfaces: ['Title detail', 'Player', 'Guest merge'],
        editor: 'j.harper',
        updatedAt: '2026-08-15T08:00:00Z',
      },
    ],
  },
  {
    id: 'features',
    title: 'Feature flags',
    description: 'Reversible rollout switches (Section 7 feature_flags).',
    settings: [
      {
        key: 'features.reviews',
        label: 'Reviews',
        scope: 'features',
        kind: 'toggle',
        value: 'off',
        defaultValue: 'off',
        validation: 'Boolean. Requires moderation queue to be staffed.',
        affectedSurfaces: ['Title detail', 'Moderation'],
        editor: 'm.chen',
        updatedAt: '2026-08-20T17:45:00Z',
      },
      {
        key: 'features.recommendations',
        label: 'Personalized rows',
        scope: 'features',
        kind: 'toggle',
        value: 'on',
        defaultValue: 'on',
        validation: 'Boolean. Falls back to editorial rows when off.',
        affectedSurfaces: ['Home', 'Browse'],
        editor: 'e.okafor',
        updatedAt: '2026-08-26T12:15:00Z',
      },
    ],
  },
];
