'use server';

import { revalidatePath } from 'next/cache';
import { getVerifiedAccount } from '@/features/auth/verified-account';
import { AUTH_EMAIL_UNVERIFIED } from '@/features/auth/state';
import { ACCOUNT_SERVICES_UNAVAILABLE } from './availability';

export type NotificationActionResult = { ok: boolean; error?: string };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function markRead(id?: string): Promise<NotificationActionResult> {
  try {
    const account = await getVerifiedAccount();
    if (account.status === 'unauthenticated') return { ok: false, error: 'Sign in to manage your notifications.' };
    if (account.status === 'unverified') return { ok: false, error: AUTH_EMAIL_UNVERIFIED };
    if (account.status !== 'authenticated') return { ok: false, error: ACCOUNT_SERVICES_UNAVAILABLE };
    if (id !== undefined && (typeof id !== 'string' || !UUID_RE.test(id))) {
      return { ok: false, error: 'Invalid notification id.' };
    }

    const update = account.client.from('notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('account_id', account.user.id)
      .is('read_at', null);
    if (id !== undefined) {
      const { data: updated, error } = await update.eq('id', id).select('id')
        .abortSignal(AbortSignal.timeout(10_000)).maybeSingle();
      if (error) return { ok: false, error: 'Could not mark the notification as read. Please try again.' };
      if (!updated) {
        // A retry is successful only if the same account already owns a read row.
        const { data: existing, error: readError } = await account.client.from('notifications')
          .select('id, read_at').eq('id', id).eq('account_id', account.user.id)
          .abortSignal(AbortSignal.timeout(10_000)).maybeSingle();
        if (readError || !existing?.read_at) return { ok: false, error: 'Notification not found or no longer available.' };
      }
    } else {
      const { error } = await update.abortSignal(AbortSignal.timeout(10_000));
      if (error) return { ok: false, error: 'Could not mark your notifications as read. Please try again.' };
    }
    revalidatePath('/account/notifications');
    return { ok: true };
  } catch {
    return { ok: false, error: 'Could not update your notifications. Please try again.' };
  }
}

export async function markNotificationReadAction(id: string): Promise<NotificationActionResult> {
  if (typeof id !== 'string') return { ok: false, error: 'Invalid notification id.' };
  return markRead(id);
}

export async function markAllNotificationsReadAction(): Promise<NotificationActionResult> {
  return markRead();
}
