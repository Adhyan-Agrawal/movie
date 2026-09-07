'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { Title } from '@/features/catalog/types';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { DataTable, type Column } from './DataTable';
import { archiveTitleAction, deleteTitleAction, publishTitleAction } from './catalog-actions';

/**
 * Client table wrapper for the catalog (Spec Section 10). The page stays a
 * Server Component that fetches REAL titles via `listTitles()` (catalog
 * queries layer, RLS-scoped); this client component supplies the column
 * render config (functions can't cross the RSC boundary). Only fields that
 * exist on the live Title DTO are shown — no fabricated status, visibility,
 * or last-updated columns.
 *
 * Each row carries Publish / Archive / Delete actions wired to the
 * permission-gated server actions in `./catalog-actions` (catalog.publish /
 * catalog.create / catalog.delete). Delete uses an inline two-step confirm
 * like the media-sources row; all three refresh the route when they land so
 * the table reflects the new state.
 */

const columns: Column<Title>[] = [
  {
    key: 'name',
    header: 'Name',
    sortAccessor: (t) => t.name,
    render: (t) => (
      <span className="flex flex-col">
        <span className="font-medium text-content">{t.name}</span>
        {t.originalName ? <span className="text-xs text-content-subtle">{t.originalName}</span> : null}
      </span>
    ),
  },
  {
    key: 'type',
    header: 'Type',
    sortAccessor: (t) => t.type,
    render: (t) => <span className="uppercase">{t.type}</span>,
  },
  {
    key: 'year',
    header: 'Year',
    align: 'right',
    sortAccessor: (t) => t.releaseYear,
    render: (t) => <span className="tabular-nums">{t.releaseYear || '—'}</span>,
  },
  {
    key: 'maturity',
    header: 'Maturity',
    sortAccessor: (t) => t.maturity,
    render: (t) => <span>{t.maturity}</span>,
  },
  {
    key: 'featured',
    header: 'Featured',
    sortAccessor: (t) => (t.featured ? 'yes' : 'no'),
    render: (t) => (t.featured ? <Badge tone="info">Featured</Badge> : <span className="text-content-subtle">—</span>),
  },
];

// ---------------------------------------------------------------------------
// Per-title action cell (publish / archive / delete)
// ---------------------------------------------------------------------------

function TitleActions({ title }: { title: Title }) {
  const router = useRouter();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function run(action: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        setError(result.error ?? 'The action failed.');
        return;
      }
      setConfirmDelete(false);
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap items-center justify-end gap-1">
        <Button
          size="sm"
          variant="secondary"
          disabled={pending}
          onClick={() => run(() => publishTitleAction(title.id))}
        >
          Publish
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => run(() => archiveTitleAction(title.id))}
        >
          Archive
        </Button>
        {confirmDelete ? (
          <>
            <Button
              size="sm"
              variant="primary"
              disabled={pending}
              onClick={() => run(() => deleteTitleAction(title.id))}
              className="bg-danger text-white hover:bg-danger/90"
            >
              Confirm delete
            </Button>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => setConfirmDelete(false)}>
              No
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => setConfirmDelete(true)}
            className="text-danger hover:bg-danger/10 hover:text-danger"
          >
            Delete
          </Button>
        )}
      </div>
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function TitlesTable({ titles }: { titles: Title[] }) {
  return (
    <div className="flex flex-col gap-3">
      <DataTable<Title>
        caption="Catalog titles with type, release year, maturity and featured state"
        columns={columns}
        rows={titles}
        getRowId={(t) => t.id}
        getRowLabel={(t) => t.name}
        rowActions={(t) => <TitleActions title={t} />}
        emptyState={
          <EmptyState
            icon="⛃"
            title="No titles in the catalog yet"
            description="Run the TMDB sync (Catalog → Sync) to import titles — they will appear here."
          />
        }
      />
    </div>
  );
}
