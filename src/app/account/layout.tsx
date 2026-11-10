import type { Metadata } from 'next';
import { Container } from '@/components/ui/Container';
import { PageHeader } from '@/components/ui/PageHeader';
import { AccountNav } from '@/features/account/AccountNav';
import { UnauthorizedState } from '@/features/account/UnauthorizedState';
import { SignOutButton } from '@/features/auth/SignOutButton';
import { features } from '@/lib/env';
import { getRenderAccount } from '@/features/auth/render-account';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Account',
  // Authenticated surfaces should not be indexed (Section 16).
  robots: { index: false, follow: false },
};

export default async function AccountLayout({ children }: { children: React.ReactNode }) {
  const account = await getRenderAccount();
  const user = account.status === 'authenticated' ? account.user : null;

  return (
    <Container className="pb-16">
      <PageHeader
        title="Account"
        description={
          user
            ? `Signed in as ${user.email ?? 'your Lumora account'}`
            : account.status === 'unavailable' && features.supabaseConfigured ? 'Your session could not be verified. Please try again shortly.'
              : features.supabaseConfigured ? 'Manage your profiles, preferences, and devices.' : 'Account services are temporarily unavailable.'
        }
        actions={user || account.status === 'unverified' ? <SignOutButton /> : undefined}
      />

      {user ? (
        <div className="flex flex-col gap-6">
          <AccountNav />
          <div>{children}</div>
        </div>
      ) : (
        <div className="py-10">
          <UnauthorizedState next="/account" unavailable={account.status === 'unavailable'} unverified={account.status === 'unverified'} />
        </div>
      )}
    </Container>
  );
}
