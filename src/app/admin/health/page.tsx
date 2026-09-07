import { headers } from 'next/headers';
import { PageHeader } from '@/components/ui/PageHeader';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { publicEnv } from '@/lib/env';
import { getAdapter } from '@/lib/providers/registry';
import { listProviderConfigs } from '@/lib/providers/config';
import type { HealthResult, HealthStatus } from '@/lib/providers/types';

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

/** Resolve the self-URL for GET /api/health from the incoming request headers. */
async function healthEndpointUrl(): Promise<URL> {
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host');
  const protocol = h.get('x-forwarded-proto') ?? 'http';
  const base = host ? `${protocol}://${host}` : publicEnv.NEXT_PUBLIC_APP_URL;
  return new URL('/api/health', base);
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
 * GET /api/health endpoint (fetched server-side as the signed-in admin, so the
 * health.read-gated detail is included), and playback-provider status comes
 * from an on-demand probe of each configured adapter (HEAD to its base origin
 * with its configured timeout). Every number here is a real measurement —
 * nothing is fabricated.
 */
export default async function AdminHealthPage() {
  let endpoint: HealthApiPayload | null = null;
  let endpointError: string | null = null;
  try {
    const res = await fetch(await healthEndpointUrl(), { cache: 'no-store' });
    if (!res.ok) throw new Error(`Health endpoint returned HTTP ${res.status}.`);
    endpoint = (await res.json()) as HealthApiPayload;
  } catch (err) {
    endpointError = err instanceof Error ? err.message : String(err);
  }

  const providerChecks = (
    await Promise.all(
      listProviderConfigs().map(async (config) => {
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

  return (
    <div className="py-6">
      <PageHeader
        title="Health"
        description="Live service status as reported by /api/health, plus on-demand playback-provider probes."
      />

      <section aria-label="Service health" className="flex flex-col gap-3">
        <h2 className="font-display text-lg font-semibold">Service health</h2>

        {endpointError ? (
          <EmptyState
            tone="danger"
            icon="!"
            title="Health endpoint unreachable"
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
                            <Badge tone={statusTone(status)}>{status}</Badge>
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
              The machine-readable endpoint is GET /api/health; the detailed dependency payload requires health.read.
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
          timeout.
        </p>
      </section>
    </div>
  );
}
