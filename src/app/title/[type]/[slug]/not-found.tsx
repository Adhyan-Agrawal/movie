import Link from 'next/link';
import { buttonClasses } from '@/components/ui/Button';

/** Title-scoped not-found (Section 3). Friendly, with a route back to browse. */
export default function TitleNotFound() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 px-4 py-24 text-center">
      <p className="font-display text-5xl font-bold text-primary">404</p>
      <h1 className="text-xl font-semibold">We couldn’t find that title</h1>
      <p className="text-sm text-content-muted">
        This title may have been moved, unpublished, or the link may be incorrect.
      </p>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <Link href="/browse" className={buttonClasses({ variant: 'primary' })}>
          Browse the catalog
        </Link>
        <Link href="/" className={buttonClasses({ variant: 'secondary' })}>
          Back to home
        </Link>
      </div>
    </div>
  );
}
