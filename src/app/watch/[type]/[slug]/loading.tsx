import { Container } from '@/components/ui/Container';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * Watch route loading state (Spec Section 3: every route needs one). Reserves
 * the 16:9 player aspect ratio to avoid layout shift (Spec Section 16).
 */
export default function WatchLoading() {
  return (
    <Container className="py-4 md:py-6">
      <div className="mx-auto flex max-w-5xl flex-col gap-5">
        <Skeleton className="aspect-video w-full rounded-lg" />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Skeleton className="h-11 w-24" />
          <Skeleton className="h-11 w-64" />
        </div>
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-4 w-full max-w-2xl" />
        </div>
      </div>
    </Container>
  );
}
