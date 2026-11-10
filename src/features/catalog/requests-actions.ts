'use server';

import type { TitleRequestState } from './request-state';
import { features } from '@/lib/env';
import { ACCOUNT_SERVICES_UNAVAILABLE } from '@/features/account/availability';
import { AUTH_EMAIL_UNVERIFIED } from '@/features/auth/state';
import { getVerifiedAccount } from '@/features/auth/verified-account';

/**
 * Request-a-title server action (Spec Section 4: "request a movie/series not
 * in the catalog").
 *
 * Signed-in viewers submit a title they can't find; the row lands in
 * `title_requests` (RLS-scoped, so it is only visible to the requesting
 * account) and catalog editors work the queue from /admin/requests.
 *
 * The insert goes through the RLS-scoped server client — `account_id` is set
 * from the signed-in session, and the `title_requests_self_insert` policy
 * (account_id = auth.uid()) enforces it on the DB side too. Anonymous callers
 * are rejected up front so the form can show a real message instead of a bare
 * RLS error.
 *
 * Only async functions are exported from this 'use server' module.
 */
export async function submitTitleRequestAction(
  _prev: TitleRequestState,
  formData: FormData,
): Promise<TitleRequestState> {
  if (!features.supabaseConfigured) return { status: 'error', message: ACCOUNT_SERVICES_UNAVAILABLE };
  const titleName = String(formData.get('title_name') ?? '').trim();
  const mediaType = String(formData.get('media_type') ?? '').trim();
  const yearRaw = String(formData.get('year') ?? '').trim();
  const note = String(formData.get('note') ?? '').trim();

  if (!titleName) {
    return { status: 'error', message: 'Enter the name of the title you want.' };
  }
  if (mediaType !== 'movie' && mediaType !== 'tv') {
    return { status: 'error', message: 'Pick whether it is a movie or a series.' };
  }

  let year: number | null = null;
  if (yearRaw) {
    const parsed = Number(yearRaw);
    if (!Number.isInteger(parsed) || parsed < 1878 || parsed > 2100) {
      return { status: 'error', message: 'Year must be between 1878 and 2100.' };
    }
    year = parsed;
  }

  try {
    const account = await getVerifiedAccount();
    if (account.status === 'unauthenticated') return { status: 'error', message: 'Sign in to request a title.' };
    if (account.status === 'unverified') return { status: 'error', message: AUTH_EMAIL_UNVERIFIED };
    if (account.status !== 'authenticated') return { status: 'error', message: ACCOUNT_SERVICES_UNAVAILABLE };

    // Keep the insert user-scoped; form fields never select the owning account.
    // title_requests is not yet represented in the generated database types.
    const { error } = await (account.client as any)
      .from('title_requests')
      .insert({
        account_id: account.user.id,
        title_name: titleName,
        media_type: mediaType,
        year,
        note: note || null,
      });
    if (error) return { status: 'error', message: 'Could not save your request. Please try again.' };
    return { status: 'ok', message: 'Got it — we will look into adding it.' };
  } catch { return { status: 'error', message: ACCOUNT_SERVICES_UNAVAILABLE }; }
}
