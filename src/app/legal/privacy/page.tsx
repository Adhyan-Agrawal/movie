import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Privacy Policy' };

export default function PrivacyPage() {
  return (
    <>
      <h1 className="font-display text-2xl font-bold text-content">Privacy Policy</h1>
      <p className="text-xs text-content-subtle">Placeholder — replace with operator-reviewed legal content before launch.</p>
      <p>
        Lumora collects the minimum data needed to provide the service: your account details, viewing
        profiles, watch progress, and preferences. Analytics and advertising are processed only with your
        consent, which you can change at any time from the cookie settings.
      </p>
      <h2 className="text-base font-semibold text-content">What we store</h2>
      <p>
        Account and profile data, watchlists, ratings, watch history and resume position, device sessions, and
        notification preferences. Guest viewing progress is kept in a signed local context and is never
        silently attached to another account.
      </p>
      <h2 className="text-base font-semibold text-content">Your rights</h2>
      <p>
        You can export or delete your data from Account → Settings. Data-subject requests are handled per the
        retention settings configured by the operator.
      </p>
    </>
  );
}
