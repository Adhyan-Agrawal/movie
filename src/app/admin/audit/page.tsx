import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { AuditExplorer } from '@/features/admin/AuditExplorer';

export const metadata = {
  title: 'Audit',
  description: 'Immutable change history with before/after diffs.',
};

export default function AdminAuditPage() {
  return (
    <div className="py-6">
      <PageHeader
        title="Audit log"
        description="Append-only record of sensitive actions — actor, target, before/after, reason, and outcome (Section 7, 10)."
        actions={
          <Button variant="secondary" size="sm">
            Export CSV
          </Button>
        }
      />
      <AuditExplorer />
    </div>
  );
}
