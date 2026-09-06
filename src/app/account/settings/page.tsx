import type { Metadata } from 'next';
import { SettingsForm } from '@/features/account/SettingsForm';

export const metadata: Metadata = { title: 'Settings' };

export default function SettingsPage() {
  return (
    <section aria-labelledby="settings-heading" className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h2 id="settings-heading" className="text-lg font-semibold">
          Playback and preferences
        </h2>
        <p className="text-sm text-content-muted">
          Personalize language, playback, accessibility, and profile security.
        </p>
      </div>
      <SettingsForm />
    </section>
  );
}
