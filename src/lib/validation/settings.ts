import { z } from 'zod';

/**
 * Generic site-setting validation (Sections 10 & 14).
 *
 * `site_settings` stores a `jsonb` value per key. This schema validates an
 * admin update to a single setting; the concrete value shape is validated by
 * the specific setting's own schema in the settings service. `reason` supports
 * the audit trail required for settings changes.
 */

type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/** Recursive JSON validator for arbitrary setting values. */
export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

/** dotted/segmented setting key, e.g. `home.hero.mode` or `registration_open`. */
export const settingKeySchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/, 'Lowercase segments joined by . _ or -');

export const siteSettingUpdateSchema = z.object({
  key: settingKeySchema,
  value: jsonValueSchema,
  /** Whether the setting is safe to expose to the public/browser. */
  isPublic: z.boolean().optional(),
  description: z.string().max(500).optional(),
  /** Audit reason for sensitive/observed changes. */
  reason: z.string().max(500).optional(),
});

export type SiteSettingUpdate = z.infer<typeof siteSettingUpdateSchema>;
