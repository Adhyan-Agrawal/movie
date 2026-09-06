'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { cn } from '@/lib/cn';
import { ConfirmDialog } from './ConfirmDialog';

/**
 * Generic, accessible data table (Section 5 "data table, bulk actions").
 *
 * Semantics: a real <table> with an sr-only <caption>, <th scope="col"> headers
 * (sortable ones are <button>s exposing aria-sort), and a <th scope="row"> for
 * each row's primary cell. Optional row selection drives a bulk-action toolbar
 * whose actions all route through the ConfirmDialog (reversible/confirmed).
 *
 * This is a Client Component; pages that own data stay Server Components and
 * pass a plain row array plus a client column config (render functions can't
 * cross the server/client boundary, so column configs live in client wrappers).
 */

export interface Column<T> {
  key: string;
  header: string;
  render?: (row: T) => React.ReactNode;
  /** Accessor used for client-side sorting; enables the sortable header. */
  sortAccessor?: (row: T) => string | number;
  align?: 'left' | 'right' | 'center';
  className?: string;
  /** Header for icon-only columns; rendered visually hidden. */
  srOnlyHeader?: boolean;
}

export interface BulkAction {
  id: string;
  label: string;
  /** Destructive actions get a danger-toned confirm button. */
  destructive?: boolean;
  /** Confirmation copy; falls back to a generic message. */
  confirmTitle?: string;
  confirmDescription?: string;
}

type SortDir = 'asc' | 'desc';

export interface DataTableProps<T> {
  /** Describes the table for assistive tech (rendered as an sr-only caption). */
  caption: string;
  columns: Column<T>[];
  rows: T[];
  getRowId: (row: T) => string;
  /** Human label for a row, used on its selection checkbox. */
  getRowLabel?: (row: T) => string;
  selectable?: boolean;
  bulkActions?: BulkAction[];
  /** Per-row action cell (e.g. suspend/revoke buttons that open dialogs). */
  rowActions?: (row: T) => React.ReactNode;
  rowActionsHeader?: string;
  emptyState?: React.ReactNode;
  /** Invoked on confirmed bulk action; wiring is a UI affordance until APIs exist. */
  onBulkAction?: (actionId: string, ids: string[]) => void;
}

const alignClass: Record<NonNullable<Column<unknown>['align']>, string> = {
  left: 'text-left',
  right: 'text-right',
  center: 'text-center',
};

export function DataTable<T>({
  caption,
  columns,
  rows,
  getRowId,
  getRowLabel,
  selectable = false,
  bulkActions = [],
  rowActions,
  rowActionsHeader = 'Actions',
  emptyState,
  onBulkAction,
}: DataTableProps<T>) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<{ key: string; dir: SortDir } | null>(null);
  const [pending, setPending] = useState<BulkAction | null>(null);
  const selectAllRef = useRef<HTMLInputElement>(null);

  const sortedRows = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sortAccessor) return rows;
    const accessor = col.sortAccessor;
    const copy = [...rows];
    copy.sort((a, b) => {
      const av = accessor(a);
      const bv = accessor(b);
      let cmp: number;
      if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv;
      else cmp = String(av).localeCompare(String(bv));
      return sort.dir === 'asc' ? cmp : -cmp;
    });
    return copy;
  }, [rows, sort, columns]);

  const allIds = useMemo(() => sortedRows.map(getRowId), [sortedRows, getRowId]);
  const selectedCount = selected.size;
  const allSelected = allIds.length > 0 && allIds.every((id) => selected.has(id));
  const someSelected = selectedCount > 0 && !allSelected;

  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someSelected;
  }, [someSelected]);

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(allIds));
  }

  function toggleRow(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function requestSort(col: Column<T>) {
    if (!col.sortAccessor) return;
    setSort((prev) => {
      if (prev?.key === col.key) return { key: col.key, dir: prev.dir === 'asc' ? 'desc' : 'asc' };
      return { key: col.key, dir: 'asc' };
    });
  }

  function confirmBulk() {
    if (!pending) return;
    onBulkAction?.(pending.id, [...selected]);
    setSelected(new Set());
    setPending(null);
  }

  if (rows.length === 0) {
    return (
      <div>
        {emptyState ?? (
          <EmptyState title="Nothing here yet" description="Items will appear once they are created or imported." />
        )}
      </div>
    );
  }

  const columnCount = columns.length + (selectable ? 1 : 0) + (rowActions ? 1 : 0);

  return (
    <div className="flex flex-col gap-3">
      {selectable && bulkActions.length > 0 ? (
        <div
          role="region"
          aria-label="Bulk actions"
          className={cn(
            'flex min-h-11 flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors',
            selectedCount > 0 ? 'border-border-strong bg-surface-raised' : 'border-border bg-surface/40',
          )}
        >
          <span aria-live="polite" className="mr-1 font-medium text-content">
            {selectedCount > 0 ? `${selectedCount} selected` : 'Select rows to act on'}
          </span>
          <div className="flex flex-wrap gap-2">
            {bulkActions.map((action) => (
              <Button
                key={action.id}
                size="sm"
                variant={action.destructive ? 'ghost' : 'secondary'}
                disabled={selectedCount === 0}
                onClick={() => setPending(action)}
                className={action.destructive ? 'text-danger hover:bg-danger/10 hover:text-danger' : undefined}
              >
                {action.label}
              </Button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr className="border-b border-border bg-surface/60">
              {selectable ? (
                <th scope="col" className="w-10 px-3 py-2.5">
                  <input
                    ref={selectAllRef}
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleAll}
                    aria-label={allSelected ? 'Deselect all rows' : 'Select all rows'}
                    className="h-4 w-4 accent-primary"
                  />
                </th>
              ) : null}
              {columns.map((col) => {
                const isSorted = sort?.key === col.key;
                const ariaSort = isSorted ? (sort?.dir === 'asc' ? 'ascending' : 'descending') : undefined;
                return (
                  <th
                    key={col.key}
                    scope="col"
                    aria-sort={col.sortAccessor ? (ariaSort ?? 'none') : undefined}
                    className={cn(
                      'px-3 py-2.5 text-xs font-semibold uppercase tracking-wide text-content-subtle',
                      alignClass[col.align ?? 'left'],
                    )}
                  >
                    {col.srOnlyHeader ? (
                      <span className="sr-only">{col.header}</span>
                    ) : col.sortAccessor ? (
                      <button
                        type="button"
                        onClick={() => requestSort(col)}
                        className="inline-flex items-center gap-1 rounded-sm text-content-subtle transition-colors hover:text-content"
                      >
                        {col.header}
                        <span aria-hidden="true" className="text-[10px]">
                          {isSorted ? (sort?.dir === 'asc' ? '▲' : '▼') : '↕'}
                        </span>
                      </button>
                    ) : (
                      col.header
                    )}
                  </th>
                );
              })}
              {rowActions ? (
                <th scope="col" className="px-3 py-2.5 text-right">
                  <span className="sr-only">{rowActionsHeader}</span>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((row) => {
              const id = getRowId(row);
              const isSelected = selected.has(id);
              return (
                <tr
                  key={id}
                  className={cn(
                    'border-b border-border/60 transition-colors last:border-0 hover:bg-surface-raised/40',
                    isSelected && 'bg-primary/5',
                  )}
                >
                  {selectable ? (
                    <td className="px-3 py-2.5">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleRow(id)}
                        aria-label={`Select ${getRowLabel?.(row) ?? id}`}
                        className="h-4 w-4 accent-primary"
                      />
                    </td>
                  ) : null}
                  {columns.map((col, colIndex) => {
                    const content = col.render ? col.render(row) : null;
                    const cellClass = cn('px-3 py-2.5 align-middle', alignClass[col.align ?? 'left'], col.className);
                    if (colIndex === 0) {
                      return (
                        <th key={col.key} scope="row" className={cn(cellClass, 'font-normal text-content')}>
                          {content}
                        </th>
                      );
                    }
                    return (
                      <td key={col.key} className={cn(cellClass, 'text-content-muted')}>
                        {content}
                      </td>
                    );
                  })}
                  {rowActions ? (
                    <td className="px-3 py-2.5 text-right">
                      <div className="flex justify-end gap-1.5">{rowActions(row)}</div>
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Footer count for context */}
      <p className="px-1 text-xs text-content-subtle">
        <span aria-hidden="true">{`Showing ${sortedRows.length} of ${rows.length}`}</span>
        <span className="sr-only">{`Table has ${rows.length} rows and ${columnCount} columns.`}</span>
      </p>

      <ConfirmDialog
        open={pending !== null}
        title={pending?.confirmTitle ?? `${pending?.label ?? 'Apply'} ${selectedCount} item${selectedCount === 1 ? '' : 's'}?`}
        description={
          pending?.confirmDescription ??
          'This is a preview affordance. Once Supabase and RBAC are wired, this runs server-side, is authorized, and writes an audit event.'
        }
        confirmLabel={pending?.label ?? 'Confirm'}
        tone={pending?.destructive ? 'danger' : 'primary'}
        onCancel={() => setPending(null)}
        onConfirm={confirmBulk}
      />
    </div>
  );
}
