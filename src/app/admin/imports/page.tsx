import { PageHeader } from '@/components/ui/PageHeader';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { listImportJobs } from '@/features/admin/queries';
import type { ImportStatusEnum } from '@/lib/supabase/types';

export const metadata = {
  title: 'Imports',
  description: 'Catalog ingestion jobs and their outcomes.',
};

const statusTone: Record<ImportStatusEnum, 'success' | 'info' | 'danger' | 'warning'> = {
  completed: 'success',
  partial: 'warning',
  running: 'warning',
  failed: 'danger',
  pending: 'info',
};

function formatStarted(iso: string): string {
  return new Date(iso).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

/** Imports (Spec Section 10). Rows come from the live `imports` table
 * (catalog.create). The CSV/JSON import wizard arrives with the ingestion
 * phase; today the catalog is populated through the TMDB sync. */
export default async function AdminImportsPage() {
  const jobs = await listImportJobs();

  return (
    <div className="py-6">
      <PageHeader
        title="Imports"
        description="Ingestion jobs recorded in the imports table. The CSV/JSON import wizard arrives with the ingestion phase; the catalog is populated today through the TMDB sync (Catalog → Sync)."
      />

      <section aria-label="Import history">
        <h2 className="mb-3 font-display text-lg font-semibold">Import history</h2>
        {jobs.length === 0 ? (
          <EmptyState
            icon="⇪"
            title="No imports have run yet"
            description="Runs of the TMDB sync and future CSV/JSON imports will be recorded here."
          />
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full border-collapse text-sm">
              <caption className="sr-only">Import jobs with source, status, row counts and errors</caption>
              <thead>
                <tr className="border-b border-border bg-surface/60 text-left text-xs uppercase tracking-wide text-content-subtle">
                  <th scope="col" className="px-3 py-2.5">
                    Source
                  </th>
                  <th scope="col" className="px-3 py-2.5">
                    Status
                  </th>
                  <th scope="col" className="px-3 py-2.5 text-right">
                    Rows
                  </th>
                  <th scope="col" className="px-3 py-2.5 text-right">
                    Processed
                  </th>
                  <th scope="col" className="px-3 py-2.5 text-right">
                    Succeeded
                  </th>
                  <th scope="col" className="px-3 py-2.5 text-right">
                    Failed
                  </th>
                  <th scope="col" className="px-3 py-2.5">
                    Started
                  </th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr key={job.id} className="border-b border-border/60 last:border-0">
                    <th scope="row" className="px-3 py-2.5 text-left font-normal">
                      <span className="block font-mono text-content">{job.source ?? '—'}</span>
                      <span className="block text-xs text-content-subtle">
                        {job.kind}
                        {job.dry_run ? ' · dry run' : ''}
                        {job.created_by ? ` · ${job.created_by}` : ''}
                      </span>
                    </th>
                    <td className="px-3 py-2.5">
                      <Badge tone={statusTone[job.status]}>{job.status}</Badge>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-content-muted">{job.total}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-content-muted">{job.processed}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-content-muted">{job.succeeded}</td>
                    <td className={`px-3 py-2.5 text-right tabular-nums ${job.failed > 0 ? 'text-danger' : 'text-content-muted'}`}>
                      {job.failed}
                    </td>
                    <td className="px-3 py-2.5 text-content-subtle">{formatStarted(job.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
