/**
 * Permission catalogue (Section 8).
 *
 * The keys here are the single source of truth on the app side and MUST stay in
 * lockstep with the `permissions` rows seeded in migration 0002 and the
 * `public.has_permission(perm_key)` SQL helper used by RLS policies.
 */

export const PERMISSIONS = {
  CATALOG_READ: 'catalog.read',
  CATALOG_CREATE: 'catalog.create',
  CATALOG_PUBLISH: 'catalog.publish',
  CATALOG_DELETE: 'catalog.delete',
  PROVIDER_MANAGE: 'provider.manage',
  ADS_MANAGE: 'ads.manage',
  EMAIL_MANAGE: 'email.manage',
  USERS_READ: 'users.read',
  USERS_SUSPEND: 'users.suspend',
  ROLES_MANAGE: 'roles.manage',
  ANALYTICS_READ: 'analytics.read',
  SETTINGS_MANAGE: 'settings.manage',
  AUDIT_READ: 'audit.read',
  HEALTH_READ: 'health.read',
} as const;

/** Every valid permission key, as a string-literal union. */
export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

/** All permission keys as a readonly array (useful for admin UIs / seeding). */
export const ALL_PERMISSIONS: readonly Permission[] = Object.values(PERMISSIONS);

/** Type guard: is an arbitrary string a known permission key? */
export function isPermission(value: string): value is Permission {
  return (ALL_PERMISSIONS as readonly string[]).includes(value);
}

/**
 * Sensitive actions that require step-up re-authentication AND an audit event
 * before they proceed (Section 8: "Re-authentication plus audit event for role
 * changes, secret rotation, bulk delete, account deletion, and provider
 * changes"). These are coarse action identifiers, not permission keys.
 */
export const SENSITIVE_ACTIONS = [
  'role.change',
  'secret.rotate',
  'bulk.delete',
  'account.delete',
  'provider.change',
] as const;

export type SensitiveAction = (typeof SENSITIVE_ACTIONS)[number];

/** True when the given action must be gated behind a fresh re-auth. */
export function requiresReauth(action: string): action is SensitiveAction {
  return (SENSITIVE_ACTIONS as readonly string[]).includes(action);
}
