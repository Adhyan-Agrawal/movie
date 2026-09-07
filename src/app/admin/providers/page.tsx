import { PageHeader } from '@/components/ui/PageHeader';
import { ProvidersExplorer } from '@/features/admin/ProvidersExplorer';
import { listProviderRows } from '@/features/admin/queries';

export const metadata = {
  title: 'Providers',
  description: 'Playback provider adapters and configuration.',
};

export default async function AdminProvidersPage() {
  const rows = await listProviderRows();

  return (
    <div className="py-6">
      <PageHeader
        title="Providers"
        description="Playback providers from the database (provider.manage), plus the built-in adapters configured in code. The database row drives enablement and stored health."
      />
      <ProvidersExplorer rows={rows} />
    </div>
  );
}
