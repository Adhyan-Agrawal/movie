import type { Metadata } from 'next';
import { NotificationsFeed } from '@/features/account/NotificationsFeed';
import { listAccountNotifications } from '@/features/account/notifications';
import { UnauthorizedState } from '@/features/account/UnauthorizedState';

export const metadata: Metadata = { title: 'Notifications' };
export const dynamic = 'force-dynamic';

export default async function NotificationsPage({ searchParams }: {
  searchParams: Promise<{ before?: string | string[] }>;
}) {
  const { before } = await searchParams;
  const feed = await listAccountNotifications(typeof before === 'string' ? before : before === undefined ? undefined : 'invalid');
  if (feed.status !== 'ready' && feed.status !== 'error') {
    return <UnauthorizedState next="/account/notifications" unavailable={feed.status === 'unavailable'} unverified={feed.status === 'unverified'} />;
  }
  return (
    <section aria-labelledby="notifications-heading" className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h2 id="notifications-heading" className="text-lg font-semibold">
          Notifications
        </h2>
        <p className="text-sm text-content-muted">Request updates and notices saved to your account.</p>
      </div>

      <NotificationsFeed feed={feed} />

      <div className="rounded-lg border border-border bg-surface/40 px-5 py-4 text-sm text-content-muted">
        <p className="font-medium text-content">About email</p>
        <p className="mt-1">
          These notices are saved inside Lumora. Request-status notifications are not sent by email.
        </p>
      </div>
    </section>
  );
}
