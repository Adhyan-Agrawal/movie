import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Container } from '@/components/ui/Container';
import { PageHeader } from '@/components/ui/PageHeader';
import { TranscodePanel } from '@/features/admin/TranscodePanel';
import { hasPermission } from '@/lib/permissions/check';
import { PERMISSIONS } from '@/lib/permissions/permissions';

export const metadata: Metadata = {
  title: 'Transcode to HLS',
  robots: { index: false, follow: false },
};

/**
 * Admin HLS transcode route (Spec Sections 7, 9). The admin layout already
 * gates console entry; this page adds an explicit `provider.manage` check
 * (returning a 404, not a 403, so the route is not revealed) and the server
 * action re-checks the same permission. This guidance-only page does not load
 * private media candidates or titles because no web executor is configured.
 */
export default async function AdminTranscodePage() {
  const allowed = await hasPermission(PERMISSIONS.PROVIDER_MANAGE);
  if (!allowed) notFound();

  return (
    <Container className="pb-16">
      <PageHeader
        title="Transcode to HLS"
        description="Create HLS renditions with the offline operator tool. No web executor is configured; no job will be started here."
      />
      <TranscodePanel />
    </Container>
  );
}
