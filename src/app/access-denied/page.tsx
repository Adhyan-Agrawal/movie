import Link from 'next/link';

export const metadata = { title: 'Access unavailable', robots: { index: false, follow: false } };

export default function AccessDeniedPage() {
  return <section className="mx-auto flex max-w-xl flex-col gap-5 px-4 py-20">
    <p className="text-xs font-semibold uppercase tracking-widest text-primary">Account access</p>
    <h1 className="text-3xl font-semibold">Admin access is unavailable</h1>
    <p className="text-content-muted">This account does not have verified access to the administration panel. Sign in with an authorized account, or try again if the service is temporarily unavailable.</p>
    <div className="flex flex-wrap gap-4">
      <Link href="/signin?next=/admin" className="rounded-lg bg-primary px-4 py-3 font-semibold text-base">Sign in</Link>
      <Link href="/" className="rounded-lg border border-border px-4 py-3">Return home</Link>
    </div>
  </section>;
}
