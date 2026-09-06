import Link from 'next/link';
import { buttonClasses } from '@/components/ui/Button';
import { Container } from '@/components/ui/Container';
import { EmptyState } from '@/components/ui/EmptyState';

/** Shown when a genre slug doesn't resolve to a known genre (Section 3). */
export default function GenreNotFound() {
  return (
    <Container>
      <div className="py-16">
        <EmptyState
          icon="✦"
          title="Genre not found"
          description="That genre doesn’t exist or may have been renamed."
          action={
            <Link href="/browse" className={buttonClasses({ variant: 'primary', size: 'sm' })}>
              Browse all titles
            </Link>
          }
        />
      </div>
    </Container>
  );
}
