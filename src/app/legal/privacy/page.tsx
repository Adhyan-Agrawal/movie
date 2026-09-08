import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = { title: 'Privacy Policy' };

export default function PrivacyPage() {
  return (
    <>
      <h1 className="font-display text-2xl font-bold text-content">Privacy Policy</h1>
      <p>
        Lumora is a streaming service run by its operator. This page explains what we collect, why we collect it,
        and how you can request access to or deletion of your data. It covers the service as it actually works today.
      </p>

      <h2 className="text-base font-semibold text-content">What we collect</h2>
      <p>When you use Lumora, the following is collected:</p>
      <ul className="list-disc space-y-1 pl-5">
        <li>
          <span className="font-medium text-content">Account information</span> — an email address and password managed
          by Supabase Auth when you register. Profile names and maturity settings you create under that account.
        </li>
        <li>
          <span className="font-medium text-content">Your activity</span> — titles you add to your watchlist, and watch
          history (what you played and when) recorded against your account.
        </li>
        <li>
          <span className="font-medium text-content">Guest activity</span> — if you watch without signing in, your
          viewing history and continue-watching progress are stored only in your browser&rsquo;s local storage on the
          device you are using.
        </li>
        <li>
          <span className="font-medium text-content">Cookies and local storage</span> — strictly necessary cookies keep
          you signed in and keep the service working. See the <Link href="/legal/cookies">Cookie Policy</Link> for
          details.
        </li>
      </ul>

      <h2 className="text-base font-semibold text-content">How content is provided</h2>
      <p>
        Titles on Lumora are watched in two ways: playback may be delivered by an external provider that Lumora embeds
        in the player (shown simply as “Server 1”, “Server 2”, and so on), or it may come from media files that the
        operator uploads directly. When you watch through an external provider, that provider receives the minimum
        request information needed to serve the stream — for example your IP address and which title you asked for.
        Lumora does not control those providers&rsquo; practices.
      </p>

      <h2 className="text-base font-semibold text-content">Advertising and analytics</h2>
      <p>
        Advertising and analytics run only after you consent through the consent banner. Before that consent is given
        we do not load ad or analytics scripts, and ads are never personalized without your consent.
      </p>

      <h2 className="text-base font-semibold text-content">Your rights</h2>
      <p>
        You can sign out and delete your own profile records in the app, but there is no self-service “export” or
        “delete my account” control in Account settings yet. To request a copy of your data or deletion of your
        account and its records, email the operator at the contact address shown on the site. We will handle the
        request in line with the retention settings the operator has configured.
      </p>
    </>
  );
}
