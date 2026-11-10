'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, buttonClasses } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { markAllNotificationsReadAction, markNotificationReadAction } from './notification-actions';
import type { NotificationFeedResult } from './notifications';

export function NotificationsFeed({ feed }: {
  feed: Extract<NotificationFeedResult, { status: 'ready' | 'error' }>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  function markRead(id?: string) {
    setError(null);
    setMessage(null);
    startTransition(async () => {
      try {
        const result = id === undefined ? await markAllNotificationsReadAction() : await markNotificationReadAction(id);
        if (!result.ok) { setError(result.error ?? 'Could not update your notifications.'); return; }
        setMessage(id === undefined ? 'All notifications marked as read.' : 'Notification marked as read.');
        router.refresh();
      } catch {
        setError('Could not update your notifications. Please try again.');
      }
    });
  }

  if (feed.status === 'error') return (
    <EmptyState title="Notifications are unavailable" description={feed.error} tone="warning" action={
      <div className="flex flex-wrap justify-center gap-2">
        <Button variant="secondary" disabled={pending} onClick={() => startTransition(() => router.refresh())}>
          {pending ? 'Refreshing...' : 'Try again'}
        </Button>
        <Link href="/account/notifications" prefetch={false} className={buttonClasses({ variant: 'ghost' })}>Newest notices</Link>
      </div>
    } />
  );

  return (
    <div className="flex min-w-0 flex-col gap-4" aria-busy={pending}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-content-muted">Newest first. Includes notices for every profile on this account.</p>
        {feed.notifications.length > 0 ? <Button variant="secondary" disabled={pending} onClick={() => markRead()}>
          Mark all as read
        </Button> : null}
      </div>
      <div role="status" aria-live="polite" className="text-sm text-content-muted">
        {pending ? 'Updating notifications...' : message}
      </div>
      {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
      {feed.notifications.length === 0 ? (
        <EmptyState title={feed.isOlderPage ? 'No older notifications' : 'No notifications yet'}
          description="Request updates and account notices will appear here when there is something to tell you." />
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface/40">
          {feed.notifications.map((notice) => (
            <li key={notice.id} className="flex flex-col gap-4 p-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 flex-1 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="min-w-0 max-w-full break-words text-sm font-semibold">{notice.title}</h3>
                  <span className="rounded-full border border-border px-2 py-0.5 text-xs text-content-muted">
                    {notice.read_at ? 'Read' : 'Unread'}
                  </span>
                </div>
                <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-content-muted">{notice.body}</p>
                <time dateTime={notice.created_at} className="block text-xs text-content-subtle">
                  {new Date(notice.created_at).toISOString().slice(0, 16).replace('T', ' ')} UTC
                </time>
              </div>
              {!notice.read_at ? <Button variant="ghost" disabled={pending} className="shrink-0 self-start"
                aria-label={`Mark ${notice.title} as read`} onClick={() => markRead(notice.id)}>Mark as read</Button> : null}
            </li>
          ))}
        </ul>
      )}
      {feed.older || feed.isOlderPage ? <nav aria-label="Notification pages" className="flex flex-wrap justify-between gap-3">
        {feed.isOlderPage ? <Link href="/account/notifications" prefetch={false} className={buttonClasses({ variant: 'secondary' })}>
          Back to newest
        </Link> : <span />}
        {feed.older ? <Link href={`/account/notifications?before=${encodeURIComponent(feed.older)}`}
          prefetch={false}
          className={buttonClasses({ variant: 'secondary' })}>Older notices</Link> : null}
      </nav> : null}
    </div>
  );
}
