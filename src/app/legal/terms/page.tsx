import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Terms of Service' };

export default function TermsPage() {
  return (
    <>
      <h1 className="font-display text-2xl font-bold text-content">Terms of Service</h1>
      <p>
        These terms cover your use of Lumora, a streaming service operated by its operator. By creating an account or
        using the service you agree to these terms.
      </p>

      <h2 className="text-base font-semibold text-content">The service</h2>
      <p>
        Lumora lets you watch movies and TV. Playback is provided in two ways: titles uploaded by the operator, and
        titles streamed through external providers that Lumora embeds in its player. External providers are shown in
        the player simply as “Server 1”, “Server 2”, and so on — Lumora does not brand them with their real names.
        Some external sources require you to consent before they load in the player, and you can switch between the
        available servers for a title.
      </p>

      <h2 className="text-base font-semibold text-content">Content availability</h2>
      <p>
        The catalog, the servers available for a title, and regional access can change at any time. Lumora does not
        guarantee that a particular title, server, or format will remain available, and external providers can go
        offline independently of Lumora.
      </p>

      <h2 className="text-base font-semibold text-content">Your account</h2>
      <p>
        Your account is personal. Keep your sign-in credentials private and do not share them. You are responsible for
        activity that happens under your account, including the profiles you create and their maturity settings. If you
        think someone else has accessed your account, sign out your sessions through Supabase Auth and contact the
        operator.
      </p>

      <h2 className="text-base font-semibold text-content">Acceptable use</h2>
      <p>When using Lumora you agree not to:</p>
      <ul className="list-disc space-y-1 pl-5">
        <li>attempt to bypass access controls, geographic restrictions, or provider protections;</li>
        <li>scrape, download, or redistribute content, source URLs, or provider identifiers;</li>
        <li>interfere with the service or another viewer&rsquo;s account; or</li>
        <li>use the service in a way that violates applicable law or the rights of content owners.</li>
      </ul>

      <h2 className="text-base font-semibold text-content">Termination</h2>
      <p>
        The operator may suspend or close accounts that breach these terms. You can stop using Lumora at any time and
        request deletion of your account and data as described in the Privacy Policy.
      </p>
    </>
  );
}
