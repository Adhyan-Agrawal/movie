'use client';

import { useTransition } from 'react';
import { Button } from '@/components/ui/Button';
import { signOutAction } from '@/features/auth/actions';

/**
 * Sign-out button (Spec Section 8). Invokes the server action so the session
 * cookies are cleared server-side; the action redirects home on completion.
 */
export function SignOutButton({ className }: { className?: string }) {
  const [pending, startTransition] = useTransition();

  return (
    <Button
      variant="ghost"
      size="sm"
      className={className}
      disabled={pending}
      onClick={() => startTransition(() => signOutAction())}
    >
      {pending ? 'Signing out…' : 'Sign out'}
    </Button>
  );
}
