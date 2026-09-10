import type { Metadata } from 'next';
import Link from 'next/link';
import { buttonClasses } from '@/components/ui/Button';

export const metadata: Metadata = {
  title: 'Offline',
  // The offline shell is a utility page — never indexed.
  robots: { index: false, follow: false },
};

/**
 * Offline shell (PWA). The service worker serves this when a navigation has no
 * network, so an installed Lumora still shows a branded, useful screen instead
 * of the browser's error page.
 */
export default function OfflinePage() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-6 py-16 text-center">
      <span aria-hidden="true" className="text-3xl">
        ⌁
      </span>
      <h1 className="font-display text-2xl font-bold tracking-tight">You&rsquo;re offline</h1>
      <p className="max-w-md text-sm leading-relaxed text-content-muted">
        Lumora can&rsquo;t reach the network right now. Anything you already opened stays available, and playback
        resumes as soon as you&rsquo;re back online.
      </p>
      <Link href="/" className={buttonClasses({ variant: 'primary' })}>
        Try again
      </Link>
    </div>
  );
}
