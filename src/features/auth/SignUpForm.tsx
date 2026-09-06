'use client';

import { useActionState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/Button';
import { AUTH_INITIAL_STATE, signUpAction, type AuthActionState } from '@/features/auth/actions';

/**
 * Sign-up form (Spec Section 8). Client component using useActionState for
 * inline, accessible error display (mismatched passwords, Supabase errors).
 */
export function SignUpForm() {
  const [state, formAction, pending] = useActionState<AuthActionState, FormData>(
    signUpAction,
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

      <Button type="submit" disabled={pending} className="w-full">
        {pending ? 'Creating account…' : 'Create account'}
      </Button>

      <p className="text-center text-sm text-content-muted">
        Already have an account?{' '}
        <Link href="/signin" className="text-primary hover:underline">
          Sign in
        </Link>
      </p>
    </form>
  );
}
