'use client';

import { useState, useTransition } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import {
  checkSourceHealthAction,
  type SourceHealthResult,
} from './bulk-sources-actions';

/**
 * Source health checker (Spec Sections 14/15): one click probes a capped sample
 * (max 25) of remote `media_sources` URLs server-side — HEAD with a ranged-GET
 * fallback and a short timeout. Response bodies are never read, stored, or
 * logged; only status codes come back. Storage-backed uploads are skipped
 * (they have no url to probe). Gated server-side by `provider.manage`.
 */

/** Status -> badge tone for the results table. */
const STATUS_TONE: Record<SourceHealthResult['status'], 'success' | 'danger' | 'neutral'> = {
  healthy: 'success',
  unreachable: 'danger',
  skipped: 'neutral',
};

export function SourceHealthChecker() {
  const [results, setResults] = useState<SourceHealthResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function run() {
    setError(null);
    setResults(null);
    startTransition(async () => {
      const res = await checkSourceHealthAction();
      if (!res.ok) {
        setError(res.error ?? 'Could not check source health.');
      } else {
        setResults(res.results);
      }
    });
  }

  const healthy = results?.filter((r) => r.status === 'healthy').length ?? 0;
  const unreachable = results?.filter((r) => r.status === 'unreachable').length ?? 0;
  const skipped = results?.filter((r) => r.status === 'skipped').length ?? 0;

  return (
    <section
      aria-labelledby="health-check-heading"
      className="flex flex-col gap-4 rounded-lg border border-border bg-surface/50 p-4 shadow-soft"
    >
      <div className="flex flex-col gap-1">
        <h2 id="health-check-heading" className="text-lg font-semibold text-content">
          Source health check
        </h2>
        <p className="text-sm leading-relaxed text-content-muted">
          Probes the most recently updated remote sources (up to 25) with a HEAD request — falling back to a ranged GET
          for CDNs that refuse HEAD — and reports healthy vs. unreachable. A short timeout keeps a hung CDN from
          blocking the check. Response bodies are never stored or logged; only status codes are recorded.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={run} disabled={pending}>
          {pending ? 'Probing sources…' : 'Check source health'}
        </Button>
        {pending ? <span className="text-sm text-content-muted">Probing up to 25 sources…</span> : null}
      </div>

      {error ? (
        <p role="alert" className="rounded-md border border-danger/40 bg-danger/10 px-4 py-3 text-sm leading-relaxed text-danger">
          {error}
        </p>
      ) : null}

      {results ? (
        <div className="flex flex-col gap-3" aria-live="polite">
          <p className="text-sm text-content-muted">
            <span className="font-semibold text-content">{healthy}</span> healthy ·{' '}
            <span className="font-semibold text-danger">{unreachable}</span> unreachable ·{' '}
            <span className="font-semibold">{skipped}</span> skipped
          </p>

          <div className="overflow-x-auto rounded-lg border border-border bg-surface/40 shadow-soft">
            <table className="w-full min-w-[42rem] border-collapse text-sm">
              <caption className="sr-only">Health probe results per source</caption>
              <thead>
                <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-content-subtle">
                  <th scope="col" className="px-3 py-2 font-medium">Label</th>
                  <th scope="col" className="px-3 py-2 font-medium">Kind</th>
                  <th scope="col" className="px-3 py-2 font-medium">Host / path</th>
                  <th scope="col" className="px-3 py-2 font-medium">Status</th>
                  <th scope="col" className="px-3 py-2 font-medium">Detail</th>
                </tr>
              </thead>
              <tbody>
                {results.map((row) => (
                  <tr key={row.id} className="border-b border-border last:border-b-0">
                    <th scope="row" className="max-w-[16rem] truncate px-3 py-2.5 text-left font-medium text-content">
                      {row.label || '—'}
                    </th>
                    <td className="px-3 py-2.5 text-content-muted">{row.kind}</td>
                    <td className="max-w-[20rem] truncate px-3 py-2.5 font-mono text-xs text-content-subtle">{row.url}</td>
                    <td className="px-3 py-2.5">
                      <Badge tone={STATUS_TONE[row.status]}>{row.status}</Badge>
                    </td>
                    <td className="px-3 py-2.5 text-content-muted">{row.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </section>
  );
}
