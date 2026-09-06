import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Cookie Policy' };

export default function CookiesPage() {
  return (
    <>
      <h1 className="font-display text-2xl font-bold text-content">Cookie Policy</h1>
      <p className="text-xs text-content-subtle">Placeholder — replace with operator-reviewed legal content before launch.</p>
      <p>
        We use strictly necessary cookies to keep you signed in and to run core features. With your consent we
        also use analytics cookies to understand product usage and, where enabled, advertising cookies.
      </p>
      <h2 className="text-base font-semibold text-content">Managing your choices</h2>
      <p>
        You can accept all, reject non-essential, or customize your choices from the consent banner. Advertising
        is never personalized before the required consent is granted.
      </p>
    </>
  );
}
