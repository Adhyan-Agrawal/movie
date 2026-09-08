import type { Metadata } from 'next';
import Link from 'next/link';
import { buttonClasses } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { getSignedInAccountId } from '@/features/account/queries';
import { SettingsForm } from '@/features/account/SettingsForm';

export const metadata: Metadata = { title: 'Settings' };

export default async function SettingsPage() {
  // Namespace the browser-local preference store per signed-in account (the
  // layout gates this route to signed-in users, but stay defensive when the
  // read fails so we never save under an empty key).
  const accountId = await getSignedInAccountId();

  if (!accountId) {
    return (
      <EmptyState
        icon="🔒"
        title="Sign in to manage preferences"
        description="Playback and display preferences are stored per account. Sign in to set yours."
        action={
          <Link href="/signin" className={buttonClasses({ variant: 'primary' })}>
            Sign in
          </Link>
        }
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
          Personalize language, playback, accessibility, and profile-lock preferences. Choices are saved to this
          browser for this account.
        </p>
      </div>
      <SettingsForm accountId={accountId} />
    </section>
  );
}
