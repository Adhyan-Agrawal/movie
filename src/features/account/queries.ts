import 'server-only';

import { features } from '@/lib/env';
import { getVerifiedAccount } from '@/features/auth/verified-account';
import { toMaturityLevel, type AccountProfile } from './types';

/**
 * Server-side account reads (Section 6). Reads the signed-in user's own rows
 * via the request-scoped Supabase client — RLS scopes `profiles` to
 * `account_id = auth.uid()`, and the service client is NEVER imported here.
 * When a read cannot run (Supabase unconfigured or a DB error) we return an
 * empty result so pages render honest empty states, never fabricated data.
 */

/** Row shape of the `profiles` table (see src/lib/supabase/types.ts). */
interface ProfileRow {
  id: string;
  name: string;
  avatar: string | null;
  maturity_ceiling: string;
  is_kids: boolean;
  created_at: string;
}

/** Resolve the signed-in user's email, or null when there is no session. */
export async function getSignedInEmail(): Promise<string | null> {
  const account = await getVerifiedAccount();
  return account.status === 'authenticated' ? account.user.email ?? null : null;
}

/** Resolve the signed-in user's id, or null when there is no session. */
export async function getSignedInAccountId(): Promise<string | null> {
  const account = await getVerifiedAccount();
  return account.status === 'authenticated' ? account.user.id : null;
}

/** List the REAL profiles belonging to the signed-in account (RLS-scoped). */
export async function listAccountProfiles(): Promise<AccountProfile[]> {
  if (!features.supabaseConfigured) return [];

  try {
    const account = await getVerifiedAccount();
    if (account.status !== 'authenticated') return [];
    const { data, error } = await account.client
      .from('profiles')
      .select('id, name, avatar, maturity_ceiling, is_kids, created_at')
      .eq('account_id', account.user.id)
      .order('created_at', { ascending: true });

    if (error) throw new Error(`listAccountProfiles: ${error.message}`);

    return (data ?? []).map((row: ProfileRow) => ({
      id: row.id,
      name: row.name,
      avatar: row.avatar,
      maturityCeiling: toMaturityLevel(row.maturity_ceiling),
      isKids: row.is_kids,
      createdAt: row.created_at,
    }));
  } catch (err) {
    console.warn('account.listAccountProfiles: read failed, returning empty list', {
      message: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
