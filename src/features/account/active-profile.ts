import 'server-only';

import { cookies } from 'next/headers';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/supabase/types';
import { getVerifiedAccount } from '@/features/auth/verified-account';

export const ACTIVE_PROFILE_COOKIE = 'lumora_active_profile';

export function isProfileId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/** The cookie selects a preference; the authenticated client's ownership query decides access. */
export async function resolveActiveProfileId(db: SupabaseClient<Database>, accountId: string): Promise<string | null> {
  const selected = (await cookies()).get(ACTIVE_PROFILE_COOKIE)?.value;
  if (isProfileId(selected)) {
    const { data, error } = await db.from('profiles').select('id')
      .eq('account_id', accountId).eq('id', selected).maybeSingle();
    if (error) throw new Error('Profile selection is temporarily unavailable.');
    if (data?.id.toLowerCase() === selected.toLowerCase()) return data.id;
  }

  // Missing, deleted, malformed, and foreign selections use this account's first profile only.
  const { data, error } = await db.from('profiles').select('id')
    .eq('account_id', accountId).order('created_at', { ascending: true }).limit(1);
  if (error) throw new Error('Profile selection is temporarily unavailable.');
  return data?.[0]?.id ?? null;
}

export async function getActiveProfileId(): Promise<string | null> {
  try {
    const account = await getVerifiedAccount();
    if (account.status !== 'authenticated') return null;
    return await resolveActiveProfileId(account.client, account.user.id);
  } catch {
    return null;
  }
}
