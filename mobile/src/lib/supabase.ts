import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';
import { resolveSupabaseRuntimeConfig } from './runtime-config';

/**
 * Supabase client for React Native.
 *
 * Native has no cookies, so the session is persisted in AsyncStorage instead of
 * the web client's cookie storage. `detectSessionInUrl` is off (no browser URL
 * to parse) and refresh tokens are enabled so a signed-in viewer stays signed
 * in across app restarts.
 *
 * SECURITY: only the PUBLIC anon key is ever bundled here (EXPO_PUBLIC_*). All
 * access is governed by the same Row Level Security policies as the web app —
 * this client can read public catalog rows and only the signed-in viewer's own
 * library rows.
 */
const config = resolveSupabaseRuntimeConfig(
  process.env.EXPO_PUBLIC_SUPABASE_URL,
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
);

export const supabaseConfigured = config.configured;

// A constructor-safe inert client keeps module evaluation from taking down the
// entire app. Every account entry point checks `supabaseConfigured` first.
export const supabase = createClient(config.url, config.anonKey, {
  auth: {
    ...(supabaseConfigured ? { storage: AsyncStorage } : {}),
    autoRefreshToken: supabaseConfigured,
    persistSession: supabaseConfigured,
    detectSessionInUrl: false,
  },
});
