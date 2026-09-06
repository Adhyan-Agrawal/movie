import { Button } from '@/components/ui/Button';
import { signOutAction } from '@/features/auth/actions';

/**
 * Sign-out button (Spec Section 8). Form-based server action so the redirect
 * home is processed by the framework reliably (and the form works even before
 * hydration completes).
 */
export function SignOutButton({ className }: { className?: string }) {
  return (
    <form action={signOutAction}>
      <Button type="submit" variant="ghost" size="sm" className={className}>
        Sign out
      </Button>
    </form>
  );
}
