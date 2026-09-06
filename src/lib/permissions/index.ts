/**
 * Public surface of the permissions module (Section 8).
 *
 * Note: `./check` pulls in `next/headers` and is server-only. Importing this
 * barrel from a client component will therefore only be safe if you reference
 * the pure exports from `./permissions`. When in doubt, import `./permissions`
 * directly on the client.
 */
export {
  PERMISSIONS,
  ALL_PERMISSIONS,
  SENSITIVE_ACTIONS,
  isPermission,
  requiresReauth,
} from './permissions';
export type { Permission, SensitiveAction } from './permissions';

export {
  PermissionDeniedError,
  hasPermission,
  hasAnyPermission,
  requirePermission,
} from './check';
