'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { cn } from '@/lib/cn';
import { DataTable, type Column } from './DataTable';
import type { AdminTitleRequestRow, TitleRequestStatus } from './types';
import { importRequestedTitleAction, rejectRequestedTitleAction } from './requests-actions';

/**
 * Admin title-request queue (Spec Section 4). Renders REAL `title_requests`
 * rows passed from the server page (catalog.read via RLS). Pending rows offer
 * Import (TMDB search-to-import) and Reject, both wired to the permission-gated
 * server actions in `./requests-actions` (catalog.create) and run through
 * `useTransition` + `router.refresh()` so the queue updates in place.
 */

function statusTone(status: TitleRequestStatus): 'warning' | 'success' | 'danger' {
  return status === 'pending' ? 'warning' : status === 'imported' ? 'success' : 'danger';
}

function formatDate(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Per-request action cell (import / reject) — pending rows only
// ---------------------------------------------------------------------------

function RequestActions({ request }: { request: AdminTitleRequestRow }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function run(action: 'import' | 'reject') {
    setError(null);
    startTransition(async () => {
      const result =
        action === 'import'
          ? await importRequestedTitleAction(request.id)
          : await rejectRequestedTitleAction(request.id);
      if (!result.ok) {
        setError(result.error ?? 'Could not update the request.');
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        <Button size="sm" variant="primary" disabled={pending} onClick={() => run('import')}>
          {pending ? 'Importing…' : 'Import'}
        </Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => run('reject')}>
          Reject
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Queue panel
// ---------------------------------------------------------------------------

const FILTERS: ReadonlyArray<{ key: TitleRequestStatus | 'all'; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'pending', label: 'Pending' },
  { key: 'imported', label: 'Imported' },
  { key: 'rejected', label: 'Rejected' },
];

export function RequestsPanel({ requests }: { requests: AdminTitleRequestRow[] }) {
  const [status, setStatus] = useState<TitleRequestStatus | 'all'>('all');

  const filtered = useMemo(() => {
    if (status === 'all') return requests;
    return requests.filter((r) => r.status === status);
  }, [requests, status]);

  const columns: Column<AdminTitleRequestRow>[] = [
    {
      key: 'title',
      header: 'Title',
      sortAccessor: (r) => r.title_name,
      render: (r) => (
        <span className="flex flex-col">
          <span className="font-medium text-content">{r.title_name}</span>
          <span className="text-xs uppercase tracking-wide text-content-subtle">
            {r.media_type}
            {r.year ? ` · ${r.year}` : ''}
          </span>
        </span>
      ),
    },
    {
      key: 'note',
      header: 'Note',
      render: (r) =>
        r.note ? <span className="max-w-md truncate text-content-muted">{r.note}</span> : <span className="text-content-subtle">—</span>,
    },
    {
      key: 'status',
      header: 'Status',
      sortAccessor: (r) => r.status,
      render: (r) => <Badge tone={statusTone(r.status)}>{r.status}</Badge>,
    },
    {
      key: 'created',
      header: 'Requested',
      align: 'right',
      sortAccessor: (r) => r.created_at,
      render: (r) => <span className="tabular-nums text-content-subtle">{formatDate(r.created_at)}</span>,
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      <div role="group" aria-label="Filter requests by status" className="flex flex-wrap gap-2">
        {FILTERS.map((option) => (
          <button
            key={option.key}
            type="button"
            aria-pressed={status === option.key}
            onClick={() => setStatus(option.key)}
            className={cn(
              'h-9 rounded-md border px-3 text-sm transition-colors duration-150 ease-deliberate',
              status === option.key
                ? 'border-border-strong bg-surface-overlay font-medium text-content'
                : 'border-border bg-surface-raised/60 text-content-muted hover:text-content',
            )}
          >
            {option.label}
          </button>
        ))}
      </div>

      <DataTable<AdminTitleRequestRow>
        caption="Viewer title requests with status and per-row actions"
        columns={columns}
        rows={filtered}
        getRowId={(r) => r.id}
        getRowLabel={(r) => r.title_name}
        rowActions={(r) => (r.status === 'pending' ? <RequestActions request={r} /> : null)}
        emptyState={
          requests.length === 0 ? (
            <EmptyState
              icon="✧"
              title="No requests yet"
              description="Titles viewers ask for on the request page will appear here."
            />
          ) : (
            <EmptyState title="No matching requests" description="Try a different status filter." />
          )
        }
      />
    </div>
  );
}
