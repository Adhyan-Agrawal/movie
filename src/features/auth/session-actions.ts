'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getVerifiedAccount } from './verified-account';
import { AUTH_EMAIL_UNVERIFIED, AUTH_SERVICE_UNAVAILABLE, type AuthActionState } from './state';

export async function signOutSessionsAction(
  _prev: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const scopes = formData.getAll('scope');
  const scope = scopes[0];
  if (scopes.length !== 1 || (scope !== 'others' && scope !== 'global')) {
    return { error: 'Choose other sessions or all sessions.' };
  }
  if (formData.get('confirm') !== 'yes') {
    return { error: 'Confirm that you want to sign out the selected sessions.' };
  }

  try {
    const account = await getVerifiedAccount();
    if (account.status !== 'authenticated') {
      return { error: account.status === 'unavailable' ? AUTH_SERVICE_UNAVAILABLE
        : account.status === 'unverified' ? AUTH_EMAIL_UNVERIFIED : 'Sign in to manage your sessions.' };
    }

    const { error } = await account.client.auth.signOut({ scope });
    if (error) return { error: AUTH_SERVICE_UNAVAILABLE };
  } catch {
    return { error: AUTH_SERVICE_UNAVAILABLE };
  }

  // Only global clears this session; keep its redirect outside the error handler.
  if (scope === 'global') {
    revalidatePath('/', 'layout');
    redirect('/');
  }
  return {
    error: null,
    message: 'Sign-out requested for other sessions. This browser stays signed in. Existing access tokens remain valid until they expire.',
  };
}
