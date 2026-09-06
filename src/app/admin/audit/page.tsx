import { PageHeader } from '@/components/ui/PageHeader';
import { AuditExplorer } from '@/features/admin/AuditExplorer';
import { listAuditEvents } from '@/features/admin/queries';

export const metadata = {
  title: 'Audit',
  description: 'Immutable change history with before/after diffs.',
};

export default async function AdminAuditPage() {
  const events = await listAuditEvents(100);

  return (
    <div className="py-6">
      <PageHeader
        title="Audit log"
        description="Append-only record of sensitive actions from the audit_logs table (audit.read) — actor, target, before/after, reason, and outcome."
      />
      <AuditExplorer events={events} />
    </div>
  );
}
