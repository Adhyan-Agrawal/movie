import Link from 'next/link';
import { buttonClasses } from '@/components/ui/Button';

/** Global not-found (Section 3). */
export default function NotFound() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 px-4 py-24 text-center">
      <p className="font-display text-5xl font-bold text-primary">404</p>
      <h1 className="text-xl font-semibold">We couldn’t find that</h1>
      <p className="text-sm text-content-muted">
        The page or title you’re looking for may have moved or is no longer available.
      </p>
      <Link href="/" className={buttonClasses({ variant: 'primary' })}>
        Back to home
      </Link>
    </div>
  );
}
