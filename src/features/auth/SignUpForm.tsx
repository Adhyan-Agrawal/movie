'use client';

import { useActionState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/Button';
import { AUTH_INITIAL_STATE, type AuthActionState } from '@/features/auth/state';
import { signUpAction } from '@/features/auth/actions';
import { safeAuthReturnPath } from '@/features/auth/return-path';

/**
 * Sign-up form (Spec Section 8). Client component using useActionState for
 * inline, accessible validation, service errors, and confirmation instructions.
 */
export function SignUpForm({ next, initialError }: { next?: string; initialError?: string }) {
  const [state, formAction, pending] = useActionState<AuthActionState, FormData>(
    signUpAction,
    AUTH_INITIAL_STATE,
  );
  const returnPath = safeAuthReturnPath(next);
  const error = state.error ?? (state.message ? null : initialError);

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      {error ? (
        <p role="alert" className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      ) : null}
      {state.message ? (
        <p role="status" className="rounded-md border border-border bg-surface/40 px-3 py-2 text-sm text-content-muted">
          {state.message}
        </p>
      ) : null}

      <div className="flex flex-col gap-1.5">
        <label htmlFor="signup-email" className="text-sm font-medium text-content">
          Email
        </label>
        <input
          id="signup-email"
          name="email"
          type="email"
          autoComplete="email"
          required
          className="h-11 rounded-md border border-border bg-surface-raised px-3 text-sm text-content placeholder:text-content-subtle focus-visible:outline-none focus-visible:border-primary"
          placeholder="you@example.com"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="signup-password" className="text-sm font-medium text-content">
          Password
        </label>
        <input
          id="signup-password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={6}
          className="h-11 rounded-md border border-border bg-surface-raised px-3 text-sm text-content placeholder:text-content-subtle focus-visible:outline-none focus-visible:border-primary"
          placeholder="At least 6 characters"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="signup-confirm" className="text-sm font-medium text-content">
          Confirm password
        </label>
        <input
          id="signup-confirm"
          name="confirm"
          type="password"
          autoComplete="new-password"
          required
          className="h-11 rounded-md border border-border bg-surface-raised px-3 text-sm text-content placeholder:text-content-subtle focus-visible:outline-none focus-visible:border-primary"
          placeholder="Repeat your password"
        />
      </div>

      <input type="hidden" name="next" value={returnPath} />

      <Button type="submit" disabled={pending} className="w-full">
        {pending ? 'Creating account…' : 'Create account'}
      </Button>

      <p className="text-center text-sm text-content-muted">
        Already have an account?{' '}
        <Link href={`/signin?next=${encodeURIComponent(returnPath)}`} className="text-primary hover:underline">
          Sign in
        </Link>
      </p>
    </form>
  );
}
