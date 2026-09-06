import type { Metadata } from 'next';
import Link from 'next/link';
import { buttonClasses } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';

export const metadata: Metadata = { title: 'History' };

export default function HistoryPage() {
  // Viewing history (watch_progress) isn't wired yet — honest empty state.
  return (
    <EmptyState
      icon="🕑"
      title="No viewing history yet"
      description="No viewing history yet. Titles you watch will appear here so you can pick up where you left off."
      action={
        <Link href="/browse" className={buttonClasses({ variant: 'primary' })}>
          Browse the catalog
        </Link>
      }
    />
  );
}
