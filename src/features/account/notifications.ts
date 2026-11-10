import 'server-only';

import { unstable_noStore as noStore } from 'next/cache';
import { getVerifiedAccount } from '@/features/auth/verified-account';
import type { Tables } from '@/lib/supabase/types';

export type AccountNotification = Pick<Tables<'notifications'>, 'id' | 'kind' | 'title' | 'body' | 'read_at' | 'created_at'>;
export type NotificationFeedResult =
  | { status: 'ready'; notifications: AccountNotification[]; older: string | null; isOlderPage: boolean }
  | { status: 'error'; error: string }
  | { status: 'unauthenticated' | 'unverified' | 'unavailable' };

const PAGE_SIZE = 20;
const CURSOR_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2}))\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** Account-wide, user/RLS-scoped notices. Never expose arbitrary data JSON. */
export async function listAccountNotifications(before?: string): Promise<NotificationFeedResult> {
  noStore();
  try {
    const account = await getVerifiedAccount();
    if (account.status !== 'authenticated') return { status: account.status };
    const cursor = typeof before === 'string' ? CURSOR_RE.exec(before) : null;
    if (before !== undefined && (!cursor || !Number.isFinite(Date.parse(cursor[1]!)))) {
      return { status: 'error', error: 'This notifications page is invalid. Return to the newest notices.' };
    }

    let query = account.client.from('notifications')
      .select('id, kind, title, body, read_at, created_at')
      .eq('account_id', account.user.id)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(PAGE_SIZE + 1);
    // Preserve PostgreSQL timestamp precision and use the UUID to break ties.
    // Both cursor fields are strictly admitted before entering PostgREST syntax.
    if (cursor) query = query.or(`created_at.lt.${cursor[1]},and(created_at.eq.${cursor[1]},id.lt.${cursor[2]})`);
    const { data, error } = await query.abortSignal(AbortSignal.timeout(10_000));
    if (error || !data) return { status: 'error', error: 'Could not load your notifications. Please try again.' };
    const notifications = data.slice(0, PAGE_SIZE).map(({ id, kind, title, body, read_at, created_at }) =>
      ({ id, kind, title, body, read_at, created_at }));
    const last = notifications.at(-1);
    return {
      status: 'ready', notifications, isOlderPage: Boolean(cursor),
      older: data.length > PAGE_SIZE && last ? `${last.created_at}|${last.id}` : null,
    };
  } catch {
    return { status: 'error', error: 'Could not load your notifications. Please try again.' };
  }
}
