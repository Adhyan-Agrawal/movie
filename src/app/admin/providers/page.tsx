import { PageHeader } from '@/components/ui/PageHeader';
import { ProvidersExplorer } from '@/features/admin/ProvidersExplorer';

export const metadata = {
  title: 'Providers',
  description: 'Playback provider adapters and configuration.',
};

export default function AdminProvidersPage() {
  return (
    <div className="py-6">
      <PageHeader
        title="Providers"
        description="Playback adapters and their configuration. The Vidsrc/VSEmbed fields are shown read-only; changes are audited settings (Section 9)."
      />
      <ProvidersExplorer />
    </div>
  );
}
