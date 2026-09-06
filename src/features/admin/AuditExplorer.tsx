'use client';

import { useMemo, useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { AuditTimeline } from './AuditTimeline';
import { AUDIT_EVENTS, type Outcome } from './mock';

/**
 * Audit explorer (Section 10 "Audit" — filters + export). Filters are wired as
 * UI over the mock event set; the immutable timeline below reflects the query.
 */

type OutcomeFilter = Outcome | 'all';

export function AuditExplorer() {
  const [query, setQuery] = useState('');
  const [outcome, setOutcome] = useState<OutcomeFilter>('all');
  const [actor, setActor] = useState('all');

  const actors = useMemo(() => {
    const set = new Set(AUDIT_EVENTS.map((e) => e.actor.handle));
    return [...set].sort();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return AUDIT_EVENTS.filter((e) => {
      if (outcome !== 'all' && e.outcome !== outcome) return false;
      if (actor !== 'all' && e.actor.handle !== actor) return false;
      if (q) {
        const hay = `${e.action} ${e.target} ${e.reason ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [query, outcome, actor]);

  const selectClass =
    'h-9 rounded-md border border-border bg-surface px-2 text-sm text-content focus-visible:outline-none';

  return (
    <div className="flex flex-col gap-5">
      <div
        role="search"
        aria-label="Filter audit events"
        className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-surface/50 p-3"
      >
        <div className="flex min-w-48 flex-1 flex-col gap-1">
          <label htmlFor="audit-q" className="text-xs font-medium text-content-muted">
            Search action, target or reason
          </label>
          <input
            id="audit-q"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="e.g. publish, role, TMDB"
            className="h-9 rounded-md border border-border bg-surface px-3 text-sm text-content placeholder:text-content-subtle focus-visible:outline-none"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="audit-outcome" className="text-xs font-medium text-content-muted">
            Outcome
          </label>
          <select
            id="audit-outcome"
            value={outcome}
            onChange={(e) => setOutcome(e.target.value as OutcomeFilter)}
            className={selectClass}
          >
            <option value="all">All outcomes</option>
            <option value="success">Success</option>
            <option value="failure">Failed</option>
            <option value="pending">Pending</option>
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="audit-actor" className="text-xs font-medium text-content-muted">
            Actor
          </label>
          <select id="audit-actor" value={actor} onChange={(e) => setActor(e.target.value)} className={selectClass}>
            <option value="all">All actors</option>
            {actors.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </div>
      </div>

      <p aria-live="polite" className="text-xs text-content-subtle">
        {`${filtered.length} event${filtered.length === 1 ? '' : 's'}`}
      </p>

      {filtered.length > 0 ? (
        <AuditTimeline events={filtered} />
      ) : (
        <EmptyState title="No matching events" description="Adjust the filters to widen the query." />
      )}
    </div>
  );
}
