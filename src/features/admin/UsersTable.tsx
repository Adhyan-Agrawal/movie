'use client';

import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { DataTable, type Column } from './DataTable';
import type { AdminAccountRow } from './types';

/**
 * Users table (Spec Section 10 "Users"). Renders REAL `accounts` rows passed
 * from the server page (users.read; the accounts table carries no email, so
 * the display name + account id is the support-safe identity). Suspend and
 * revoke-sessions are affordances only — they stay disabled and persist
 * nothing until the user-management phase lands.
 */

const ACTIONS_PENDING_LABEL = 'Suspend and revoke-sessions actions arrive with the user-management phase.';

function formatDate(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

export function UsersTable({ accounts }: { accounts: AdminAccountRow[] }) {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return accounts;
    return accounts.filter((a) => `${a.display_name} ${a.id}`.toLowerCase().includes(q));
  }, [accounts, query]);

  const columns: Column<AdminAccountRow>[] = [
    {
      key: 'account',
      header: 'Account',
      sortAccessor: (a) => a.display_name,
      render: (a) => (
        <span className="flex flex-col">
          <span className="font-medium text-content">{a.display_name}</span>
          <span className="font-mono text-xs text-content-subtle">{a.id}</span>
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      sortAccessor: (a) => (a.is_suspended ? 'suspended' : 'active'),
      render: (a) =>
        a.is_suspended ? <Badge tone="danger">Suspended</Badge> : <Badge tone="success">Active</Badge>,
    },
    {
      key: 'created',
      header: 'Created',
      align: 'right',
      sortAccessor: (a) => a.created_at,
      render: (a) => <span className="tabular-nums text-content-subtle">{formatDate(a.created_at)}</span>,
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex max-w-sm flex-col gap-1">
        <label htmlFor="users-q" className="text-xs font-medium text-content-muted">
          Search accounts
        </label>
        <input
          id="users-q"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Display name or account id"
          className="h-9 rounded-md border border-border bg-surface px-3 text-sm text-content placeholder:text-content-subtle focus-visible:outline-none"
        />
      </div>

      <DataTable<AdminAccountRow>
        caption="Platform accounts with status and creation date"
        columns={columns}
        rows={filtered}
        getRowId={(a) => a.id}
        getRowLabel={(a) => a.display_name}
        rowActions={() => (
          <>
            <Button size="sm" variant="ghost" disabled title={ACTIONS_PENDING_LABEL}>
              Suspend
            </Button>
            <Button size="sm" variant="ghost" disabled title={ACTIONS_PENDING_LABEL}>
              Revoke
            </Button>
          </>
        )}
        emptyState={
          accounts.length === 0 ? (
            <EmptyState
              icon="☺"
              title="No accounts yet"
              description="Accounts will appear here as users sign up."
            />
          ) : (
            <EmptyState title="No matching accounts" description="Adjust the search to widen the query." />
          )
        }
      />

      <p className="text-xs text-content-subtle">{ACTIONS_PENDING_LABEL}</p>
    </div>
  );
}
