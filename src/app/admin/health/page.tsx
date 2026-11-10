import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/ui/PageHeader';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { GET as getHealthResponse } from '@/app/api/health/route';
import { getAdapter, getActiveProviderConfigs, refreshProviderRegistry } from '@/lib/providers/registry';
import { hasPermission } from '@/lib/permissions/check';
import { PERMISSIONS } from '@/lib/permissions/permissions';
import type { HealthResult, HealthStatus } from '@/lib/providers/types';
import { listPlaybackReports, type AdminPlaybackReport } from '@/features/admin/queries';

export const metadata = {
  title: 'Health',
  description: 'Service and provider health checks.',
};

/** The endpoint reports live status on every request — never cache this page. */
export const dynamic = 'force-dynamic';

interface HealthApiPayload {
  data: {
    status: string;
    checks?: Record<string, string>;
    time?: string;
  };
  error: unknown;
  requestId: string;
}

function statusTone(status: string): 'success' | 'warning' | 'neutral' {
  if (status === 'ok') return 'success';
  if (status === 'unconfigured') return 'warning';
  return 'neutral';
}

function healthStatusTone(status: HealthStatus): 'success' | 'warning' | 'danger' | 'neutral' {
  switch (status) {
    case 'healthy':
      return 'success';
    case 'degraded':
      return 'warning';
    case 'unavailable':
      return 'danger';
    default:
      // 'disabled' | 'unknown'
      return 'neutral';
  }
}

/**
 * Health (Spec Sections 14/15). The live service state comes from the real
 * GET /api/health handler in the current request context, and provider status comes
 * from an on-demand probe of each configured adapter (HEAD to its base origin
 * with its configured timeout). Every number here is a real measurement —
 * nothing is fabricated.
 */
export default async function AdminHealthPage() {
  if (!(await hasPermission(PERMISSIONS.HEALTH_READ))) notFound();
  let endpoint: HealthApiPayload | null = null;
  let endpointError: string | null = null;
  try {
    const res = await getHealthResponse();
    if (!res.ok) throw new Error(`Health endpoint returned HTTP ${res.status}.`);
    endpoint = (await res.json()) as HealthApiPayload;
  } catch {
    endpointError = 'The protected service-status check did not complete.';
  }

  await refreshProviderRegistry(false);
  const providerChecks = (
    await Promise.all(
      getActiveProviderConfigs().map(async (config) => {
        const adapter = getAdapter(config.id);
        if (!adapter) return null;
        try {
          return await adapter.healthCheck();
        } catch {
          return {
            providerId: config.id,
            status: 'unknown' as const,
            checkedAt: new Date().toISOString(),
            detail: 'Health check failed.',
          } satisfies HealthResult;
        }
      }),
    )
  ).filter((result): result is HealthResult => result !== null);

  // Viewer "Report playback issue" submissions (migration 0008) — the human
  // side of provider health: which servers actually fail for real viewers.
  let reports: AdminPlaybackReport[] = [];
  try {
    reports = await listPlaybackReports(15);
  } catch (err) {
    console.warn('admin.health: playback reports read failed', {
      message: err instanceof Error ? err.message : String(err),
    });
  }

  return (
    <div className="py-6">
      <PageHeader
        title="Health"
        description="Application liveness and configured services, plus on-demand playback-provider reachability probes."
      />

      <section aria-label="Service health" className="flex flex-col gap-3">
        <h2 className="font-display text-lg font-semibold">Service health</h2>

        {endpointError ? (
          <EmptyState
            tone="danger"
            icon="!"
            title="Service status unavailable"
            description={`${endpointError} The page still rendered, so the app itself is up.`}
          />
        ) : endpoint ? (
          <>
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full border-collapse text-sm">
                <caption className="sr-only">Service health as reported by GET /api/health</caption>
                <thead>
                  <tr className="border-b border-border bg-surface/60 text-left text-xs uppercase tracking-wide text-content-subtle">
                    <th scope="col" className="px-3 py-2.5">
                      Component
                    </th>
                    <th scope="col" className="px-3 py-2.5">
                      Status
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-b border-border/60">
                    <th scope="row" className="px-3 py-2.5 text-left font-normal">
                      <span className="font-medium text-content">Application</span>
                      <span className="block font-mono text-xs text-content-subtle">{endpoint.requestId}</span>
                    </th>
                    <td className="px-3 py-2.5">
                      <Badge tone={statusTone(endpoint.data.status)}>{endpoint.data.status}</Badge>
                    </td>
                  </tr>
                  {endpoint.data.checks
                    ? Object.entries(endpoint.data.checks).map(([component, status]) => (
                        <tr key={component} className="border-b border-border/60 last:border-0">
                          <th scope="row" className="px-3 py-2.5 text-left font-normal">
                            <code className="font-mono text-content">{component}</code>
                          </th>
                          <td className="px-3 py-2.5">
                              <Badge tone={statusTone(status)}>{component !== 'app' && status === 'ok' ? 'configured' : status}</Badge>
                          </td>
                        </tr>
                      ))
                    : null}
                </tbody>
              </table>
              {endpoint.data.time ? (
                <p className="border-t border-border px-3 py-2 text-xs text-content-subtle">
                  Reported at {new Date(endpoint.data.time).toLocaleString()} · request {endpoint.requestId}
                </p>
              ) : null}
            </div>

            <details className="text-sm">
              <summary className="cursor-pointer text-xs text-content-subtle hover:text-content">
                Raw /api/health payload
              </summary>
              <pre className="mt-2 overflow-x-auto rounded-md border border-border bg-surface-raised/60 p-3 font-mono text-xs leading-relaxed text-content-muted">
                {JSON.stringify(endpoint, null, 2)}
              </pre>
            </details>

            <p className="text-xs text-content-subtle">
              The same protected handler serves GET /api/health. Configured services are not a guarantee of valid credentials or connectivity.
            </p>
          </>
        ) : null}
      </section>

      <section aria-label="Playback provider health" className="mt-8 flex flex-col gap-3">
        <h2 className="font-display text-lg font-semibold">Playback providers</h2>

        {providerChecks.length === 0 ? (
          <EmptyState
            title="No playback providers configured"
            description="Add a provider in /admin/providers to see live probes here."
          />
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full border-collapse text-sm">
              <caption className="sr-only">Live playback-provider health probes</caption>
              <thead>
                <tr className="border-b border-border bg-surface/60 text-left text-xs uppercase tracking-wide text-content-subtle">
                  <th scope="col" className="px-3 py-2.5">
                    Provider
                  </th>
                  <th scope="col" className="px-3 py-2.5">
                    Status
                  </th>
                  <th scope="col" className="px-3 py-2.5">
                    Latency
                  </th>
                  <th scope="col" className="px-3 py-2.5">
                    Checked at
                  </th>
                </tr>
              </thead>
              <tbody>
                {providerChecks.map((result) => (
                  <tr key={result.providerId} className="border-b border-border/60 last:border-0">
                    <th scope="row" className="px-3 py-2.5 text-left font-normal">
                      <code className="font-mono text-content">{result.providerId}</code>
                    </th>
                    <td className="px-3 py-2.5">
                      <Badge tone={healthStatusTone(result.status)}>{result.status}</Badge>
                    </td>
                    <td className="px-3 py-2.5 tabular-nums text-content-muted">
                      {result.latencyMs != null ? `${result.latencyMs} ms` : '—'}
                    </td>
                    <td className="px-3 py-2.5 text-content-subtle">
                      {new Date(result.checkedAt).toLocaleString()}
                      {result.detail ? <span className="block text-xs">{result.detail}</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-xs text-content-subtle">
          Probes run server-side on page load — a HEAD request to each provider&apos;s base origin with its configured
          timeout. Reachability is not proof of working video playback.
        </p>
      </section>

      <section aria-label="Viewer playback reports" className="mt-8 flex flex-col gap-3">
        <h2 className="font-display text-lg font-semibold">Viewer playback reports</h2>

        {reports.length === 0 ? (
          <EmptyState
            icon="✓"
            title="No reports yet"
            description="When a viewer taps “Report playback issue” on a broken server, it lands here so you can see exactly which server failed and for which title."
          />
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full border-collapse text-sm">
              <caption className="sr-only">Viewer-reported playback issues</caption>
              <thead>
                <tr className="border-b border-border bg-surface/60 text-left text-xs uppercase tracking-wide text-content-subtle">
                  <th scope="col" className="px-3 py-2.5">
                    Title
                  </th>
                  <th scope="col" className="px-3 py-2.5">
                    Server
                  </th>
                  <th scope="col" className="px-3 py-2.5">
                    Player state
                  </th>
                  <th scope="col" className="px-3 py-2.5">
                    Reported
                  </th>
                </tr>
              </thead>
              <tbody>
                {reports.map((report) => (
                  <tr key={report.id} className="border-b border-border/60 last:border-0 align-top">
                    <th scope="row" className="px-3 py-2.5 text-left font-normal">
                      <span className="font-medium text-content">{report.titleName ?? 'Unknown title'}</span>
                      {report.message ? (
                        <span className="block max-w-md truncate text-xs text-content-subtle" title={report.message}>
                          {report.message}
                        </span>
                      ) : null}
                    </th>
                    <td className="px-3 py-2.5">
                      <Badge tone={report.serverLabel ? 'warning' : 'neutral'}>{report.serverLabel ?? '—'}</Badge>
                    </td>
                    <td className="px-3 py-2.5">
                      <code className="font-mono text-xs text-content-muted">{report.playerState ?? '—'}</code>
                    </td>
                    <td className="px-3 py-2.5 text-xs text-content-subtle">
                      {new Date(report.createdAt).toLocaleString()}
                    </td>
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
