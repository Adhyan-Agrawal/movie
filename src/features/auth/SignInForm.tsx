'use client';

import { useActionState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { AUTH_CALLBACK_INVALID, AUTH_EMAIL_UNVERIFIED, AUTH_INITIAL_STATE, AUTH_SERVICE_UNAVAILABLE, type AuthActionState } from '@/features/auth/state';
import { signInAction } from '@/features/auth/actions';
import { safeAuthReturnPath } from '@/features/auth/return-path';

/**
 * Sign-in form (Spec Section 8). Client component using useActionState so the
 * application-owned error renders inline with an accessible alert role.
 */
export function SignInForm({ next, initialError }: { next?: string; initialError?: string }) {
  const [state, formAction, pending] = useActionState<AuthActionState, FormData>(
    signInAction,
    AUTH_INITIAL_STATE,
  );
  const searchParams = useSearchParams();
  const auth = searchParams.get('auth');
  const error = state.error ?? initialError ?? (auth === 'unavailable' ? AUTH_SERVICE_UNAVAILABLE
    : auth === 'callback' ? AUTH_CALLBACK_INVALID : auth === 'unverified' ? AUTH_EMAIL_UNVERIFIED : null);
  const returnPath = safeAuthReturnPath(next);

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      {error ? (
        <p role="alert" className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
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

      <input type="hidden" name="next" value={returnPath} />

      <Button type="submit" disabled={pending} className="w-full">
        {pending ? 'Signing in…' : 'Sign in'}
      </Button>

      <p className="text-center text-sm text-content-muted">
        New to Lumora?{' '}
        <Link href={`/signup?next=${encodeURIComponent(returnPath)}`} className="text-primary hover:underline">
          Create an account
        </Link>
      </p>
    </form>
  );
}
