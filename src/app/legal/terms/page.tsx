import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Terms of Service' };

export default function TermsPage() {
  return (
    <>
      <h1 className="font-display text-2xl font-bold text-content">Terms of Service</h1>
      <p className="text-xs text-content-subtle">Placeholder — replace with operator-reviewed legal content before launch.</p>
      <p>
        Lumora provides access to movies and television made available by the operator and authorized third
        parties. Content availability, provider sources, and regional restrictions may change. You agree to use
        the service only in ways permitted by the operator’s content rights and applicable law.
      </p>
      <h2 className="text-base font-semibold text-content">Acceptable use</h2>
      <p>
        Do not attempt to bypass access controls, geo restrictions, or provider protections, and do not
        redistribute content. Playback may be delivered through external providers, which are clearly labeled.
      </p>
    </>
  );
}
