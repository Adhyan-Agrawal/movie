'use client';

import type { Title } from '@/features/catalog/types';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { DataTable, type Column } from './DataTable';

/**
 * Client table wrapper for the catalog (Spec Section 10). The page stays a
 * Server Component that fetches REAL titles via `listTitles()` (catalog
 * queries layer, RLS-scoped); this client component supplies the column
 * render config (functions can't cross the RSC boundary). Only fields that
 * exist on the live Title DTO are shown — no fabricated status, visibility,
 * or last-updated columns. Publish/archive/delete are affordances only:
 * disabled and non-persisting until the catalog-management phase lands.
 */

const ACTIONS_PENDING_LABEL = 'Publish, archive, and delete actions arrive with the catalog-management phase.';

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

export function TitlesTable({ titles }: { titles: Title[] }) {
  return (
    <div className="flex flex-col gap-3">
      {titles.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" disabled title={ACTIONS_PENDING_LABEL}>
            Publish
          </Button>
          <Button size="sm" variant="ghost" disabled title={ACTIONS_PENDING_LABEL}>
            Archive
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled
            title={ACTIONS_PENDING_LABEL}
            className="text-danger hover:bg-danger/10 hover:text-danger disabled:text-content-subtle"
          >
            Delete
          </Button>
        </div>
      ) : null}

      <DataTable<Title>
        caption="Catalog titles with type, release year, maturity and featured state"
        columns={columns}
        rows={titles}
        getRowId={(t) => t.id}
        getRowLabel={(t) => t.name}
        emptyState={
          <EmptyState
            icon="⛃"
            title="No titles in the catalog yet"
            description="Run the TMDB sync (Catalog → Sync) to import titles — they will appear here."
          />
        }
      />

      {titles.length > 0 ? <p className="text-xs text-content-subtle">{ACTIONS_PENDING_LABEL}</p> : null}
    </div>
  );
}
