import { z } from 'zod';

/**
 * Typed, validated environment (Section 6).
 * Public vars are safe for the browser bundle; server vars must never be
 * imported into client components. We validate lazily so the app can boot
 * for local UI work before Supabase/TMDB are configured, but any code that
 * actually reads a server secret gets a hard, descriptive failure.
 */

const publicSchema = z.object({
  NEXT_PUBLIC_APP_NAME: z.string().min(1).default('Lumora'),
  NEXT_PUBLIC_APP_URL: z.string().url().default('http://localhost:3000'),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url().optional(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1).optional(),
});

const serverSchema = z.object({
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  TMDB_API_KEY: z.string().min(1).optional(),
  TMDB_API_BASE_URL: z.string().url().default('https://api.themoviedb.org/3'),
});

type PublicEnv = z.infer<typeof publicSchema>;
type ServerEnv = z.infer<typeof serverSchema>;

function format(error: z.ZodError): string {
  return error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
}

// Public env is referenced by literal keys so Next.js can inline them.
const publicParsed = publicSchema.safeParse({
  NEXT_PUBLIC_APP_NAME: process.env.NEXT_PUBLIC_APP_NAME,
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
});

if (!publicParsed.success) {
  throw new Error(`Invalid public environment variables:\n${format(publicParsed.error)}`);
}

export const publicEnv: PublicEnv = publicParsed.data;

let cachedServerEnv: ServerEnv | null = null;

/**
 * Access server-only env. Throws if called in the browser or if the schema
 * fails to parse. Call this inside server code (route handlers, services).
 */
export function serverEnv(): ServerEnv {
  if (typeof window !== 'undefined') {
    throw new Error('serverEnv() must not be called in the browser.');
  }
  if (cachedServerEnv) return cachedServerEnv;

  const parsed = serverSchema.safeParse({
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    TMDB_API_KEY: process.env.TMDB_API_KEY,
    TMDB_API_BASE_URL: process.env.TMDB_API_BASE_URL,
  });

  if (!parsed.success) {
    throw new Error(`Invalid server environment variables:\n${format(parsed.error)}`);
  }
  cachedServerEnv = parsed.data;
  return cachedServerEnv;
}

/** Feature availability derived from configured env (drives graceful degradation). */
export const features = {
  get supabaseConfigured(): boolean {
    return Boolean(publicEnv.NEXT_PUBLIC_SUPABASE_URL && publicEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  },
  get tmdbConfigured(): boolean {
    return typeof window === 'undefined' && Boolean(process.env.TMDB_API_KEY);
  },
};
