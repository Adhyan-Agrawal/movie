import type { Metadata } from 'next';
import { Container } from '@/components/ui/Container';
import { PageHeader } from '@/components/ui/PageHeader';
import { EmptyState } from '@/components/ui/EmptyState';
import { BulkSourceImporterPanel } from '@/features/admin/BulkSourceImporterPanel';
import { SourceHealthChecker } from '@/features/admin/SourceHealthChecker';
import { PermissionDeniedError, requirePermission } from '@/lib/permissions/check';
import { PERMISSIONS } from '@/lib/permissions/permissions';

export const metadata: Metadata = {
  title: 'Bulk sources',
  robots: { index: false, follow: false },
};

/**
 * Admin bulk-source tools (Spec Sections 9, 14, 15): paste-CSV import of many
 * remote streams plus a live health probe of existing remote sources.
 *
 * Gated page-level by `provider.manage` (matching the `media_sources_manage`
 * RLS policy) so catalog.read-only admins get an honest "not authorized" panel
 * instead of a form that would only fail server-side. Both actions re-assert
 * the same permission as a second layer.
 */
export default async function AdminBulkSourcesPage() {
  try {
    await requirePermission(PERMISSIONS.PROVIDER_MANAGE);
  } catch (err) {
    if (err instanceof PermissionDeniedError) {
      return (
        <Container className="pb-16">
          <PageHeader
            title="Bulk sources"
            description="CSV import and health checks for remote media sources."
          />
          <EmptyState
            icon="⇈"
            title="Provider.manage required"
            description="You need the provider.manage permission to bulk-import or health-check media sources."
          />
        </Container>
      );
    }
    throw err;
  }

  return (
    <Container className="pb-16">
      <PageHeader
        title="Bulk sources"
        description="Import many remote stream sources at once from a pasted CSV, then probe the health of existing remote sources."
      />
      <div className="flex flex-col gap-6">
        <BulkSourceImporterPanel />
        <SourceHealthChecker />
      </div>
    </Container>
  );
}
