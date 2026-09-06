import { Badge } from '@/components/ui/Badge';
import { cn } from '@/lib/cn';
import type { AdminAuditEvent, AuditOutcome } from './types';

/**
 * Vertical audit timeline (Spec Section 10 "Audit" — immutable events with
 * before/after diffs, actor, target, reason, outcome). Rendered as an ordered
 * list for correct reading order; the before/after summary is a compact diff.
 *
 * Hook-free and presentational so it works in Server and Client Components.
 * Events are real `audit_logs` rows (see `./queries`).
 */

const outcomeMeta: Record<AuditOutcome, { tone: 'success' | 'danger'; label: string; ring: string }> = {
  success: { tone: 'success', label: 'Success', ring: 'bg-success' },
  failure: { tone: 'danger', label: 'Failed', ring: 'bg-danger' },
};

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  return `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 16)} UTC`;
}

export function AuditTimeline({ events, className }: { events: AdminAuditEvent[]; className?: string }) {
  return (
    <ol className={cn('flex flex-col', className)}>
      {events.map((event, index) => {
        const meta = outcomeMeta[event.outcome];
        const isLast = index === events.length - 1;
        return (
          <li key={event.id} className="relative flex gap-4 pb-6 last:pb-0">
            {/* Rail + node */}
            <div className="relative flex flex-col items-center">
              <span
                aria-hidden="true"
                className={cn('mt-1 h-2.5 w-2.5 shrink-0 rounded-full ring-4 ring-surface', meta.ring)}
              />
              {!isLast ? <span aria-hidden="true" className="mt-1 w-px flex-1 bg-border" /> : null}
            </div>

            <div className="flex-1 pb-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <code className="rounded-sm bg-surface-raised px-1.5 py-0.5 font-mono text-xs text-content">
                  {event.action}
                </code>
                <span className="text-sm font-medium text-content">{event.target}</span>
                <Badge tone={meta.tone}>{meta.label}</Badge>
              </div>

              <p className="mt-1 text-xs text-content-subtle">
                <span className="font-mono text-content-muted">{event.actor}</span>
                {' · '}
                <time dateTime={event.timestamp}>{formatTimestamp(event.timestamp)}</time>
              </p>

              {event.before || event.after ? (
                <dl className="mt-2 grid gap-2 rounded-md border border-border bg-surface/50 p-2 text-xs sm:grid-cols-2">
                  <div className="flex flex-col gap-0.5">
                    <dt className="text-[10px] font-semibold uppercase tracking-wide text-content-subtle">Before</dt>
                    <dd className="font-mono text-content-muted">{event.before ?? '—'}</dd>
                  </div>
                  <div className="flex flex-col gap-0.5 sm:border-l sm:border-border sm:pl-2">
                    <dt className="text-[10px] font-semibold uppercase tracking-wide text-content-subtle">After</dt>
                    <dd className="font-mono text-content">{event.after ?? '—'}</dd>
                  </div>
                </dl>
              ) : null}

              {event.reason ? (
                <p className="mt-1.5 text-xs text-content-muted">
                  <span className="text-content-subtle">Reason: </span>
                  {event.reason}
                </p>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
