'use server';

import { revalidatePath } from 'next/cache';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { requirePermission } from '@/lib/permissions/check';
import { PERMISSIONS } from '@/lib/permissions/permissions';

/**
 * Admin account actions (Spec Sections 8, 10): suspend and unsuspend a user.
 *
 * The `accounts` row carries an `is_suspended` boolean flag (0001). Migration
 * 0004 added `accounts_admin_update`, which lets anyone holding `users.suspend`
 * update any account row. These actions assert that permission app-side first,
 * then write through the RLS-scoped server client so the policy stays the
 * second line of defense — every write is attributable to the acting admin.
 *
 * Only async functions are exported from this 'use server' module.
 */

/** Uniform action result — honest, renderable errors for the admin UI. */
export interface UserActionResult {
  ok: boolean;
  error?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function revalidateUsersPage(): void {
  revalidatePath('/admin/users');
}

/** Suspend an account: set `is_suspended = true` (admin-update policy: users.suspend). */
export async function suspendUserAction(accountId: string): Promise<UserActionResult> {
  try {
    await requirePermission(PERMISSIONS.USERS_SUSPEND);
  } catch {
    return { ok: false, error: 'You need the users.suspend permission to suspend accounts.' };
  }

  if (!UUID_RE.test(accountId ?? '')) return { ok: false, error: 'Invalid account id.' };

  const db = await getSupabaseServerClient();
  const { error } = await db
    .from('accounts')
    .update({ is_suspended: true, updated_at: new Date().toISOString() })
    .eq('id', accountId);
  if (error) {
    return { ok: false, error: `Could not suspend the account: ${error.message}` };
  }

  revalidateUsersPage();
  return { ok: true };
}

/** Unsuspend an account: set `is_suspended = false` (admin-update policy: users.suspend). */
export async function unsuspendUserAction(accountId: string): Promise<UserActionResult> {
  try {
    await requirePermission(PERMISSIONS.USERS_SUSPEND);
  } catch {
    return { ok: false, error: 'You need the users.suspend permission to unsuspend accounts.' };
  }

  if (!UUID_RE.test(accountId ?? '')) return { ok: false, error: 'Invalid account id.' };

  const db = await getSupabaseServerClient();
  const { error } = await db
    .from('accounts')
    .update({ is_suspended: false, updated_at: new Date().toISOString() })
    .eq('id', accountId);
  if (error) {
    return { ok: false, error: `Could not unsuspend the account: ${error.message}` };
  }

  revalidateUsersPage();
  return { ok: true };
}
