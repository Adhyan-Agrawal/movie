'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Button, buttonClasses } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import type { Title } from '@/features/catalog/types';
import { ConfirmDialog } from './ConfirmDialog';
import { formatRelativeTime, type HistoryEntry } from './mock';

export interface HistoryItem {
  entry: HistoryEntry;
  title: Title;
}

/**
 * Viewing history list (Section 4). Each row shows resume progress and a
 * "Remove" affordance; "Clear all" wipes history. Both destructive paths are
 * confirmed through the accessible dialog and announced via aria-live.
 */
export function HistoryList({ items: initialItems }: { items: HistoryItem[] }) {
  const [items, setItems] = useState<HistoryItem[]>(initialItems);
  const [pending, setPending] = useState<HistoryItem | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [status, setStatus] = useState('');

  const removeOne = () => {
    if (!pending) return;
    const { entry, title } = pending;
    setItems((prev) => prev.filter((item) => item.entry.id !== entry.id));
    setPending(null);
    setStatus(`Removed ${title.name} from your history.`);
  };

  const clearAll = () => {
    setItems([]);
    setConfirmClear(false);
    setStatus('Your viewing history was cleared.');
  };

  if (items.length === 0) {
    return (
      <>
        <EmptyState
          icon="🕑"
          title="No viewing history"
          description="Titles you watch will appear here so you can pick up where you left off."
          action={
            <Link href="/browse" className={buttonClasses({ variant: 'primary' })}>
              Browse the catalog
            </Link>
          }
        />
        <p aria-live="polite" className="sr-only">
          {status}
        </p>
      </>
    );
  }

  return (
    <section aria-labelledby="history-heading" className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 id="history-heading" className="text-lg font-semibold">
            Viewing history
          </h2>
          <p className="text-sm text-content-muted">
            {items.length} recent {items.length === 1 ? 'title' : 'titles'}.
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => setConfirmClear(true)}>
          Clear all
        </Button>
      </div>

      <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface/40">
        {items.map(({ entry, title }) => {
          const pct = Math.round(Math.min(1, Math.max(0, entry.progress)) * 100);
          const finished = entry.progress >= 1;
          return (
            <li key={entry.id} className="flex items-center gap-4 p-4">
              <div
                className="aspect-[2/3] w-12 shrink-0 overflow-hidden rounded-md border border-border bg-surface-raised"
                style={
                  title.posterUrl?.startsWith('linear-gradient') ? { backgroundImage: title.posterUrl } : undefined
                }
                aria-hidden="true"
              />
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <div className="flex items-baseline justify-between gap-2">
                  <Link
                    href={`/title/${title.type}/${title.slug}`}
                    className="truncate text-sm font-medium text-content hover:text-primary"
                  >
                    {title.name}
                  </Link>
                  <span className="shrink-0 text-xs text-content-subtle">{formatRelativeTime(entry.watchedAt)}</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="h-1 flex-1 overflow-hidden rounded-full bg-surface-raised">
                    <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="shrink-0 text-xs text-content-muted">{finished ? 'Finished' : `${pct}%`}</span>
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="shrink-0"
                onClick={() => setPending({ entry, title })}
                aria-label={`Remove ${title.name} from history`}
              >
                Remove
              </Button>
            </li>
          );
        })}
      </ul>

      <p aria-live="polite" className="sr-only">
        {status}
      </p>

      <ConfirmDialog
        open={pending !== null}
        tone="danger"
        title="Remove from history?"
        description={
          pending
            ? `“${pending.title.name}” will be removed from your viewing history and resume list.`
            : undefined
        }
        confirmLabel="Remove"
        cancelLabel="Cancel"
        onConfirm={removeOne}
        onCancel={() => setPending(null)}
      />
      <ConfirmDialog
        open={confirmClear}
        tone="danger"
        title="Clear all history?"
        description="Your entire viewing history and resume progress will be removed. This can’t be undone."
        confirmLabel="Clear history"
        cancelLabel="Cancel"
        onConfirm={clearAll}
        onCancel={() => setConfirmClear(false)}
      />
    </section>
  );
}
