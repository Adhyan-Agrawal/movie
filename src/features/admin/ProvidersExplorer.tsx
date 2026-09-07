'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { listProviderConfigs, type ProviderConfig } from '@/lib/providers/config';
import type { HealthResult, HealthStatus } from '@/lib/providers/types';
import type { SourceHealthEnum } from '@/lib/supabase/types';
import type { AdminProviderRow } from './types';
import { runProviderHealthAction, setProviderEnabledAction } from './provider-actions';

/**
 * Providers explorer (Spec Section 9). Two honest sources:
 *
 *  1. Database providers — real `providers` rows (provider.manage).
 *  2. Built-in providers — configured in application code
 *     (`src/lib/providers/config.ts`). The database row drives enablement, so a
 *     built-in card reflects its row's `enabled` state (falling back to the
 *     code default until the first toggle or health check creates a row).
 *
 * Both surfaces can be toggled on/off and probed with an on-demand health
 * check. Actions are permission-gated server-side (provider.manage) and run as
 * the signed-in admin through the RLS-scoped client.
 */

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-1 py-2 sm:grid-cols-[11rem_1fr] sm:gap-4">
      <dt className="text-xs font-medium uppercase tracking-wide text-content-subtle">{label}</dt>
      <dd className="min-w-0 break-words text-sm text-content">{children}</dd>
    </div>
  );
}

function Chips({ values }: { values: string[] }) {
  return (
    <span className="flex flex-wrap gap-1">
      {values.map((v) => (
        <code key={v} className="rounded-sm border border-border bg-surface-raised/60 px-1.5 py-0.5 font-mono text-xs">
          {v}
        </code>
      ))}
    </span>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
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

function storedHealthTone(health: SourceHealthEnum): 'success' | 'warning' | 'danger' | 'neutral' {
  switch (health) {
    case 'healthy':
      return 'success';
    case 'degraded':
      return 'warning';
    case 'down':
      return 'danger';
    default:
      // 'unknown'
      return 'neutral';
  }
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

/** Enable/disable + on-demand health probe for one provider. */
function ProviderActions({ providerKey, enabled }: { providerKey: string; enabled: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<HealthResult | null>(null);

  function toggle() {
    setError(null);
    startTransition(async () => {
      const res = await setProviderEnabledAction(providerKey, !enabled);
      if (!res.ok) setError(res.error ?? 'Could not update the provider.');
      else router.refresh();
    });
  }

  function runHealth() {
    setError(null);
    startTransition(async () => {
      const res = await runProviderHealthAction(providerKey);
      if (!res.ok) setError(res.error ?? 'Could not run the health check.');
      else if (res.result) setResult(res.result);
    });
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <div className="flex flex-wrap items-center gap-1">
        <Button size="sm" variant="secondary" disabled={pending} onClick={toggle}>
          {enabled ? 'Disable' : 'Enable'}
        </Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={runHealth}>
          {pending ? 'Checking…' : 'Run health check'}
        </Button>
      </div>
      {result ? (
        <span className="flex flex-wrap items-center gap-1 text-xs text-content-muted">
          <Badge tone={healthStatusTone(result.status)}>{result.status}</Badge>
          <span>
            {result.latencyMs != null ? `${result.latencyMs} ms` : 'no latency'} · {formatTime(result.checkedAt)}
          </span>
          {result.detail ? <span>· {result.detail}</span> : null}
        </span>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function BuiltinProviderCard({ config, dbRow }: { config: ProviderConfig; dbRow?: AdminProviderRow }) {
  const enabled = dbRow?.enabled ?? config.enabled;
  return (
    <section
      aria-labelledby={`builtin-${config.id}`}
      className="rounded-lg border border-border bg-surface p-4 md:p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-4">
        <div>
          <h3 id={`builtin-${config.id}`} className="font-display text-lg font-semibold">
            {config.displayName}
          </h3>
          <p className="mt-1 text-xs text-content-subtle">
            Built-in provider — configured in code (src/lib/providers/config.ts). The database row drives enablement:
            the first toggle or health check creates the row.
          </p>
        </div>
        <Badge tone={enabled ? 'success' : 'neutral'}>{enabled ? 'Enabled' : 'Disabled'}</Badge>
      </div>

      <dl className="divide-y divide-border">
        <DetailRow label="Display name">{config.displayName}</DetailRow>
        <DetailRow label="Base URL">
          <code className="font-mono text-sm">{config.baseUrl}</code>
          <span className="ml-2 text-xs text-content-subtle">({hostOf(config.baseUrl)})</span>
        </DetailRow>
        <DetailRow label="Allowed domains">
          <Chips values={config.allowedDomains} />
        </DetailRow>
        <DetailRow label="Movie path">
          <code className="font-mono text-sm">{config.moviePathTemplate}</code>
        </DetailRow>
        <DetailRow label="TV-series path">
          <code className="font-mono text-sm">{config.tvSeriesPathTemplate}</code>
        </DetailRow>
        <DetailRow label="Episode path">
          <code className="font-mono text-sm">{config.episodePathTemplate}</code>
        </DetailRow>
        <DetailRow label="Shorthand episode">
          <code className="font-mono text-sm">{config.shorthandEpisodeTemplate}</code>
        </DetailRow>
        <DetailRow label="Priority">{config.defaultPriority}</DetailRow>
        <DetailRow label="Timeout">{config.timeoutMs} ms</DetailRow>
        <DetailRow label="Regions">
          <Chips values={config.enabledRegions} />
        </DetailRow>
        <DetailRow label="Consent required">
          <Badge tone={config.consentRequired ? 'info' : 'neutral'}>{config.consentRequired ? 'Yes' : 'No'}</Badge>
        </DetailRow>
        <DetailRow label="Test title ID">
          <code className="font-mono text-sm">{config.testTitleId}</code>
        </DetailRow>
      </dl>

      <div className="mt-4 border-t border-border pt-4">
        <ProviderActions providerKey={config.id} enabled={enabled} />
      </div>
    </section>
  );
}

export function ProvidersExplorer({ rows }: { rows: AdminProviderRow[] }) {
  const rowByKey = new Map(rows.map((row) => [row.key, row]));

  return (
    <div className="flex flex-col gap-8">
      {/* Database-configured providers */}
      <section aria-label="Database providers">
        <h2 className="mb-3 font-display text-lg font-semibold">Configured in the database</h2>
        {rows.length === 0 ? (
          <EmptyState
            icon="⧉"
            title="No providers in the database yet"
            description="Provider rows are created the first time a built-in provider is toggled or health-checked below. Playback currently resolves through the built-in providers configured in code."
          />
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full border-collapse text-sm">
              <caption className="sr-only">Provider rows from the providers table</caption>
              <thead>
                <tr className="border-b border-border bg-surface/60 text-left text-xs uppercase tracking-wide text-content-subtle">
                  <th scope="col" className="px-3 py-2.5">
                    Provider
                  </th>
                  <th scope="col" className="px-3 py-2.5">
                    Adapter
                  </th>
                  <th scope="col" className="px-3 py-2.5">
                    Base URL
                  </th>
                  <th scope="col" className="px-3 py-2.5">
                    Enabled
                  </th>
                  <th scope="col" className="px-3 py-2.5">
                    Health
                  </th>
                  <th scope="col" className="px-3 py-2.5 text-right">
                    Priority
                  </th>
                  <th scope="col" className="px-3 py-2.5">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="border-b border-border/60 last:border-0">
                    <th scope="row" className="px-3 py-2.5 text-left align-top font-normal">
                      <span className="block font-medium text-content">{row.name}</span>
                      <span className="block font-mono text-xs text-content-subtle">{row.key}</span>
                    </th>
                    <td className="px-3 py-2.5 font-mono text-xs text-content-muted">{row.adapter}</td>
                    <td className="px-3 py-2.5">
                      <code className="font-mono text-xs text-content-muted">{row.base_url ?? '—'}</code>
                    </td>
                    <td className="px-3 py-2.5">
                      <Badge tone={row.enabled ? 'success' : 'neutral'}>{row.enabled ? 'Enabled' : 'Disabled'}</Badge>
                    </td>
                    <td className="px-3 py-2.5">
                      <Badge tone={storedHealthTone(row.health)}>{row.health}</Badge>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-content-muted">{row.priority}</td>
                    <td className="px-3 py-2.5">
                      <ProviderActions providerKey={row.key} enabled={row.enabled} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Built-in (code-configured) providers */}
      <section aria-label="Built-in providers">
        <h2 className="mb-3 font-display text-lg font-semibold">Built-in providers (configured in code)</h2>
        <div className="flex flex-col gap-4">
          {listProviderConfigs().map((config) => (
            <BuiltinProviderCard key={config.id} config={config} dbRow={rowByKey.get(config.id)} />
          ))}
        </div>
      </section>
    </div>
  );
}
