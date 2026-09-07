import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/ui/PageHeader';
import { hasPermission } from '@/lib/permissions/check';
import { PERMISSIONS } from '@/lib/permissions/permissions';
import { listTitleRequests } from '@/features/admin/queries';
import { RequestsPanel } from '@/features/admin/RequestsPanel';

export const metadata: Metadata = {
  title: 'Requests',
  robots: { index: false, follow: false },
};

/**
 * Admin title-request queue (Spec Section 4). Lists viewer-submitted requests
 * for titles not yet in the catalog; editors import a pending request from TMDB
 * (catalog.create) or reject it.
 *
 * Explicitly gated on `catalog.read` here — the admin layout admits anyone with
 * *any* console permission, but this page's data (and the queue) only makes
 * sense for catalog editors, matching the `title_requests_admin_read` RLS
 * policy. Non-editors get a 404 so the surface stays un-discoverable.
 */
export default async function AdminRequestsPage() {
  const canReadRequests = await hasPermission(PERMISSIONS.CATALOG_READ);
  if (!canReadRequests) notFound();

  const requests = await listTitleRequests();

  return (
    <div className="py-6">
      <PageHeader
        title="Title requests"
        description="Movies and series viewers have asked for. Import a pending request from TMDB, or reject it if it doesn't fit the catalog."
      />
      <RequestsPanel requests={requests} />
    </div>
  );
}
