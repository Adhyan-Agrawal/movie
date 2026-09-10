import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

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
const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'Missing EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY — copy mobile/.env.example to mobile/.env.',
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});
