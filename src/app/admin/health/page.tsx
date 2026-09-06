import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { HealthGrid } from '@/features/admin/HealthGrid';
import { HEALTH_SERVICES, REPORTING_TIMEZONE } from '@/features/admin/mock';

export const metadata = {
  title: 'Health',
  description: 'Service and provider health checks.',
};

export default function AdminHealthPage() {
  return (
    <div className="py-6">
      <PageHeader
        title="Health"
        description="Database, auth, storage, TMDB, email, ads, and playback checks (Section 15). Probes run every 5 minutes."
        actions={
          <Button variant="secondary" size="sm">
            Re-run checks
          </Button>
        }
      />
      <HealthGrid services={HEALTH_SERVICES} />
      <p className="mt-4 text-xs text-content-subtle">Timestamps shown in {REPORTING_TIMEZONE}.</p>
    </div>
  );
}
