import { PageHeader } from '@/components/ui/PageHeader';
import { EmptyState } from '@/components/ui/EmptyState';
import { Badge } from '@/components/ui/Badge';
import { features } from '@/lib/env';

export const metadata = {
  title: 'Health',
  description: 'Service and provider health checks.',
};

/**
 * Health (Spec Sections 14/15). Only REAL facts are shown: whether the app is
 * serving (it rendered this page) and whether Supabase/TMDB are configured —
 * the same dependency set the /api/health endpoint reports. Live probing,
 * latency, and per-component status arrive with the monitoring phase; nothing
 * here fabricates check results.
 */
export default function AdminHealthPage() {
  const dependencies = [
    {
      id: 'app',
      label: 'Application',
      configured: true,
      detail: 'Serving — this page was rendered by the live server.',
    },
    {
      id: 'supabase',
      label: 'Supabase',
      configured: features.supabaseConfigured,
      detail: features.supabaseConfigured
        ? 'Configured — the console reads live data through the RLS-scoped client.'
        : 'Not configured — set the Supabase environment variables.',
    },
    {
      id: 'tmdb',
      label: 'TMDB',
      configured: features.tmdbConfigured,
      detail: features.tmdbConfigured
        ? 'Configured — catalog sync can reach the TMDB API.'
        : 'Not configured — set TMDB_API_KEY to enable catalog sync.',
    },
  ];

  return (
    <div className="py-6">
      <PageHeader
        title="Health"
        description="Dependency configuration as reported by /api/health. Continuous probes, latency, and per-component status arrive with the monitoring phase."
      />

      <section aria-label="Dependency configuration">
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {dependencies.map((dep) => (
            <li key={dep.id} className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 shadow-soft">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-content">{dep.label}</h2>
                <Badge tone={dep.configured ? 'success' : 'warning'}>{dep.configured ? 'Configured' : 'Unconfigured'}</Badge>
              </div>
              <p className="text-xs text-content-muted">{dep.detail}</p>
            </li>
          ))}
        </ul>
      </section>

      <section aria-label="Live checks" className="mt-8">
        <EmptyState
          icon="✚"
          title="Live health checks arrive with the monitoring phase"
          description="Scheduled probes of the database, auth, storage, TMDB, and playback providers — with latency, history, and alerting — will be reported here. The machine-readable endpoint is GET /api/health (detailed checks require health.read)."
        />
      </section>
    </div>
  );
}
