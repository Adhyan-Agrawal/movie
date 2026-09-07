import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Container } from '@/components/ui/Container';
import { PageHeader } from '@/components/ui/PageHeader';
import { EmailTemplatesPanel } from '@/features/admin/email/EmailTemplatesPanel';
import { getEmailTemplates } from '@/features/admin/email/templates';
import { hasPermission } from '@/lib/permissions/check';
import { PERMISSIONS } from '@/lib/permissions/permissions';
import { getSupabaseServerClient } from '@/lib/supabase/server';

export const metadata: Metadata = {
  title: 'Email templates',
  robots: { index: false, follow: false },
};

/**
 * Admin email-templates route (Spec Sections 8, 10). Gated on settings.manage —
 * the same key the `site_settings` RLS policies enforce. Loads the effective
 * template set (built-ins merged with stored overrides) and hands it to the
 * client panel along with the signed-in admin's email for test sends.
 */
export default async function AdminEmailTemplatesPage() {
  if (!(await hasPermission(PERMISSIONS.SETTINGS_MANAGE))) notFound();

  const [templates, db] = await Promise.all([getEmailTemplates(), getSupabaseServerClient()]);
  const { data } = await db.auth.getUser();
  const adminEmail = data.user?.email ?? '';

  return (
    <Container className="pb-16">
      <PageHeader
        title="Email templates"
        description="Edit the subject and body of every transactional email Lumora sends."
      />
      <EmailTemplatesPanel templates={templates} adminEmail={adminEmail} />
    </Container>
  );
}
