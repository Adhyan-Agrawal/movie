'use client';

import { useState, useTransition } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import {
  bulkImportSourcesAction,
  type BulkImportResult,
  type BulkImportRowResult,
} from './bulk-sources-actions';

/**
 * Bulk remote-source importer (Spec Sections 9, 15): paste a CSV
 * (`tmdb_id,season,episode,url,label,language,quality`) and import every row in
 * one go. Each row is resolved/validated server-side (title by tmdb_id,
 * episode by season+episode, SSRF-safe URL check) and upserted into
 * `media_sources` — results are reported per line, so a bad row never aborts
 * the rest. Gated server-side by `provider.manage`.
 */

/** Starter CSV shown in the textarea so operators can see the shape. */
const SAMPLE_CSV = `tmdb_id,season,episode,url,label,language,quality
550,,,https://cdn.example.com/movie/master.m3u8,Provider A 1080p,en,1080p
1396,1,3,https://cdn.example.com/s1e3.mp4,Provider B,en,720p`;

/** Status -> badge tone mapping for the per-row table. */
const STATUS_TONE: Record<BulkImportRowResult['status'], 'success' | 'neutral' | 'danger'> = {
  imported: 'success',
  skipped: 'neutral',
  error: 'danger',
};

function SummaryBadge({ label, count, tone }: { label: string; count: number; tone: 'success' | 'neutral' | 'danger' }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-sm">
      <Badge tone={tone}>{count}</Badge>
      <span className="text-content-muted">{label}</span>
    </span>
  );
}

export function BulkSourceImporterPanel() {
  const [csv, setCsv] = useState('');
  const [result, setResult] = useState<BulkImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function importCsv() {
    setError(null);
    setResult(null);
    startTransition(async () => {
      const res = await bulkImportSourcesAction({ csv });
      if (!res.ok) {
        setError(res.error ?? 'Could not import sources.');
        setResult(null);
      } else {
        setResult(res);
      }
    });
  }

  return (
    <section
      aria-labelledby="bulk-import-heading"
      className="flex flex-col gap-4 rounded-lg border border-border bg-surface/50 p-4 shadow-soft"
    >
      <div className="flex flex-col gap-1">
        <h2 id="bulk-import-heading" className="text-lg font-semibold text-content">
          Bulk source import
        </h2>
        <p className="text-sm leading-relaxed text-content-muted">
          Paste a CSV with one remote stream per line — columns{' '}
          <code className="rounded-sm bg-surface-raised px-1 py-0.5 font-mono text-[12px]">tmdb_id,season,episode,url,label,language,quality</code>.
          Season and episode are optional (leave blank for a movie, or a whole-title source for a series). Each row
          resolves its title by TMDB id and upserts into <code className="font-mono text-[12px]">media_sources</code> —
          matching rows are refreshed, new rows are added. Every line reports its own outcome.
        </p>
      </div>

      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          importCsv();
        }}
      >
        <label htmlFor="bulk-csv" className="flex flex-col gap-1.5 text-xs text-content-muted">
          <span>CSV text</span>
          <textarea
            id="bulk-csv"
            value={csv}
            onChange={(e) => setCsv(e.target.value)}
            disabled={pending}
            spellCheck={false}
            rows={7}
            placeholder={SAMPLE_CSV}
            className="h-44 w-full resize-y rounded-md border border-border bg-surface-raised px-3 py-2 font-mono text-xs text-content placeholder:text-content-subtle shadow-soft transition-colors hover:border-border-strong focus:border-primary focus-visible:outline-none"
          />
        </label>

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={pending || !csv.trim()}>
            {pending ? 'Importing…' : 'Import sources'}
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={pending}
            onClick={() => {
              setCsv(SAMPLE_CSV);
              setResult(null);
              setError(null);
            }}
          >
            Load sample
          </Button>
          <span className="text-xs text-content-subtle">Each line is validated independently — nothing is imported until every line checks out.</span>
        </div>
      </form>

      {pending ? (
        <p role="status" className="text-sm text-content-muted">
          Resolving titles, episodes, and URLs…
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="rounded-md border border-danger/40 bg-danger/10 px-4 py-3 text-sm leading-relaxed text-danger">
          {error}
        </p>
      ) : null}

      {result ? (
        <div className="flex flex-col gap-3" aria-live="polite">
          <div className="flex flex-wrap items-center gap-3">
            <SummaryBadge label="imported" count={result.imported} tone="success" />
            <SummaryBadge label="skipped" count={result.skipped} tone="neutral" />
            <SummaryBadge label="failed" count={result.failed} tone="danger" />
          </div>

          {result.failed > 0 ? (
            <p className="text-sm text-warning">
              {result.failed} {result.failed === 1 ? 'line' : 'lines'} need attention — fix them in the CSV and re-run;
              already-imported lines are detected and refreshed, not duplicated.
            </p>
          ) : null}

          <div className="overflow-x-auto rounded-lg border border-border bg-surface/40 shadow-soft">
            <table className="w-full min-w-[42rem] border-collapse text-sm">
              <caption className="sr-only">Per-line import results</caption>
              <thead>
                <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-content-subtle">
                  <th scope="col" className="px-3 py-2 font-medium">Line</th>
                  <th scope="col" className="px-3 py-2 font-medium">TMDB</th>
                  <th scope="col" className="px-3 py-2 font-medium">Label</th>
                  <th scope="col" className="px-3 py-2 font-medium">Status</th>
                  <th scope="col" className="px-3 py-2 font-medium">Detail</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row) => (
                  <tr key={row.line} className="border-b border-border last:border-b-0">
                    <th scope="row" className="px-3 py-2.5 text-left font-mono text-xs tabular-nums text-content-subtle">
                      {row.line}
                    </th>
                    <td className="px-3 py-2.5 font-mono text-xs text-content-muted">{row.tmdbId}</td>
                    <td className="max-w-[18rem] truncate px-3 py-2.5 text-content">{row.label || '—'}</td>
                    <td className="px-3 py-2.5">
                      <Badge tone={STATUS_TONE[row.status]}>{row.status}</Badge>
                    </td>
                    <td className="max-w-[24rem] px-3 py-2.5 text-content-muted">{row.note ?? ''}</td>
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
