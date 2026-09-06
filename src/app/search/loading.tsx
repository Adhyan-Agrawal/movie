import { Container } from '@/components/ui/Container';
import { Skeleton } from '@/components/ui/Skeleton';

/** Route-level loading state for /search (Section 3). */
export default function SearchLoading() {
  return (
    <Container>
      <div className="py-6">
        <Skeleton className="h-9 w-32" />
      </div>
      <Skeleton className="h-14 w-full rounded-lg" />
      <div className="mt-8 grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
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
