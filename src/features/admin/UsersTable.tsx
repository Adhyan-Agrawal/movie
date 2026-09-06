'use client';

import { useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from './ConfirmDialog';
import { DataTable, type Column } from './DataTable';
import { ADMIN_USERS, maskEmail, type AdminUser } from './mock';

/**
 * Users table (Section 10 "Users" — safe metadata; suspend + revoke sessions).
 * Emails are masked for support-safe display. Each destructive per-row action
 * opens the ConfirmDialog; the dialog state is owned here (client) while the
 * page stays a Server Component.
 */

const statusTone: Record<AdminUser['status'], 'success' | 'danger' | 'info'> = {
  active: 'success',
  suspended: 'danger',
  invited: 'info',
};

const roleLabel: Record<AdminUser['role'], string> = {
  viewer: 'Viewer',
  editor: 'Editor',
  ad_manager: 'Ad manager',
  support: 'Support',
  admin: 'Administrator',
  owner: 'Owner',
};

function formatLastActive(value: string): string {
  if (value === '—') return '—';
  return new Date(value).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

type PendingAction = { user: AdminUser; kind: 'suspend' | 'revoke' } | null;

export function UsersTable() {
  const [pending, setPending] = useState<PendingAction>(null);
  const [status, setStatus] = useState<string | null>(null);

  const columns: Column<AdminUser>[] = [
    {
      key: 'user',
      header: 'User',
      sortAccessor: (u) => u.displayName,
      render: (u) => (
        <span className="flex flex-col">
          <span className="font-medium text-content">{u.displayName}</span>
          <span className="font-mono text-xs text-content-subtle">{maskEmail(u.email)}</span>
        </span>
      ),
    },
    {
      key: 'role',
      header: 'Role',
      sortAccessor: (u) => u.role,
      render: (u) => roleLabel[u.role],
    },
    {
      key: 'status',
      header: 'Status',
      sortAccessor: (u) => u.status,
      render: (u) => <Badge tone={statusTone[u.status]}>{u.status}</Badge>,
    },
    {
      key: 'profiles',
      header: 'Profiles',
      align: 'right',
      sortAccessor: (u) => u.profiles,
      render: (u) => <span className="tabular-nums">{u.profiles}</span>,
    },
    {
      key: 'lastActive',
      header: 'Last active',
      align: 'right',
      sortAccessor: (u) => u.lastActive,
      render: (u) => <span className="tabular-nums text-content-subtle">{formatLastActive(u.lastActive)}</span>,
    },
  ];

  const dialogCopy =
    pending?.kind === 'suspend'
      ? {
          title: `Suspend ${pending.user.displayName}?`,
          description:
            'Suspension blocks sign-in and playback immediately. It is reversible and requires re-authentication plus an audit event once RBAC is wired.',
          confirm: 'Suspend',
        }
      : pending
        ? {
            title: `Revoke sessions for ${pending.user.displayName}?`,
            description:
              'Signs the account out of all devices. The user can sign back in unless also suspended. An audit event is recorded.',
            confirm: 'Revoke sessions',
          }
        : { title: '', description: '', confirm: 'Confirm' };

  return (
    <div className="flex flex-col gap-2">
      <p aria-live="polite" className="min-h-4 text-xs text-content-muted">
        {status}
      </p>
      <DataTable<AdminUser>
        caption="Platform users with role, status, profile count and last-active time; email is masked"
        columns={columns}
        rows={ADMIN_USERS}
        getRowId={(u) => u.id}
        getRowLabel={(u) => u.displayName}
        rowActions={(u) => (
          <>
            <Button
              size="sm"
              variant="ghost"
              disabled={u.status === 'suspended'}
              onClick={() => setPending({ user: u, kind: 'suspend' })}
              className="text-danger hover:bg-danger/10 hover:text-danger disabled:text-content-subtle"
            >
              Suspend
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={u.status === 'invited'}
              onClick={() => setPending({ user: u, kind: 'revoke' })}
            >
              Revoke
            </Button>
          </>
        )}
      />

      <ConfirmDialog
        open={pending !== null}
        title={dialogCopy.title}
        description={dialogCopy.description}
        confirmLabel={dialogCopy.confirm}
        tone={pending?.kind === 'suspend' ? 'danger' : 'primary'}
        onCancel={() => setPending(null)}
        onConfirm={() => {
          if (pending) {
            setStatus(
              `Preview: "${pending.kind}" would apply to ${pending.user.displayName} (no changes made).`,
            );
          }
          setPending(null);
        }}
      />
    </div>
  );
}
