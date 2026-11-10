import Link from 'next/link';
import { PageHeader } from '@/components/ui/PageHeader';
import { SettingsEditor } from '@/features/admin/SettingsEditor';
import { listFeatureFlags, listSiteSettings } from '@/features/admin/queries';

export const metadata = {
  title: 'Settings',
  description: 'Site settings and feature flags.',
};

/** Settings (Spec Section 10). Allowlisted public settings and feature_flags
 * (settings.manage / is_public policies). Edited in place through
 * permission-gated server actions; no fake toggles. */
export default async function AdminSettingsPage() {
  const [settings, flags] = await Promise.all([listSiteSettings(), listFeatureFlags()]);

  return (
    <div className="py-6">
      <PageHeader
        title="Settings"
        description="Only explicitly supported public settings are editable here (settings.manage). Stored feature flags are managed separately below. Private and specialized settings are excluded."
      />

      <p className="mb-6 text-sm text-content-muted">
        Use <Link href="/admin/email" className="text-primary underline">Email settings</Link> for SMTP,{' '}
        <Link href="/admin/email/templates" className="text-primary underline">Email templates</Link> for messages, and{' '}
        <Link href="/admin/ads" className="text-primary underline">Ads</Link> for playback advertising. Each panel keeps its own permission checks.
      </p>
      <SettingsEditor settings={settings} flags={flags} />
    </div>
  );
}
