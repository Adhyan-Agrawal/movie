'use client';

import { useActionState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/Button';
import { AUTH_INITIAL_STATE, signInAction, type AuthActionState } from '@/features/auth/actions';

/**
 * Sign-in form (Spec Section 8). Client component using useActionState so the
 * server action's Supabase error (bad credentials, etc.) renders inline with an
 * accessible alert role. No secrets are logged; the action returns only
 * Supabase's public error message.
 */
export function SignInForm({ next }: { next?: string }) {
  const [state, formAction, pending] = useActionState<AuthActionState, FormData>(
    signInAction,
    AUTH_INITIAL_STATE,
  );

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      {state.error ? (
        <p role="alert" className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
          {state.error}
        </p>
      ) : null}

      <div className="flex flex-col gap-1.5">
        <label htmlFor="signin-email" className="text-sm font-medium text-content">
          Email
        </label>
        <input
          id="signin-email"
          name="email"
          type="email"
          autoComplete="email"
          required
          className="h-11 rounded-md border border-border bg-surface-raised px-3 text-sm text-content placeholder:text-content-subtle focus-visible:outline-none focus-visible:border-primary"
          placeholder="you@example.com"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="signin-password" className="text-sm font-medium text-content">
          Password
        </label>
        <input
          id="signin-password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className="h-11 rounded-md border border-border bg-surface-raised px-3 text-sm text-content placeholder:text-content-subtle focus-visible:outline-none focus-visible:border-primary"
          placeholder="Your password"
        />
      </div>

      <input type="hidden" name="next" value={next ?? ''} />

      <Button type="submit" disabled={pending} className="w-full">
        {pending ? 'Signing in…' : 'Sign in'}
      </Button>

      <p className="text-center text-sm text-content-muted">
        New to Lumora?{' '}
        <Link href="/signup" className="text-primary hover:underline">
          Create an account
        </Link>
      </p>
    </form>
  );
}
