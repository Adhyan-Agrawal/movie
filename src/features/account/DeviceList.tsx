'use client';

import { useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';
import { ConfirmDialog } from './ConfirmDialog';
import { formatRelativeTime, type DeviceKind, type DeviceSession } from './mock';

const KIND_ICON: Record<DeviceKind, string> = {
  desktop: '🖥️',
  mobile: '📱',
  tablet: '▤',
  tv: '📺',
};

/**
 * Device sessions with revoke controls (Section 8). The current device is
 * badged and cannot be revoked from itself. Revoking a session — or all other
 * sessions — is destructive and confirmed through the accessible dialog.
 */
export function DeviceList({ sessions: initialSessions }: { sessions: DeviceSession[] }) {
  const [sessions, setSessions] = useState<DeviceSession[]>(initialSessions);
  const [pending, setPending] = useState<DeviceSession | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const [status, setStatus] = useState('');

  const otherCount = sessions.filter((session) => !session.current).length;

  const revokeOne = () => {
    if (!pending) return;
    const { id, device } = pending;
    setSessions((prev) => prev.filter((session) => session.id !== id));
    setPending(null);
    setStatus(`Signed out of ${device}.`);
  };

  const revokeAll = () => {
    setSessions((prev) => prev.filter((session) => session.current));
    setConfirmAll(false);
    setStatus('Signed out of all other devices.');
  };

  return (
    <section aria-labelledby="devices-heading" className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 id="devices-heading" className="text-lg font-semibold">
            Signed-in devices
          </h2>
          <p className="text-sm text-content-muted">
            Manage where you’re signed in. Revoking a device signs it out immediately.
          </p>
        </div>
        {otherCount > 0 ? (
          <Button variant="secondary" size="sm" onClick={() => setConfirmAll(true)}>
            Sign out all other devices
          </Button>
        ) : null}
      </div>

      <ul className="flex flex-col gap-3">
        {sessions.map((session) => (
          <li
            key={session.id}
            className={cn(
              'flex items-center gap-4 rounded-lg border border-border bg-surface/40 p-4',
              session.current && 'border-border-strong',
            )}
          >
            <span
              aria-hidden="true"
              className="grid h-11 w-11 shrink-0 place-items-center rounded-md bg-surface-raised text-xl"
            >
              {KIND_ICON[session.kind]}
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium text-content">{session.device}</span>
                {session.current ? <Badge tone="success">This device</Badge> : null}
              </div>
              <span className="truncate text-xs text-content-muted">
                {session.platform} · {session.location}
              </span>
              <span className="text-xs text-content-subtle">
                {session.current ? 'Active now' : `Last active ${formatRelativeTime(session.lastActive)}`} · IP{' '}
                {session.ipMasked}
              </span>
            </div>
            {session.current ? (
              <span className="shrink-0 text-xs text-content-subtle">Current</span>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                className="shrink-0 text-danger hover:text-danger hover:bg-danger/10"
                onClick={() => setPending(session)}
                aria-label={`Revoke ${session.device}`}
              >
                Revoke
              </Button>
            )}
          </li>
        ))}
      </ul>

      <p aria-live="polite" className="sr-only">
        {status}
      </p>

      <ConfirmDialog
        open={pending !== null}
        tone="danger"
        title="Revoke this device?"
        description={
          pending
            ? `“${pending.device}” will be signed out and must sign in again to access your account.`
            : undefined
        }
        confirmLabel="Revoke device"
        cancelLabel="Cancel"
        onConfirm={revokeOne}
        onCancel={() => setPending(null)}
      />
      <ConfirmDialog
        open={confirmAll}
        tone="danger"
        title="Sign out all other devices?"
        description="Every device except the one you’re using now will be signed out immediately."
        confirmLabel="Sign out others"
        cancelLabel="Cancel"
        onConfirm={revokeAll}
        onCancel={() => setConfirmAll(false)}
      />
    </section>
  );
}
