import type { Metadata } from 'next';
import { AdminSidebar } from '@/features/admin/AdminSidebar';
import { AdminUnauthorizedState } from '@/features/admin/UnauthorizedState';
import { hasAnyPermission } from '@/lib/permissions/check';
import { PERMISSIONS, type Permission } from '@/lib/permissions/permissions';

/**
 * Admin console chrome (Section 3 — admin navigation is separate). The root
 * layout already wraps everything in the public AppShell, so this renders a
 * distinct console shell *inside* the main content region: a dedicated admin
 * sidebar. Admin routes are noindex (Section 16).
 */

export const metadata: Metadata = {
  title: { default: 'Admin', template: '%s · Admin · Lumora' },
  robots: { index: false, follow: false },
};

/**
 * Any one of these grants entry to the console (Section 8). Checked
 * server-side via the RLS-scoped session, so anonymous visitors, the mock
 * mode, and accounts without an admin role all land on the unauthorized
 * state below rather than the console itself.
 */
const ADMIN_PERMISSIONS = [
  PERMISSIONS.CATALOG_READ,
  PERMISSIONS.USERS_READ,
  PERMISSIONS.SETTINGS_MANAGE,
  PERMISSIONS.ANALYTICS_READ,
  PERMISSIONS.AUDIT_READ,
  PERMISSIONS.PROVIDER_MANAGE,
  PERMISSIONS.ADS_MANAGE,
  PERMISSIONS.ROLES_MANAGE,
] as const satisfies readonly Permission[];

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const canUseConsole = await hasAnyPermission(ADMIN_PERMISSIONS);

  return (
    <div className="mx-auto w-full max-w-[96rem] px-4 md:px-8">
      <div className="flex flex-col gap-4 md:flex-row md:gap-6">
        <AdminSidebar />
        <div className="min-w-0 flex-1 pb-8">
          {canUseConsole ? children : <AdminUnauthorizedState />}
        </div>
      </div>
    </div>
  );
}
