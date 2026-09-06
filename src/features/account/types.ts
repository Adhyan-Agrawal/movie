/**
 * Account area shared types and reference data (Spec Section 4).
 *
 * These are client-safe: no secrets, no fabricated records. The lists below
 * (maturity levels, languages) are fixed reference data, not mock rows; the
 * signed-in account's real data is read server-side via `./queries`.
 */

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

export function maturityLabel(level: MaturityLevel): string {
  return MATURITY_LEVELS.find((m) => m.value === level)?.label ?? 'All maturities';
}

/** Coerce a free-text DB maturity ceiling to the known union, defaulting to adults. */
export function toMaturityLevel(value: string): MaturityLevel {
  return MATURITY_LEVELS.some((m) => m.value === value) ? (value as MaturityLevel) : 'adults';
}

// ---------------------------------------------------------------------------
// Profile (maps onto the real `profiles` table; read via ./queries)
// ---------------------------------------------------------------------------

/** Client-safe view of a real `profiles` row for the signed-in account. */
export interface AccountProfile {
  id: string;
  name: string;
  /** CSS `linear-gradient(...)` or image URL stored on the profile. */
  avatar: string | null;
  maturityCeiling: MaturityLevel;
  isKids: boolean;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Account settings (form defaults; persistence lands with the account service)
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

/** Neutral defaults for the preferences form — not stored account data. */
export const DEFAULT_SETTINGS: AccountSettings = {
  language: 'en',
  autoplayNext: true,
  autoplayPreviews: false,
  captions: true,
  reducedMotion: false,
  maturity: 'adults',
  pinSet: false,
};

// ---------------------------------------------------------------------------
// Presentation helpers (pure)
// ---------------------------------------------------------------------------

/** Time-of-day greeting, resolved from the render-time clock. */
export function greeting(date = new Date()): string {
  const hour = date.getUTCHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/** "Apr 12, 2023" — fixed locale + UTC so renders are stable. */
export function formatDate(iso: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(iso));
}
