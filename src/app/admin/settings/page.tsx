import { PageHeader } from '@/components/ui/PageHeader';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { listFeatureFlags, listSiteSettings, jsonToDisplay } from '@/features/admin/queries';
import type { AdminFeatureFlagRow, AdminSiteSettingRow } from '@/features/admin/types';

export const metadata = {
  title: 'Settings',
  description: 'Site settings and feature flags.',
};

function formatDate(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

function SettingsTable({ settings }: { settings: AdminSiteSettingRow[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">Site settings with value, visibility, description and last update</caption>
        <thead>
          <tr className="border-b border-border bg-surface/60 text-left text-xs uppercase tracking-wide text-content-subtle">
            <th scope="col" className="px-3 py-2.5">
              Key
            </th>
            <th scope="col" className="px-3 py-2.5">
              Value
            </th>
            <th scope="col" className="px-3 py-2.5">
              Visibility
            </th>
            <th scope="col" className="px-3 py-2.5">
              Description
            </th>
            <th scope="col" className="px-3 py-2.5 text-right">
              Updated
            </th>
          </tr>
        </thead>
        <tbody>
          {settings.map((setting) => (
            <tr key={setting.key} className="border-b border-border/60 last:border-0">
              <th scope="row" className="px-3 py-2.5 text-left font-normal">
                <code className="font-mono text-content">{setting.key}</code>
              </th>
              <td className="px-3 py-2.5">
                <code className="font-mono text-content-muted">{jsonToDisplay(setting.value) ?? '—'}</code>
              </td>
              <td className="px-3 py-2.5">
                <Badge tone={setting.is_public ? 'info' : 'neutral'}>
                  {setting.is_public ? 'Public' : 'Internal'}
                </Badge>
              </td>
              <td className="px-3 py-2.5 text-content-muted">{setting.description || '—'}</td>
              <td className="px-3 py-2.5 text-right text-content-subtle">
                {formatDate(setting.updated_at)}
                {setting.updated_by ? <span className="block text-xs">by {setting.updated_by}</span> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FeatureFlagsTable({ flags }: { flags: AdminFeatureFlagRow[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">Feature flags with state, description and last update</caption>
        <thead>
          <tr className="border-b border-border bg-surface/60 text-left text-xs uppercase tracking-wide text-content-subtle">
            <th scope="col" className="px-3 py-2.5">
              Key
            </th>
            <th scope="col" className="px-3 py-2.5">
              State
            </th>
            <th scope="col" className="px-3 py-2.5">
              Visibility
            </th>
            <th scope="col" className="px-3 py-2.5">
              Description
            </th>
            <th scope="col" className="px-3 py-2.5 text-right">
              Updated
            </th>
          </tr>
        </thead>
        <tbody>
          {flags.map((flag) => (
            <tr key={flag.key} className="border-b border-border/60 last:border-0">
              <th scope="row" className="px-3 py-2.5 text-left font-normal">
                <code className="font-mono text-content">{flag.key}</code>
              </th>
              <td className="px-3 py-2.5">
                <Badge tone={flag.enabled ? 'success' : 'neutral'}>{flag.enabled ? 'On' : 'Off'}</Badge>
              </td>
              <td className="px-3 py-2.5">
                <Badge tone={flag.is_public ? 'info' : 'neutral'}>
                  {flag.is_public ? 'Public' : 'Internal'}
                </Badge>
              </td>
              <td className="px-3 py-2.5 text-content-muted">{flag.description || '—'}</td>
              <td className="px-3 py-2.5 text-right text-content-subtle">
                {formatDate(flag.updated_at)}
                {flag.updated_by ? <span className="block text-xs">by {flag.updated_by}</span> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Settings (Spec Section 10). Real rows from site_settings and feature_flags
 * (settings.manage / is_public policies). Both are read-only here — editing
 * and rollback arrive with the settings phase; no toggles with fake state. */
export default async function AdminSettingsPage() {
  const [settings, flags] = await Promise.all([listSiteSettings(), listFeatureFlags()]);
  const empty = settings.length === 0 && flags.length === 0;

  return (
    <div className="py-6">
      <PageHeader
        title="Settings"
        description="Site settings and feature flags from the database (settings.manage), shown read-only. Editing and rollback arrive with the settings phase."
      />

      {empty ? (
        <EmptyState
          icon="⚙"
          title="No settings or feature flags stored yet"
          description="Values configured through the settings phase will appear here. Until then, app behavior comes from code defaults."
        />
      ) : (
        <div className="flex flex-col gap-8">
          <section aria-label="Site settings">
            <h2 className="mb-3 font-display text-lg font-semibold">Site settings</h2>
            {settings.length > 0 ? (
              <SettingsTable settings={settings} />
            ) : (
              <EmptyState title="No site settings stored" description="site_settings rows will appear here." />
            )}
          </section>
          <section aria-label="Feature flags">
            <h2 className="mb-3 font-display text-lg font-semibold">Feature flags</h2>
            {flags.length > 0 ? (
              <FeatureFlagsTable flags={flags} />
            ) : (
              <EmptyState title="No feature flags stored" description="feature_flags rows will appear here." />
            )}
          </section>
        </div>
      )}
    </div>
  );
}
