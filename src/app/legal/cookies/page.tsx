import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Cookie Policy' };

export default function CookiesPage() {
  return (
    <>
      <h1 className="font-display text-2xl font-bold text-content">Cookie Policy</h1>
      <p>
        Lumora uses cookies and browser storage to keep you signed in, remember your choices, and — only with your
        consent — support analytics and advertising. This page describes what is stored and how consent works.
      </p>

      <h2 className="text-base font-semibold text-content">Strictly necessary</h2>
      <p>
        These are always on because the service needs them: the session cookie that keeps you signed in via Supabase
        Auth, and security measures that protect the service. Local storage is also used for features such as your
        guest viewing history, recent searches, and your chosen video quality for a title. You can clear these at any
        time through your browser&rsquo;s site-data controls.
      </p>

      <h2 className="text-base font-semibold text-content">Analytics and advertising</h2>
      <p>
        Analytics scripts and advertising are loaded only after you consent. We do not run them before consent is
        given, and advertising is not personalized without your separate consent. When you watch an ad-supported
        title, the advertising provider may set its own cookies in line with its privacy policy.
      </p>

      <h2 className="text-base font-semibold text-content">Managing your choices</h2>
      <p>
        The first time you visit, the consent banner lets you accept all, reject non-essential, or customize analytics
        and advertising separately. Your choice is stored in this browser. To change it later, clear Lumora&rsquo;s
        site data (including the stored consent choice) in your browser settings — the banner will then appear again
        on your next visit.
      </p>
    </>
  );
}
