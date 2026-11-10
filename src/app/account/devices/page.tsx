import type { Metadata } from 'next';
import { EmptyState } from '@/components/ui/EmptyState';
import { UnauthorizedState } from '@/features/account/UnauthorizedState';
import { SessionControlsForm } from '@/features/auth/SessionControlsForm';
import { getRenderAccount } from '@/features/auth/render-account';

export const metadata: Metadata = { title: 'Devices' };

/**
 * Signed-in devices (Spec Section 8). Lumora has no device/session table and
 * does not record which browser last signed in, so there is nothing to list.
 * Sign-in sessions belong to Supabase Auth; this page explains that honestly
 * instead of inventing a device list.
 */
export default async function DevicesPage() {
  const account = await getRenderAccount();
  if (account.status !== 'authenticated') {
    return <UnauthorizedState next="/account/devices" unavailable={account.status === 'unavailable'} unverified={account.status === 'unverified'} />;
  }

  return (
    <section aria-labelledby="devices-heading" className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h2 id="devices-heading" className="text-lg font-semibold">
          Signed-in devices
        </h2>
        <p className="text-sm text-content-muted">Manage where you’re signed in.</p>
      </div>

      <EmptyState
        icon="🖥"
        title="No device list to show"
        description="Lumora doesn’t keep a list of the devices you sign in with, and it doesn’t record when this browser last signed in. Your sign-in sessions are managed by Supabase Auth."
      />

      <div className="rounded-lg border border-border bg-surface/40 px-5 py-4 text-sm text-content-muted">
        <p className="font-medium text-content">What you can do</p>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>
            To end the session in <span className="font-medium text-content">this browser</span>, use the “Sign out”
            button in the account header above.
          </li>
          <li>
            Use the controls below to sign out other sessions or every session, including this browser.
            Sessions are managed by Supabase Auth, not a Lumora device list.
          </li>
          <li>
            Your watch history and watchlist follow your account, not a device, so signing in anywhere picks up where
            you left off.
          </li>
        </ul>
      </div>
      <SessionControlsForm />
    </section>
  );
}
