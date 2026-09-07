import type { Metadata } from 'next';
import { Container } from '@/components/ui/Container';
import { PageHeader } from '@/components/ui/PageHeader';
import { EmailSettingsPanel } from '@/features/admin/EmailSettingsPanel';
import { getEmailSettings } from '@/features/admin/queries';

export const metadata: Metadata = {
  title: 'Email settings',
  robots: { index: false, follow: false },
};

/**
 * Admin SMTP / email settings route (Spec Section 10). Gated by the admin
 * layout; the panel's server actions re-assert `settings.manage` before any
 * write. Current values are read here and passed into the client panel — the
 * stored password never crosses the server/client boundary.
 */

// nav entry added by orchestrator

export default async function AdminEmailPage() {
  const initial = await getEmailSettings();
  return (
    <Container className="pb-16">
      <PageHeader
        title="Email settings"
        description="Configure the SMTP relay Lumora uses to send mail, and verify it with a test message."
      />
      <EmailSettingsPanel initial={initial} />
    </Container>
  );
}
