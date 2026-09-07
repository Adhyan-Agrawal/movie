'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { DataTable, type Column } from './DataTable';
import { ConfirmDialog } from './ConfirmDialog';
import type { AdminAccountRow } from './types';
import { suspendUserAction, unsuspendUserAction } from './user-actions';

/**
 * Users table (Spec Section 10 "Users"). Renders REAL `accounts` rows passed
 * from the server page (users.read; the accounts table carries no email, so
 * the display name + account id is the support-safe identity).
 *
 * Each row offers Suspend / Unsuspend wired to the permission-gated server
 * actions in `./user-actions` (users.suspend), confirmed through the
 * ConfirmDialog before it runs. Session revocation isn't wired: auth sessions
 * live in Supabase Auth, outside the public schema these actions reach.
 */

function formatDate(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Per-account action cell (suspend / unsuspend)
// ---------------------------------------------------------------------------

function UserActions({ account }: { account: AdminAccountRow }) {
  const router = useRouter();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const suspending = !account.is_suspended;

  function toggleSuspend() {
    setError(null);
    startTransition(async () => {
      const result = suspending
        ? await suspendUserAction(account.id)
        : await unsuspendUserAction(account.id);
      if (!result.ok) {
        setError(result.error ?? 'Could not update the account.');
        setConfirmOpen(false);
        return;
      }
      setConfirmOpen(false);
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap items-center justify-end gap-1">
        <Button
          size="sm"
          variant={suspending ? 'secondary' : 'ghost'}
          disabled={pending}
          onClick={() => setConfirmOpen(true)}
        >
          {suspending ? 'Suspend' : 'Unsuspend'}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
      <ConfirmDialog
        open={confirmOpen}
        title={suspending ? 'Suspend this account?' : 'Unsuspend this account?'}
        description={
          suspending
            ? `${account.display_name} will be marked suspended and lose access until an admin unsuspends them.`
            : `${account.display_name} will be marked active again and regain access.`
        }
        confirmLabel={suspending ? 'Suspend' : 'Unsuspend'}
        tone={suspending ? 'danger' : 'primary'}
        busy={pending}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={toggleSuspend}
      />
    </div>
  );
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
        rowActions={(a) => <UserActions account={a} />}
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
    </div>
  );
}
