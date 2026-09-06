/**
 * Auth form state shared between the client forms and the server actions.
 *
 * NOTE: this deliberately lives OUTSIDE the `'use server'` actions module — a
 * `'use server'` file may only export async functions; exporting a plain object
 * from one gets compiled into a server-reference *proxy* on the client (not the
 * value), which breaks `useActionState` hydration.
 */
export interface AuthActionState {
  /** Human-readable error from Supabase (or a generic fallback). null = success. */
  error: string | null;
}

export const AUTH_INITIAL_STATE: AuthActionState = { error: null };
