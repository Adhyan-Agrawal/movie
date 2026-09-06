import { features } from '@/lib/env';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import type { Permission } from './permissions';

/**
 * Authorization checks (Section 8).
 *
 * These mirror the SQL `public.has_permission(perm_key)` helper used by RLS:
 * a user holds a permission when one of their assigned roles
 * (`account_members` -> `role_permissions` -> `permissions`) grants that key.
 * We resolve it here with the RLS-scoped server client so route handlers can
 * authorize *before* touching data and return a clean 403 rather than leaking
 * an empty result set.
 *
 * When Supabase is unconfigured (mock mode) every check degrades to `false` —
 * the app stays runnable, but nothing privileged is ever granted by default.
 *
 * This module depends on `next/headers` (via the server client) and is
 * therefore server-only; importing it into a client bundle will fail to build.
 */

/** Thrown by {@link requirePermission} when the caller lacks a permission. */
export class PermissionDeniedError extends Error {
  readonly permission: Permission;
  /** Convenience for route handlers mapping errors to HTTP responses. */
  readonly status = 403 as const;

  constructor(permission: Permission) {
    super(`Missing required permission: ${permission}`);
    this.name = 'PermissionDeniedError';
    this.permission = permission;
  }
}

/**
 * Returns true when the current signed-in user holds `perm`. Never throws for
 * an unauthenticated/unconfigured/denied case — it simply returns false.
 */
export async function hasPermission(perm: Permission): Promise<boolean> {
  if (!features.supabaseConfigured) return false;

  const supabase = await getSupabaseServerClient();

  const { data: userResult, error: userError } = await supabase.auth.getUser();
  if (userError || !userResult.user) return false;
  const accountId = userResult.user.id;

  // 1. Roles assigned to this account.
  const { data: memberships, error: membershipError } = await supabase
    .from('account_members')
    .select('role_id')
    .eq('account_id', accountId);
  if (membershipError || !memberships || memberships.length === 0) return false;
  const roleIds = memberships.map((row) => row.role_id);

  // 2. Resolve the permission key to its id.
  const { data: permissionRow, error: permissionError } = await supabase
    .from('permissions')
    .select('id')
    .eq('key', perm)
    .maybeSingle();
  if (permissionError || !permissionRow) return false;

  // 3. Does any of the user's roles grant that permission?
  const { data: grant, error: grantError } = await supabase
    .from('role_permissions')
    .select('role_id')
    .eq('permission_id', permissionRow.id)
    .in('role_id', roleIds)
    .limit(1)
    .maybeSingle();
  if (grantError) return false;

  return grant !== null;
}

/**
 * Asserts the current user holds `perm`, throwing {@link PermissionDeniedError}
 * otherwise. Use at the top of privileged services / route handlers.
 */
export async function requirePermission(perm: Permission): Promise<void> {
  const allowed = await hasPermission(perm);
  if (!allowed) throw new PermissionDeniedError(perm);
}

/** True when the user holds at least one of the supplied permissions. */
export async function hasAnyPermission(perms: readonly Permission[]): Promise<boolean> {
  for (const perm of perms) {
    if (await hasPermission(perm)) return true;
  }
  return false;
}
