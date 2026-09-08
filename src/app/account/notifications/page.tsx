import type { Metadata } from 'next';
import { EmptyState } from '@/components/ui/EmptyState';

export const metadata: Metadata = { title: 'Notifications' };

/**
 * Account notifications (Spec Section 8). Nothing writes notifications to an
 * account today, and email delivery awaits operator-configured SMTP, so this
 * page stays an honest empty state rather than inventing rows or channels.
 */
export default function NotificationsPage() {
  return (
    <section aria-labelledby="notifications-heading" className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h2 id="notifications-heading" className="text-lg font-semibold">
          Notifications
        </h2>
        <p className="text-sm text-content-muted">Choose how Lumora reaches you.</p>
      </div>

      <EmptyState
        icon="🔔"
        title="You’re all caught up"
        description="There are no notifications for this account yet. When there’s something to tell you — a new title, a request update, or an account notice — it will appear here."
      />

      <div className="rounded-lg border border-border bg-surface/40 px-5 py-4 text-sm text-content-muted">
        <p className="font-medium text-content">About email</p>
        <p className="mt-1">
          Email notifications aren’t sent yet. Lumora will use the operator-configured SMTP relay once an administrator
          enables it in the admin area (Email settings); until then, all account notices stay inside the app.
        </p>
      </div>
    </section>
  );
}
