import { cache } from 'react';
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
const currentPermissionKeys = cache(async (): Promise<Set<string>> => {
  if (!features.supabaseConfigured) return new Set();
  try {
    const supabase = await getSupabaseServerClient();
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) return new Set();
    const { data: account, error: accountError } = await supabase.from('accounts')
      .select('is_suspended').eq('id', data.user.id).maybeSingle();
    if (accountError || !account || account.is_suspended) return new Set();
    const { data: memberships, error: memberError } = await supabase.from('account_members')
      .select('role_id').eq('account_id', data.user.id);
    if (memberError || !memberships?.length) return new Set();
    const { data: grants, error: grantError } = await supabase.from('role_permissions')
      .select('permission_id').in('role_id', memberships.map((row) => row.role_id));
    if (grantError || !grants?.length) return new Set();
    const { data: permissions, error: permissionError } = await supabase.from('permissions')
      .select('key').in('id', [...new Set(grants.map((row) => row.permission_id))]);
    return permissionError ? new Set() : new Set((permissions ?? []).map((row) => row.key));
  } catch {
    return new Set();
  }
});

export async function hasPermission(perm: Permission): Promise<boolean> {
  return (await currentPermissionKeys()).has(perm);
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
  const keys = await currentPermissionKeys();
  return perms.some((perm) => keys.has(perm));
}
