/**
 * Auth form state shared between the client forms and the server actions.
 *
 * NOTE: this deliberately lives OUTSIDE the `'use server'` actions module — a
 * `'use server'` file may only export async functions; exporting a plain object
 * from one gets compiled into a server-reference *proxy* on the client (not the
 * value), which breaks `useActionState` hydration.
 */
export interface AuthActionState {
  /** Application-owned error text; null is not proof of an authenticated session. */
  error: string | null;
  message?: string;
}

export const AUTH_SERVICE_UNAVAILABLE = 'Account services are temporarily unavailable. Your session may still be active. Please try again shortly.';

export const AUTH_INITIAL_STATE: AuthActionState = { error: null };
