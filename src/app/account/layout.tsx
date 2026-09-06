import type { Metadata } from 'next';
import { Badge } from '@/components/ui/Badge';
import { Container } from '@/components/ui/Container';
import { PageHeader } from '@/components/ui/PageHeader';
import { AccountNav } from '@/features/account/AccountNav';
import { UnauthorizedState } from '@/features/account/UnauthorizedState';
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
      />

      {user ? (
        <div className="flex flex-col gap-6">
          <AccountNav />
          <div className="flex items-center gap-2 rounded-md border border-border bg-surface/50 px-3 py-2 text-xs text-content-muted">
            <Badge tone="info">Sample</Badge>
            <span>You’re viewing sample account data. Save, revoke, and delete actions are previews only.</span>
          </div>
          <div>{children}</div>
        </div>
      ) : (
        <div className="py-10">
          <UnauthorizedState />
        </div>
      )}
    </Container>
  );
}
