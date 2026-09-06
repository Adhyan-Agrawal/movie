import { PageHeader } from '@/components/ui/PageHeader';
import { Badge } from '@/components/ui/Badge';
import { ImportWizard } from '@/features/admin/ImportWizard';
import { IMPORT_JOBS, type ImportJob } from '@/features/admin/mock';

export const metadata = {
  title: 'Imports',
  description: 'CSV / JSON ingestion with mapping and dry run.',
};

const statusTone: Record<ImportJob['status'], 'success' | 'info' | 'danger' | 'warning'> = {
  completed: 'success',
  'dry-run': 'info',
  failed: 'danger',
  running: 'warning',
};

function formatStarted(iso: string): string {
  return new Date(iso).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

export default function AdminImportsPage() {
  return (
    <div className="py-6">
      <PageHeader
        title="Imports"
        description="Upload CSV or JSON, map fields, and validate with a required dry run before publish. Idempotent and resumable (Section 10)."
      />

      <section aria-label="New import" className="rounded-lg border border-border bg-surface p-4 md:p-5">
        <ImportWizard />
      </section>

      <section aria-label="Recent imports" className="mt-8">
        <h2 className="mb-3 font-display text-lg font-semibold">Recent imports</h2>
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">Recent import jobs with source, status, row counts and errors</caption>
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
                  Created
                </th>
                <th scope="col" className="px-3 py-2.5 text-right">
                  Updated
                </th>
                <th scope="col" className="px-3 py-2.5 text-right">
                  Errors
                </th>
                <th scope="col" className="px-3 py-2.5">
                  Started
                </th>
              </tr>
            </thead>
            <tbody>
              {IMPORT_JOBS.map((job) => (
                <tr key={job.id} className="border-b border-border/60 last:border-0">
                  <th scope="row" className="px-3 py-2.5 text-left font-normal">
                    <span className="block font-mono text-content">{job.source}</span>
                    <span className="block text-xs text-content-subtle">
                      {job.kind} · {job.actor}
                    </span>
                  </th>
                  <td className="px-3 py-2.5">
                    <Badge tone={statusTone[job.status]}>{job.status}</Badge>
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-content-muted">{job.rows}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-content-muted">{job.created}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-content-muted">{job.updated}</td>
                  <td className={`px-3 py-2.5 text-right tabular-nums ${job.errors > 0 ? 'text-danger' : 'text-content-muted'}`}>
                    {job.errors}
                  </td>
                  <td className="px-3 py-2.5 text-content-subtle">{formatStarted(job.startedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
