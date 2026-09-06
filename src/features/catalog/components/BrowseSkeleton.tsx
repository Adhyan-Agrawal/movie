import { Container } from '@/components/ui/Container';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * Route-level loading skeleton for the browse-style grid pages (Section 16:
 * reserve aspect ratios to avoid layout shift). Shared by /browse, /movies,
 * /tv, and /genre/[slug] loading boundaries.
 */
export function BrowseSkeleton() {
  return (
    <Container>
      <div className="py-6">
        <Skeleton className="h-9 w-44" />
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap gap-3 rounded-lg border border-border bg-surface/50 p-3 md:p-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-36" />
        ))}
      </div>

      {/* Results grid */}
      <div className="mt-6 grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
        {Array.from({ length: 12 }).map((_, i) => (
          <div key={i} className="flex flex-col gap-2">
            <Skeleton className="aspect-[2/3] w-full" />
            <Skeleton className="h-3 w-20" />
          </div>
        ))}
      </div>
    </Container>
  );
}
