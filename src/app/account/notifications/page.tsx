import type { Metadata } from 'next';
import { EmptyState } from '@/components/ui/EmptyState';

export const metadata: Metadata = { title: 'Notifications' };

export default function NotificationsPage() {
  // Notification preferences persistence isn't wired yet — honest empty state.
  return (
    <section aria-labelledby="notifications-heading" className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h2 id="notifications-heading" className="text-lg font-semibold">
          Notifications
        </h2>
        <p className="text-sm text-content-muted">Choose how Lumora reaches you.</p>
      </div>

      <EmptyState icon="🔔" title="No notifications" description="No notifications." />
    </section>
  );
}
