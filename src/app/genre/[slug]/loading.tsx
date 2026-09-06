import { BrowseSkeleton } from '@/features/catalog/components/BrowseSkeleton';

/** Route-level loading state for /genre/[slug] (Section 3). */
export default function GenreLoading() {
  return <BrowseSkeleton />;
}
