import type { Metadata } from 'next';
import { EmptyState } from '@/components/ui/EmptyState';
import { UnauthorizedState } from '@/features/account/UnauthorizedState';
import { getRenderAccountPreferences } from '@/features/account/preference-queries';
import { SettingsForm } from '@/features/account/SettingsForm';

export const metadata: Metadata = { title: 'Settings' };

export default async function SettingsPage() {
  const preferences = await getRenderAccountPreferences();
  if (!preferences.ok) {
    if (preferences.reason === 'unauthenticated' || preferences.reason === 'unverified') {
      return <UnauthorizedState next="/account/settings" unverified={preferences.reason === 'unverified'} />;
    }
    return (
      <EmptyState
        icon="🔒"
        title="Preferences unavailable"
        description={preferences.message}
      />
    );
  }

  return (
    <section aria-labelledby="settings-heading" className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h2 id="settings-heading" className="text-lg font-semibold">
          Playback and preferences
        </h2>
        <p className="text-sm text-content-muted">
          Save playback and accessibility preferences to your account. Profile maturity controls are managed
          separately and are not changed by these preferences.
        </p>
      </div>
      <SettingsForm accountId={preferences.snapshot.accountId} initialPreferences={preferences.snapshot} />
    </section>
  );
}
