import Link from 'next/link';
import { listTitles } from '@/features/catalog/queries';
import { PageHeader } from '@/components/ui/PageHeader';
import { buttonClasses } from '@/components/ui/Button';
import { TitlesTable } from '@/features/admin/TitlesTable';

export const metadata = {
  title: 'Catalog',
  description: 'Create, publish, and organize titles.',
};

export default async function AdminCatalogTitlesPage() {
  const titles = await listTitles();

  return (
    <div className="py-6">
      <PageHeader
        title="Catalog · Titles"
        description="Draft, schedule, publish, and archive titles. Bulk actions are confirmed and audited."
        actions={
          <Link href="/admin/catalog/titles" className={buttonClasses({ variant: 'primary', size: 'sm' })}>
            New title
          </Link>
        }
      />
      <TitlesTable titles={titles} />
    </div>
  );
}
