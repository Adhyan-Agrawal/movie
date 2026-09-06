import { listTitles } from '@/features/catalog/queries';
import { PageHeader } from '@/components/ui/PageHeader';
import { TitlesTable } from '@/features/admin/TitlesTable';

export const metadata = {
  title: 'Catalog',
  description: 'Browse the live catalog of titles.',
};

export default async function AdminCatalogTitlesPage() {
  const titles = await listTitles();

  return (
    <div className="py-6">
      <PageHeader
        title="Catalog · Titles"
        description="Titles from the live catalog (catalog.read). Publish, archive, and delete actions arrive with the catalog-management phase."
      />
      <TitlesTable titles={titles} />
    </div>
  );
}
