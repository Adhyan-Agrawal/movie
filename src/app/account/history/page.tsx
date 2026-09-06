import type { Metadata } from 'next';
import Link from 'next/link';
import { buttonClasses } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { listWatchHistoryWithTitles } from '@/features/playback/history-queries';
import type { Title } from '@/features/catalog/types';

export const metadata: Metadata = { title: 'History' };

function formatWatchedAt(iso: string): string {
  const d = new Date(iso);
  const now = Date.now();
  const diffMin = Math.round((now - d.getTime()) / 60_000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin} min ago`;
  if (diffMin < 60 * 24) return `${Math.round(diffMin / 60)} h ago`;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * Account watch history (Spec Sections 4, 8): real playback sessions. The
 * external player exposes no position telemetry, so entries show honest
 * "watched" timestamps — never a fabricated progress bar.
 */
export default async function HistoryPage() {
  const rows = await listWatchHistoryWithTitles(50);

  if (rows.length === 0) {
    return (
      <EmptyState
        icon="🕑"
        title="No viewing history yet"
        description="Titles you watch will appear here with when you watched them."
        action={
          <Link href="/browse" className={buttonClasses({ variant: 'primary' })}>
            Browse the catalog
          </Link>
        }
      />
    );
  }

  return (
    <section aria-labelledby="history-heading" className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h2 id="history-heading" className="text-lg font-semibold">
          Viewing history
        </h2>
        <p className="text-sm text-content-muted">
          {rows.length} recent {rows.length === 1 ? 'session' : 'sessions'} — newest first.
        </p>
      </div>

      <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface/40">
        {rows.map(({ entry, title }) => {
          const t = title as Title;
          return (
            <li key={entry.sessionId} className="flex items-center gap-4 p-4">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <Link
                  href={`/title/${t.type}/${t.slug}`}
                  className="truncate text-sm font-medium hover:underline"
                >
                  {t.name}
                </Link>
                <span className="text-xs text-content-muted">
                  Watched {formatWatchedAt(entry.watchedAt)}
                  {entry.state === 'playing' ? ' · still open' : ''}
                </span>
              </div>
              <Link
                href={`/watch/${t.type}/${t.slug}`}
                className={buttonClasses({ variant: 'secondary', size: 'sm' })}
              >
                Play again
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
