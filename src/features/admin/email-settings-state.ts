/**
 * Email-settings action state shared between the admin panel and the server
 * actions. Kept OUTSIDE the `'use server'` module — a 'use server' file may
 * only export async functions (a plain object export gets compiled into a
 * server-reference proxy on the client and breaks useActionState).
 */
export interface EmailSettingsState {
  status: 'idle' | 'ok' | 'error';
  message: string;
}

export const EMAIL_SETTINGS_INITIAL_STATE: EmailSettingsState = { status: 'idle', message: '' };
