import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { listProviderConfigs, type ProviderConfig } from '@/lib/providers/config';
import type { AdminProviderRow } from './types';

/**
 * Providers explorer (Spec Section 9). Two honest sources:
 *
 *  1. Database providers — real `providers` rows (provider.manage). Rendered
 *     read-only; rows appear as they are configured in the database.
 *  2. Built-in providers — configured in application code
 *     (`src/lib/providers/config.ts`), NOT the database. Clearly labeled as
 *     such and read-only; editing arrives with the provider-management phase.
 *
 * No health statuses are shown — live provider probing arrives with the
 * monitoring phase, and nothing here fabricates it.
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

function BuiltinProviderCard({ config }: { config: ProviderConfig }) {
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
            Built-in provider — configured in code (src/lib/providers/config.ts), not the database. Read-only here;
            editing arrives with the provider-management phase.
          </p>
        </div>
        <Badge tone={config.enabled ? 'success' : 'neutral'}>{config.enabled ? 'Enabled' : 'Disabled'}</Badge>
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
    </section>
  );
}

export function ProvidersExplorer({ rows }: { rows: AdminProviderRow[] }) {
  return (
    <div className="flex flex-col gap-8">
      {/* Database-configured providers */}
      <section aria-label="Database providers">
        <h2 className="mb-3 font-display text-lg font-semibold">Configured in the database</h2>
        {rows.length === 0 ? (
          <EmptyState
            icon="⧉"
            title="No providers in the database yet"
            description="Provider rows created through the provider-management phase will appear here. Playback currently resolves through the built-in provider configured in code."
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
                  <th scope="col" className="px-3 py-2.5 text-right">
                    Priority
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="border-b border-border/60 last:border-0">
                    <th scope="row" className="px-3 py-2.5 text-left font-normal">
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
                    <td className="px-3 py-2.5 text-right tabular-nums text-content-muted">{row.priority}</td>
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
            <BuiltinProviderCard key={config.id} config={config} />
          ))}
        </div>
      </section>
    </div>
  );
}
