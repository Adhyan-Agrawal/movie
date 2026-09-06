import type { Metadata } from 'next';
import { Container } from '@/components/ui/Container';
import { PageHeader } from '@/components/ui/PageHeader';
import { CatalogSyncPanel } from '@/features/admin/CatalogSyncPanel';

export const metadata: Metadata = {
  title: 'TMDB sync',
  robots: { index: false, follow: false },
};

/** Admin TMDB sync route (Spec Sections 4, 7, 10). Gated by the admin layout. */
export default function AdminSyncPage() {
  return (
    <Container className="pb-16">
      <PageHeader
        title="TMDB sync"
        description="One-click import of real movies and series from TMDB into the live catalog."
      />
      <CatalogSyncPanel />
    </Container>
  );
}
