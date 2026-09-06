import type { Metadata } from 'next';
import { EmptyState } from '@/components/ui/EmptyState';

export const metadata: Metadata = { title: 'Devices' };

export default function DevicesPage() {
  // Session management isn't wired yet — honest empty state, no mock sessions.
  return (
    <section aria-labelledby="devices-heading" className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h2 id="devices-heading" className="text-lg font-semibold">
          Signed-in devices
        </h2>
        <p className="text-sm text-content-muted">Manage where you’re signed in.</p>
      </div>

      <EmptyState
        icon="🖥"
        title="No managed devices yet"
        description="Active device management arrives with the security settings phase."
      />
    </section>
  );
}
