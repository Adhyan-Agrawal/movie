import { accountPreferenceOwnerSchema, normalizeAccountSettings } from './preference-types';
import type { AccountSettings } from './types';

/** Legacy per-account browser choices, now a cache, never the account authority. */
const STORAGE_PREFIX = 'lumora:settings:v1:';
export const ACCOUNT_SETTINGS_EVENT = 'lumora:account-settings-updated';
let acknowledgement: { accountId: string; settings: AccountSettings; version: number } | null = null;

export function getAccountSettingsAcknowledgement(accountId: string) {
  return acknowledgement?.accountId === accountId ? acknowledgement : null;
}

export function settingsStorageKey(accountId: string): string {
  return `${STORAGE_PREFIX}${accountId}`;
}

/** Only explicit save promotes legacy browser choices to verified auth metadata. */
export function readAccountSettings(accountId: string): AccountSettings | null {
  if (typeof window === 'undefined' || !accountPreferenceOwnerSchema.safeParse(accountId).success) return null;
  try {
    const raw = window.localStorage.getItem(settingsStorageKey(accountId));
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return normalizeAccountSettings(value);
  } catch {
    return null;
  }
}

/** Cache only acknowledged account saves; failure must not imply persistence. */
export function writeAccountSettings(accountId: string, settings: AccountSettings): boolean {
  if (typeof window === 'undefined' || !accountPreferenceOwnerSchema.safeParse(accountId).success) return false;
  const normalized = normalizeAccountSettings(settings);
  acknowledgement = { accountId, settings: normalized, version: (acknowledgement?.version ?? 0) + 1 };
  let persisted = false;
  try {
    const key = settingsStorageKey(accountId);
    const serialized = JSON.stringify(normalized);
    window.localStorage.setItem(key, serialized);
    persisted = window.localStorage.getItem(key) === serialized;
  } catch {
    // A confirmed server save still applies in this tab when local caching is blocked.
  }
  try { window.dispatchEvent?.(new Event(ACCOUNT_SETTINGS_EVENT)); } catch { /* The server save is already acknowledged. */ }
  return persisted;
}
