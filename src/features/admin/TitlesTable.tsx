'use client';

import { useState } from 'react';
import type { Title } from '@/features/catalog/types';
import { Badge } from '@/components/ui/Badge';
import { DataTable, type BulkAction, type Column } from './DataTable';
import { catalogAdminMeta, type CatalogRow, type TitleStatus, type TitleVisibility } from './mock';

/**
 * Client table wrapper for the catalog (Section 10). The page stays a Server
 * Component that fetches via listTitles(); it passes plain Title[] here, and
 * this client component supplies the column render config (functions can't
 * cross the RSC boundary) plus bulk-action affordances.
 */

const statusTone: Record<TitleStatus, 'success' | 'info' | 'warning' | 'neutral'> = {
  published: 'success',
  scheduled: 'info',
  draft: 'warning',
  archived: 'neutral',
};

const visibilityTone: Record<TitleVisibility, 'neutral' | 'info' | 'warning'> = {
  public: 'neutral',
  unlisted: 'info',
  private: 'warning',
};

function formatDate(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

const columns: Column<CatalogRow>[] = [
  {
    key: 'name',
    header: 'Name',
    sortAccessor: (r) => r.title.name,
    render: (r) => (
      <span className="flex flex-col">
        <span className="font-medium text-content">{r.title.name}</span>
        {r.title.originalName ? (
          <span className="text-xs text-content-subtle">{r.title.originalName}</span>
        ) : null}
      </span>
    ),
  },
  {
    key: 'type',
    header: 'Type',
    sortAccessor: (r) => r.title.type,
    render: (r) => <span className="uppercase">{r.title.type}</span>,
  },
  {
    key: 'status',
    header: 'Status',
    sortAccessor: (r) => r.meta.status,
    render: (r) => <Badge tone={statusTone[r.meta.status]}>{r.meta.status}</Badge>,
  },
  {
    key: 'visibility',
    header: 'Visibility',
    sortAccessor: (r) => r.meta.visibility,
    render: (r) => <Badge tone={visibilityTone[r.meta.visibility]}>{r.meta.visibility}</Badge>,
  },
  {
    key: 'year',
    header: 'Year',
    align: 'right',
    sortAccessor: (r) => r.title.releaseYear,
    render: (r) => <span className="tabular-nums">{r.title.releaseYear}</span>,
  },
  {
    key: 'updated',
    header: 'Updated',
    align: 'right',
    sortAccessor: (r) => r.meta.updatedAt,
    render: (r) => <span className="tabular-nums text-content-subtle">{formatDate(r.meta.updatedAt)}</span>,
  },
];

const bulkActions: BulkAction[] = [
  {
    id: 'publish',
    label: 'Publish',
    confirmTitle: 'Publish selected titles?',
    confirmDescription:
      'Selected titles become publicly visible where region and rating policy allow. Reversible via unpublish; an audit event is recorded.',
  },
  {
    id: 'archive',
    label: 'Archive',
    confirmTitle: 'Archive selected titles?',
    confirmDescription: 'Archived titles are hidden from browse but retained for auditability and can be restored.',
  },
  {
    id: 'delete',
    label: 'Delete',
    destructive: true,
    confirmTitle: 'Delete selected titles?',
    confirmDescription:
      'Soft-deletes the selected titles. This is a preview affordance — the real action re-authenticates, checks catalog.delete, and writes an audit event.',
  },
];

export function TitlesTable({ titles }: { titles: Title[] }) {
  const [status, setStatus] = useState<string | null>(null);
  const rows: CatalogRow[] = titles.map((title) => ({ title, meta: catalogAdminMeta(title.id) }));

  return (
    <div className="flex flex-col gap-2">
      <p aria-live="polite" className="min-h-4 text-xs text-content-muted">
        {status}
      </p>
      <DataTable<CatalogRow>
        caption="Catalog titles with type, status, visibility, release year and last-updated date"
        columns={columns}
        rows={rows}
        getRowId={(r) => r.title.id}
        getRowLabel={(r) => r.title.name}
        selectable
        bulkActions={bulkActions}
        onBulkAction={(actionId, ids) =>
          setStatus(`Preview: "${actionId}" would apply to ${ids.length} title${ids.length === 1 ? '' : 's'} (no changes made).`)
        }
      />
    </div>
  );
}
