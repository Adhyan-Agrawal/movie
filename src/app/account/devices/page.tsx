import type { Metadata } from 'next';
import { EmptyState } from '@/components/ui/EmptyState';

export const metadata: Metadata = { title: 'Devices' };

/**
 * Signed-in devices (Spec Section 8). Lumora has no device/session table and
 * does not record which browser last signed in, so there is nothing to list.
 * Sign-in sessions belong to Supabase Auth; this page explains that honestly
 * instead of inventing a device list.
 */
export default function DevicesPage() {
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
            Sessions in other browsers or apps are managed by Supabase Auth — Lumora itself has no sign-out-everywhere
            or per-device controls yet.
          </li>
          <li>
            Your watch history and watchlist follow your account, not a device, so signing in anywhere picks up where
            you left off.
          </li>
        </ul>
      </div>
    </section>
  );
}
