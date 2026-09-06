import { Skeleton } from '@/components/ui/Skeleton';

/** Section-level loading state for the account area (Section 3). The layout
 *  (header + sub-nav) persists; this fills the content region. */
export default function AccountLoading() {
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-4 w-64" />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {[0, 1, 2].map((index) => (
          <Skeleton key={index} className="h-28 w-full rounded-lg" />
        ))}
      </div>
      <div className="flex flex-col gap-3">
        <Skeleton className="h-5 w-40" />
        {[0, 1, 2].map((index) => (
          <Skeleton key={index} className="h-16 w-full rounded-lg" />
        ))}
      </div>
    </div>
  );
}
