import { PageHeader } from '@/components/ui/PageHeader';
import { SettingRow } from '@/features/admin/SettingRow';
import { SETTING_GROUPS } from '@/features/admin/mock';

export const metadata = {
  title: 'Settings',
  description: 'Brand, playback, privacy, and feature settings.',
};

export default function AdminSettingsPage() {
  return (
    <div className="py-6">
      <PageHeader
        title="Settings"
        description="Every setting shows its scope, default, validation, affected surfaces, editor, timestamp, and a reversible roll-back (Section 10)."
      />
      <div className="flex flex-col gap-6">
        {SETTING_GROUPS.map((group) => (
          <section key={group.id} aria-labelledby={`group-${group.id}`} className="rounded-lg border border-border bg-surface p-4 md:p-5">
            <div className="mb-2">
              <h2 id={`group-${group.id}`} className="font-display text-lg font-semibold">
                {group.title}
              </h2>
              <p className="text-sm text-content-muted">{group.description}</p>
            </div>
            <div>
              {group.settings.map((setting) => (
                <SettingRow key={setting.key} setting={setting} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
