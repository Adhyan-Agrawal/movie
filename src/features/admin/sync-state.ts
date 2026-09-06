/**
 * Sync-action state shared between the admin UI and the server action.
 * Kept OUTSIDE the `'use server'` module — a 'use server' file may only export
 * async functions (a plain object export gets compiled into a server-reference
 * proxy on the client and breaks useActionState).
 */
export interface SyncActionState {
  status: 'idle' | 'ok' | 'error';
  message: string;
  /** Detail counts shown on success. */
  movies?: number;
  series?: number;
  seasons?: number;
  genres?: number;
  skipped?: number;
  failed?: number;
}

export const SYNC_INITIAL_STATE: SyncActionState = { status: 'idle', message: '' };
