/**
 * Email-templates action state shared between the admin panel and the server
 * actions. Kept OUTSIDE the `'use server'` module — a 'use server' file may
 * only export async functions (a plain object export gets compiled into a
 * server-reference proxy on the client and breaks direct calls from the panel).
 */
export interface TemplateActionState {
  status: 'idle' | 'ok' | 'error';
  message: string;
}

export const TEMPLATE_ACTION_INITIAL_STATE: TemplateActionState = { status: 'idle', message: '' };
