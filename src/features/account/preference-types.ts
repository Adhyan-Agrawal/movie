import { z } from 'zod';
import { DEFAULT_SETTINGS, LANGUAGE_OPTIONS, type AccountSettings } from './types';

export interface AccountPreferencesSnapshot {
  accountId: string;
  settings: AccountSettings;
  hasSavedPreferences: boolean;
}

export function preferencesForViewer(viewerKey: string, snapshot?: AccountPreferencesSnapshot | null): AccountPreferencesSnapshot | null {
  if (!snapshot?.accountId) return null;
  const owner = `account:${snapshot.accountId}`;
  return viewerKey === owner || viewerKey.startsWith(`${owner}:profile:`) ? snapshot : null;
}

export type AccountPreferencesFailure = 'unauthenticated' | 'unverified' | 'unavailable' | 'invalid' | 'account-changed';
export type AccountPreferencesResult =
  | { ok: true; snapshot: AccountPreferencesSnapshot }
  | { ok: false; reason: AccountPreferencesFailure; message: string };

export const PREFERENCE_ERRORS: Record<AccountPreferencesFailure, string> = {
  unauthenticated: 'Sign in to load or save account preferences.',
  unverified: 'Verify your email before managing account preferences.',
  unavailable: 'Account preferences are unavailable. Please try again.',
  invalid: 'Choose valid preference values and try again.',
  'account-changed': 'Your signed-in account changed. Refresh before managing preferences.',
};

// Separate top-level keys let auth.updateUser merge only the supplied fields.
// Never store roles, maturity, billing, profile ownership, or consent here.
export const ACCOUNT_PREFERENCE_METADATA_KEYS = {
  language: 'lumora_preferences_v1_language',
  autoplayNext: 'lumora_preferences_v1_autoplay_next',
  autoplayPreviews: 'lumora_preferences_v1_autoplay_previews',
  captions: 'lumora_preferences_v1_captions',
  reducedMotion: 'lumora_preferences_v1_reduced_motion',
} as const satisfies Record<keyof AccountSettings, string>;

export const accountPreferenceOwnerSchema = z.string().uuid();
const shape = {
  language: z.string().refine((value) => LANGUAGE_OPTIONS.some((option) => option.value === value)),
  autoplayNext: z.boolean(),
  autoplayPreviews: z.boolean(),
  captions: z.boolean(),
  reducedMotion: z.boolean(),
};
export const accountPreferencesPatchSchema = z.object(shape).partial().strict()
  .refine((value) => Object.values(value).some((entry) => entry !== undefined));

const storedSettingsSchema = z.object({
  language: shape.language.catch(DEFAULT_SETTINGS.language),
  autoplayNext: shape.autoplayNext.catch(DEFAULT_SETTINGS.autoplayNext),
  autoplayPreviews: shape.autoplayPreviews.catch(DEFAULT_SETTINGS.autoplayPreviews),
  captions: shape.captions.catch(DEFAULT_SETTINGS.captions),
  reducedMotion: shape.reducedMotion.catch(DEFAULT_SETTINGS.reducedMotion),
});

/** Drop all unknown fields, including legacy browser-only maturity defaults. */
export function normalizeAccountSettings(value: unknown): AccountSettings {
  return storedSettingsSchema.parse(value && typeof value === 'object' && !Array.isArray(value) ? value : {});
}

/** Projection only; callers must verify identity before creating this DTO. */
export function accountPreferencesSnapshot(accountId: string, metadata: unknown): AccountPreferencesSnapshot {
  const stored = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata as Record<string, unknown> : {};
  const entries = Object.entries(ACCOUNT_PREFERENCE_METADATA_KEYS);
  return {
    accountId,
    settings: normalizeAccountSettings(Object.fromEntries(entries.map(([field, key]) => [field,
      Object.hasOwn(stored, key) ? stored[key] : undefined]))),
    hasSavedPreferences: entries.some(([, key]) => Object.hasOwn(stored, key)),
  };
}
