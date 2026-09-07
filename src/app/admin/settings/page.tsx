import { PageHeader } from '@/components/ui/PageHeader';
import { EmptyState } from '@/components/ui/EmptyState';
import { SettingsEditor } from '@/features/admin/SettingsEditor';
import { listFeatureFlags, listSiteSettings } from '@/features/admin/queries';

export const metadata = {
  title: 'Settings',
  description: 'Site settings and feature flags.',
};

/** Settings (Spec Section 10). Real rows from site_settings and feature_flags
 * (settings.manage / is_public policies). Edited in place through
 * permission-gated server actions; no fake toggles. */
export default async function AdminSettingsPage() {
  const [settings, flags] = await Promise.all([listSiteSettings(), listFeatureFlags()]);
  const empty = settings.length === 0 && flags.length === 0;

  return (
    <div className="py-6">
      <PageHeader
        title="Settings"
        description="Site settings and feature flags from the database (settings.manage), editable in place. Values are stored as jsonb — booleans and numbers are typed, everything else is plain text."
      />

      {empty ? (
        <EmptyState
          icon="⚙"
          title="No settings or feature flags stored yet"
          description="Values configured through the settings phase will appear here. Until then, app behavior comes from code defaults."
        />
      ) : (
        <SettingsEditor settings={settings} flags={flags} />
      )}
    </div>
  );
}
