import type { Metadata } from 'next';
import { Container } from '@/components/ui/Container';
import { PageHeader } from '@/components/ui/PageHeader';
import { AccountNav } from '@/features/account/AccountNav';
import { UnauthorizedState } from '@/features/account/UnauthorizedState';
import { SignOutButton } from '@/features/auth/SignOutButton';
import { features } from '@/lib/env';
import { getSupabaseServerClient } from '@/lib/supabase/server';

export const metadata: Metadata = {
  title: 'Account',
  // Authenticated surfaces should not be indexed (Section 16).
  robots: { index: false, follow: false },
};

/**
 * Real session gate (Section 8): resolves the signed-in user from the request
 * cookies. Returns null when Supabase is unconfigured (mock mode) or the
 * request has no session, so the layout falls through to the unauthorized
 * state instead of the account surfaces.
 */
async function getSessionUser(): Promise<{ email: string | undefined } | null> {
  if (!features.supabaseConfigured) return null;

  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;

  return { email: data.user.email };
}

export default async function AccountLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();

  return (
    <Container className="pb-16">
      <PageHeader
        title="Account"
        description={
          user
            ? `Signed in as ${user.email ?? 'your Lumora account'}`
            : 'Manage your profiles, preferences, and devices.'
        }
        actions={user ? <SignOutButton /> : undefined}
      />

      {user ? (
        <div className="flex flex-col gap-6">
          <AccountNav />
          <div>{children}</div>
        </div>
      ) : (
        <div className="py-10">
          <UnauthorizedState next="/account" />
        </div>
      )}
    </Container>
  );
}
