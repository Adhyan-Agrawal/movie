/**
 * Request-a-title form state shared between the client form and the server
 * action.
 *
 * Kept OUTSIDE the `'use server'` actions module for the same reason as
 * `auth/state.ts`: a 'use server' file may only export async functions, and a
 * plain object export would be compiled into a server-reference proxy on the
 * client, breaking `useActionState` hydration.
 */
export interface TitleRequestState {
  status: 'ok' | 'error';
  message: string;
}

export const REQUEST_INITIAL_STATE: TitleRequestState = { status: 'ok', message: '' };
