import { Skeleton } from '@/components/ui/Skeleton';

/** Route-level loading state (Section 3: every route needs a loading state). */
export default function HomeLoading() {
  return (
    <div className="flex flex-col gap-10 pb-8">
      <Skeleton className="min-h-[62vh] w-full rounded-none md:min-h-[72vh]" />
      <div className="flex flex-col gap-10">
        {[0, 1, 2].map((row) => (
          <div key={row} className="flex flex-col gap-3">
            <Skeleton className="mx-4 h-6 w-48 md:mx-8" />
            <div className="flex gap-3 overflow-hidden px-4 md:px-8">
              {[0, 1, 2, 3, 4, 5].map((card) => (
                <Skeleton key={card} className="aspect-[2/3] w-40 shrink-0 sm:w-44 md:w-48" />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
