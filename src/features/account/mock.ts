/**
 * Account / profiles mock data (Spec Section 4 "Profiles and account" and
 * Section 8 sessions/devices).
 *
 * There is no real auth yet, so this module provides the sample "signed-in
 * viewer" data the account area renders. It is intentionally client-safe: no
 * secrets, tokens, or raw provider references. When Supabase Auth + RLS land,
 * these shapes map onto `accounts`, `profiles`, `sessions`, `watchlists`,
 * `watch_progress`, and `notifications` (Section 7) and this file is deleted.
 */

/** Fixed "now" so relative timestamps are deterministic across server/client
 *  renders (avoids hydration drift). Matches the sample catalog's Sep 2026. */
export const NOW = new Date('2026-09-04T15:00:00Z');

/** Toggle to preview the unauthorized experience without wiring real auth. */
export const MOCK_IS_AUTHENTICATED: boolean = true;

// ---------------------------------------------------------------------------
// Maturity + language reference data
// ---------------------------------------------------------------------------

export type MaturityLevel = 'kids' | 'older-kids' | 'teens' | 'adults';

export interface MaturityOption {
  value: MaturityLevel;
  label: string;
  description: string;
}

export const MATURITY_LEVELS: MaturityOption[] = [
  { value: 'kids', label: 'Little Kids', description: 'G and TV-Y' },
  { value: 'older-kids', label: 'Older Kids', description: 'Up to PG / TV-PG' },
  { value: 'teens', label: 'Teens', description: 'Up to PG-13 / TV-14' },
  { value: 'adults', label: 'Adults', description: 'All maturity ratings' },
];

export interface LanguageOption {
  value: string;
  label: string;
}

export const LANGUAGE_OPTIONS: LanguageOption[] = [
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Español' },
  { value: 'fr', label: 'Français' },
  { value: 'de', label: 'Deutsch' },
  { value: 'pt', label: 'Português' },
  { value: 'ja', label: '日本語' },
  { value: 'hi', label: 'हिन्दी' },
];

// ---------------------------------------------------------------------------
// Account + profiles
// ---------------------------------------------------------------------------

export interface Account {
  id: string;
  displayName: string;
  email: string;
  memberSince: string;
  plan: string;
}

export const MOCK_ACCOUNT: Account = {
  id: 'acc_01',
  displayName: 'Alex Rivera',
  email: 'alex@example.com',
  memberSince: '2023-04-12T00:00:00Z',
  plan: 'Premium 4K',
};

export interface Profile {
  id: string;
  name: string;
  /** CSS `linear-gradient(...)` used as the avatar fill (no unlicensed art). */
  avatarGradient: string;
  maturity: MaturityLevel;
  isKids: boolean;
  pinProtected: boolean;
}

export const MOCK_PROFILES: Profile[] = [
  {
    id: 'prof_alex',
    name: 'Alex',
    avatarGradient: 'linear-gradient(150deg, hsl(230 62% 46%), hsl(265 55% 30%))',
    maturity: 'adults',
    isKids: false,
    pinProtected: true,
  },
  {
    id: 'prof_jordan',
    name: 'Jordan',
    avatarGradient: 'linear-gradient(150deg, hsl(162 55% 38%), hsl(190 58% 26%))',
    maturity: 'adults',
    isKids: false,
    pinProtected: false,
  },
  {
    id: 'prof_priya',
    name: 'Priya',
    avatarGradient: 'linear-gradient(150deg, hsl(330 62% 48%), hsl(280 55% 32%))',
    maturity: 'teens',
    isKids: false,
    pinProtected: false,
  },
  {
    id: 'prof_max',
    name: 'Max',
    avatarGradient: 'linear-gradient(150deg, hsl(35 88% 52%), hsl(15 78% 44%))',
    maturity: 'kids',
    isKids: true,
    pinProtected: false,
  },
];

export function getProfileById(id: string): Profile | undefined {
  return MOCK_PROFILES.find((p) => p.id === id);
}

// ---------------------------------------------------------------------------
// Device sessions (Section 8)
// ---------------------------------------------------------------------------

export type DeviceKind = 'desktop' | 'mobile' | 'tablet' | 'tv';

export interface DeviceSession {
  id: string;
  device: string;
  kind: DeviceKind;
  platform: string;
  location: string;
  lastActive: string;
  current: boolean;
  /** Masked for privacy — never expose full client IPs (Section 15). */
  ipMasked: string;
}

export const MOCK_DEVICE_SESSIONS: DeviceSession[] = [
  {
    id: 'sess_this',
    device: 'MacBook Pro',
    kind: 'desktop',
    platform: 'Chrome · macOS',
    location: 'San Francisco, US',
    lastActive: NOW.toISOString(),
    current: true,
    ipMasked: '192.168.1.•••',
  },
  {
    id: 'sess_iphone',
    device: 'iPhone 15',
    kind: 'mobile',
    platform: 'Lumora iOS app',
    location: 'San Francisco, US',
    lastActive: '2026-09-04T09:12:00Z',
    current: false,
    ipMasked: '192.168.1.•••',
  },
  {
    id: 'sess_tv',
    device: 'Living Room TV',
    kind: 'tv',
    platform: 'Lumora tvOS app',
    location: 'San Francisco, US',
    lastActive: '2026-09-02T20:00:00Z',
    current: false,
    ipMasked: '192.168.1.•••',
  },
  {
    id: 'sess_windows',
    device: 'Windows PC',
    kind: 'desktop',
    platform: 'Edge · Windows',
    location: 'Austin, US',
    lastActive: '2026-08-30T18:30:00Z',
    current: false,
    ipMasked: '73.44.•••.•••',
  },
  {
    id: 'sess_ipad',
    device: 'iPad Air',
    kind: 'tablet',
    platform: 'Safari · iPadOS',
    location: 'New York, US',
    lastActive: '2026-08-20T11:00:00Z',
    current: false,
    ipMasked: '98.12.•••.•••',
  },
];

// ---------------------------------------------------------------------------
// Notification preferences (Section 4 + Section 8 sign-in alerts)
// ---------------------------------------------------------------------------

export interface NotificationCategory {
  id: string;
  label: string;
  description: string;
  email: boolean;
  push: boolean;
}

export const MOCK_NOTIFICATION_CATEGORIES: NotificationCategory[] = [
  {
    id: 'availability',
    label: 'New availability',
    description: 'When a title on your watchlist becomes available to stream.',
    email: true,
    push: true,
  },
  {
    id: 'new-episodes',
    label: 'New episodes',
    description: 'When a new episode of a series you follow is released.',
    email: true,
    push: false,
  },
  {
    id: 'sign-in-alerts',
    label: 'Sign-in alerts',
    description: 'When a new device signs in to your account.',
    email: true,
    push: true,
  },
  {
    id: 'product-news',
    label: 'Product news',
    description: 'Occasional updates about Lumora features and improvements.',
    email: false,
    push: false,
  },
];

// ---------------------------------------------------------------------------
// Account settings / preferences
// ---------------------------------------------------------------------------

export interface AccountSettings {
  language: string;
  autoplayNext: boolean;
  autoplayPreviews: boolean;
  captions: boolean;
  reducedMotion: boolean;
  maturity: MaturityLevel;
  pinSet: boolean;
}

export const MOCK_SETTINGS: AccountSettings = {
  language: 'en',
  autoplayNext: true,
  autoplayPreviews: false,
  captions: true,
  reducedMotion: false,
  maturity: 'adults',
  pinSet: true,
};

// ---------------------------------------------------------------------------
// Watchlist + history (reuse catalog title ids from MOCK_TITLES)
// ---------------------------------------------------------------------------

export const MOCK_WATCHLIST_IDS: string[] = [
  't-aurora',
  't-signal',
  't-emberfall',
  't-meridian',
  't-glasshouse',
  't-tidewater',
];

export interface HistoryEntry {
  id: string;
  titleId: string;
  watchedAt: string;
  /** 0..1 fraction watched (>= 1 means finished). */
  progress: number;
}

export const MOCK_HISTORY: HistoryEntry[] = [
  { id: 'hist_1', titleId: 't-lantern', watchedAt: '2026-09-04T13:10:00Z', progress: 0.42 },
  { id: 'hist_2', titleId: 't-aurora', watchedAt: '2026-09-03T21:30:00Z', progress: 0.71 },
  { id: 'hist_3', titleId: 't-signal', watchedAt: '2026-09-02T19:05:00Z', progress: 1 },
  { id: 'hist_4', titleId: 't-nightcall', watchedAt: '2026-08-31T22:45:00Z', progress: 0.15 },
  { id: 'hist_5', titleId: 't-tidewater', watchedAt: '2026-08-28T20:20:00Z', progress: 1 },
];

// ---------------------------------------------------------------------------
// Presentation helpers (pure + deterministic against NOW)
// ---------------------------------------------------------------------------

export function greeting(): string {
  const hour = NOW.getUTCHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/** "Apr 12, 2023" — fixed locale + UTC so server and client agree. */
export function formatDate(iso: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(iso));
}

/** Compact relative time ("2 hours ago", "Yesterday") anchored to NOW. */
export function formatRelativeTime(iso: string): string {
  const diffMs = NOW.getTime() - new Date(iso).getTime();
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;

  const days = Math.round(hours / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;

  const weeks = Math.round(days / 7);
  if (weeks < 5) return `${weeks} week${weeks === 1 ? '' : 's'} ago`;

  return formatDate(iso);
}

export function maturityLabel(level: MaturityLevel): string {
  return MATURITY_LEVELS.find((m) => m.value === level)?.label ?? 'All maturities';
}
