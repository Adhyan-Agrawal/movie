import { z } from 'zod';

/**
 * Title create/update validation (Sections 6 & 14).
 *
 * Field constraints intentionally mirror the `titles` table in migration 0001
 * (enum values, release-year range 1878–2100, editorial score 0–100) so that
 * server validation and DB checks agree.
 */

export const TITLE_TYPES = ['movie', 'tv'] as const;
export const TITLE_STATUSES = ['draft', 'scheduled', 'published', 'archived'] as const;
export const TITLE_VISIBILITIES = ['public', 'private'] as const;

/** Common MPAA + US TV maturity codes. `NR` = not rated (DB default). */
export const MATURITY_RATINGS = [
  'NR',
  'G',
  'PG',
  'PG-13',
  'R',
  'NC-17',
  'TV-Y',
  'TV-Y7',
  'TV-G',
  'TV-PG',
  'TV-14',
  'TV-MA',
] as const;

/** lowercase kebab-case slug, e.g. `the-dark-knight`. */
export const slugSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Must be lowercase kebab-case (a-z, 0-9, hyphens)');

/** IMDb id like `tt0468569` (7–8 digits after the `tt`). */
export const imdbIdSchema = z
  .string()
  .regex(/^tt\d{7,8}$/, 'IMDb id must look like tt0468569');

const optionalHttpsUrl = z
  .string()
  .url()
  .refine((u) => /^https:\/\//i.test(u), 'Must be an https URL');

export const titleInputSchema = z.object({
  type: z.enum(TITLE_TYPES),
  slug: slugSchema,
  name: z.string().min(1).max(200),
  originalName: z.string().min(1).max(200).optional(),
  synopsis: z.string().max(5000).default(''),
  releaseYear: z.number().int().min(1878).max(2100).optional(),
  runtimeMinutes: z.number().int().min(0).max(100_000).optional(),
  maturity: z.enum(MATURITY_RATINGS).default('NR'),
  status: z.enum(TITLE_STATUSES).default('draft'),
  visibility: z.enum(TITLE_VISIBILITIES).default('public'),
  originalLanguage: z
    .string()
    .min(2)
    .max(10)
    .regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/, 'BCP-47-ish language tag, e.g. en or pt-BR')
    .default('en'),
  tmdbId: z.number().int().positive().optional(),
  imdbId: imdbIdSchema.optional(),
  posterUrl: optionalHttpsUrl.optional(),
  backdropUrl: optionalHttpsUrl.optional(),
  trailerUrl: optionalHttpsUrl.optional(),
  featured: z.boolean().default(false),
  editorialScore: z.number().int().min(0).max(100).optional(),
});

export type TitleInput = z.infer<typeof titleInputSchema>;

/** Partial variant for PATCH-style updates. */
export const titleUpdateSchema = titleInputSchema.partial();
export type TitleUpdate = z.infer<typeof titleUpdateSchema>;
