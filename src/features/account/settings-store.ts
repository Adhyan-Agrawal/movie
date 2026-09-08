/**
 * Signed-in viewer preference store (Spec Section 4).
 *
 * Storage decision — browser-local, keyed per account. There is no server-side
 * home for account preferences yet: `accounts` and `profiles` have no
 * `preferences` jsonb column (0001_init.sql), no later migration adds one, and
 * running DDL is out of scope. Reusing `site_settings` would be wrong (that is
 * the admin-global key/value store), and the account-scoped jsonb tables that
 * do exist are semantically owned (`notifications.data`, playback/watch rows).
 * So preferences persist under a per-account key in THIS browser, mirroring the
 * app's other client-only stores (guest history, consent, search recents).
 *
 * The UI is explicit about the trade-off: choices survive reload on this device
 * for this account but are not synced across devices and are not yet applied to
 * behavior. When a real account-scoped jsonb column or settings table lands,
 * swap the read/write below for 'use server' actions without changing the form.
 *
 * Client-only: safe to import from any client component; never from server code
 * (reads `localStorage`, so callers hydrate after mount).
 */

import {
  DEFAULT_SETTINGS,
  LANGUAGE_OPTIONS,
  MATURITY_LEVELS,
  toMaturityLevel,
  type AccountSettings,
} from './types';

const STORAGE_PREFIX = 'lumora:settings:v1:';

/** Per-account localStorage key so two accounts on one browser never collide. */
export function settingsStorageKey(accountId: string): string {
  return `${STORAGE_PREFIX}${accountId}`;
}

/** Merge whatever is stored over the defaults, dropping unknown/malformed values. */
export function readAccountSettings(accountId: string): AccountSettings {
  if (typeof window === 'undefined') return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(settingsStorageKey(accountId));
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<AccountSettings>;
    return {
      language: LANGUAGE_OPTIONS.some((o) => o.value === parsed.language) ? parsed.language! : DEFAULT_SETTINGS.language,
      autoplayNext: typeof parsed.autoplayNext === 'boolean' ? parsed.autoplayNext : DEFAULT_SETTINGS.autoplayNext,
      autoplayPreviews:
        typeof parsed.autoplayPreviews === 'boolean' ? parsed.autoplayPreviews : DEFAULT_SETTINGS.autoplayPreviews,
      captions: typeof parsed.captions === 'boolean' ? parsed.captions : DEFAULT_SETTINGS.captions,
      reducedMotion:
        typeof parsed.reducedMotion === 'boolean' ? parsed.reducedMotion : DEFAULT_SETTINGS.reducedMotion,
      maturity: MATURITY_LEVELS.some((m) => m.value === parsed.maturity)
        ? toMaturityLevel(parsed.maturity as string)
        : DEFAULT_SETTINGS.maturity,
    };
  } catch {
    // Corrupt/unreadable entry — treat as unset rather than crashing the form.
    return DEFAULT_SETTINGS;
  }
}

/** Persist the account's preferences to this browser's localStorage. */
export function writeAccountSettings(accountId: string, settings: AccountSettings): void {
  try {
    window.localStorage.setItem(settingsStorageKey(accountId), JSON.stringify(settings));
  } catch {
    // Private mode / quota — preferences are best-effort by design.
  }
}
