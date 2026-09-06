import { Container } from '@/components/ui/Container';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * Route-level loading skeleton for the title detail (Sections 3, 16).
 * Mirrors the real layout and reserves aspect ratios to avoid CLS.
 */
export default function TitleLoading() {
  return (
    <div className="flex flex-col gap-10 pb-8">
      {/* Hero band */}
      <section className="relative overflow-hidden">
        <Skeleton className="absolute inset-0 rounded-none" />
        <Container className="relative">
          <div className="flex flex-col gap-6 pb-8 pt-10 md:flex-row md:gap-8 md:pb-12 md:pt-16">
            <Skeleton className="aspect-[2/3] w-36 shrink-0 rounded-lg sm:w-44 md:w-56" />
            <div className="flex w-full max-w-2xl flex-col gap-4">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-10 w-72 max-w-full" />
              <Skeleton className="h-4 w-56" />
              <Skeleton className="h-4 w-44" />
              <div className="mt-1 flex flex-wrap gap-3">
                <Skeleton className="h-12 w-28" />
                <Skeleton className="h-12 w-36" />
                <Skeleton className="h-12 w-24" />
              </div>
              <Skeleton className="h-16 w-full max-w-xl" />
            </div>
          </div>
        </Container>
      </section>

      {/* Details */}
      <Container>
        <div className="grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,1fr)_260px]">
          <div className="flex flex-col gap-4">
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-44 w-full rounded-lg" />
          </div>
          <div className="flex flex-col gap-4">
            <Skeleton className="h-6 w-24" />
            <Skeleton className="h-48 w-full rounded-lg" />
          </div>
        </div>
      </Container>

      {/* Similar row */}
      <div className="flex flex-col gap-3">
        <Skeleton className="mx-4 h-6 w-48 md:mx-8" />
        <div className="flex gap-3 overflow-hidden px-4 md:px-8">
          {[0, 1, 2, 3, 4, 5].map((c) => (
            <Skeleton key={c} className="aspect-[2/3] w-40 shrink-0 sm:w-44 md:w-48" />
          ))}
        </div>
      </div>
    </div>
  );
}
