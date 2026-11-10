'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/Button';
import { AUTH_INITIAL_STATE, type AuthActionState } from './state';
import { signOutSessionsAction } from './session-actions';

export function SessionControlsForm() {
  const [state, formAction, pending] = useActionState<AuthActionState, FormData>(
    signOutSessionsAction,
    AUTH_INITIAL_STATE,
  );

  return (
    <form action={formAction} aria-busy={pending} aria-describedby="session-expiry" className="flex flex-col gap-4 rounded-lg border border-border bg-surface/40 p-5">
      <h3 className="font-medium text-content">Session controls</h3>
      <p id="session-expiry" className="text-sm text-content-muted">
        Signing out revokes refresh tokens, but existing access tokens remain valid until they expire.
        Other browsers and apps may retain access until then; this does not immediately block their access.
      </p>
      <p className="text-sm text-content-muted">
        Other sessions leaves this browser signed in. Everywhere also signs out this browser.
        These controls cannot target an individual device.
      </p>

      {state.error ? (
        <p role="alert" className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
          {state.error}
        </p>
      ) : null}
      {pending || (!state.error && state.message) ? (
        <p role="status" className="text-sm text-content-muted">
          {pending ? 'Updating sessions...' : state.message}
        </p>
      ) : null}

      <label className="flex min-h-11 items-center gap-3 text-sm text-content">
        <input type="checkbox" name="confirm" value="yes" required disabled={pending} className="h-4 w-4 shrink-0 accent-primary focus-visible:ring-2 focus-visible:ring-primary" />
        I want to sign out the selected sessions, including this browser if I choose everywhere.
      </label>
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
        <Button type="submit" name="scope" value="others" variant="secondary" disabled={pending} className="w-full focus-visible:ring-2 focus-visible:ring-primary sm:w-auto">
          Sign out other sessions
        </Button>
        <Button type="submit" name="scope" value="global" variant="secondary" disabled={pending} className="w-full border-danger/40 text-danger focus-visible:ring-2 focus-visible:ring-primary sm:w-auto">
          Sign out everywhere
        </Button>
      </div>
    </form>
  );
}
