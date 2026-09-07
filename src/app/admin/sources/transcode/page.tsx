import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Container } from '@/components/ui/Container';
import { PageHeader } from '@/components/ui/PageHeader';
import { TranscodePanel } from '@/features/admin/TranscodePanel';
import { listAdminTitles, listTranscodeCandidates } from '@/features/admin/queries';
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
 * action re-checks the same permission before any storage/DB write.
 *
 * Loads every storage-backed media source (uploaded files in the private
 * `media` bucket) plus the most recent titles, so an operator can transcode an
 * existing upload or upload a new file in one place.
 */
export default async function AdminTranscodePage() {
  const allowed = await hasPermission(PERMISSIONS.PROVIDER_MANAGE);
  if (!allowed) notFound();

  const [candidates, titles] = await Promise.all([
    listTranscodeCandidates(),
    listAdminTitles({ pageSize: 100 }),
  ]);

  return (
    <Container className="pb-16">
      <PageHeader
        title="Transcode to HLS"
        description="Turn an uploaded file in private storage into an adaptive HLS ladder (1080p / 720p / 480p + master playlist) served through the native player's quality selector."
      />
      <TranscodePanel candidates={candidates} recentTitles={titles.rows} />
    </Container>
  );
}
