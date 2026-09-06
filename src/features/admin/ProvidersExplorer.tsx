'use client';

import { useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';
import { ConfirmDialog } from './ConfirmDialog';
import { PROVIDERS, type HealthStatus, type Provider } from './mock';

/**
 * Providers explorer (Section 9). A master list + a read-only details panel
 * exposing the Vidsrc/VSEmbed admin fields (enabled, display name, base URL,
 * allowed domains, path templates, priority, timeout, regions, consent, test
 * title id). "Test playback" is a confirmed affordance that explains it would
 * construct the URL server-side and load the embed only in an isolated preview.
 */

const healthMeta: Record<HealthStatus, { tone: 'success' | 'warning' | 'danger'; icon: string; label: string }> = {
  ok: { tone: 'success', icon: '✓', label: 'Healthy' },
  degraded: { tone: 'warning', icon: '!', label: 'Degraded' },
  down: { tone: 'danger', icon: '✕', label: 'Down' },
};

function HealthBadge({ status }: { status: HealthStatus }) {
  const meta = healthMeta[status];
  return (
    <Badge tone={meta.tone}>
      <span aria-hidden="true">{meta.icon}</span> {meta.label}
    </Badge>
  );
}

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

export function ProvidersExplorer() {
  const [selectedId, setSelectedId] = useState<string>(PROVIDERS[0]?.id ?? '');
  const [testing, setTesting] = useState<Provider | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const selected = PROVIDERS.find((p) => p.id === selectedId) ?? PROVIDERS[0];

  return (
    <div className="grid gap-4 lg:grid-cols-[18rem_1fr]">
      {/* Master list */}
      <ul aria-label="Providers" className="flex flex-col gap-2">
        {PROVIDERS.map((provider) => {
          const active = provider.id === selected?.id;
          return (
            <li key={provider.id}>
              <button
                type="button"
                aria-current={active ? 'true' : undefined}
                onClick={() => setSelectedId(provider.id)}
                className={cn(
                  'w-full rounded-lg border p-3 text-left transition-colors',
                  active
                    ? 'border-border-strong bg-surface-raised'
                    : 'border-border bg-surface hover:border-border-strong hover:bg-surface-raised/50',
                )}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="font-medium text-content">{provider.displayName}</span>
                  <HealthBadge status={provider.health} />
                </span>
                <span className="mt-1 flex items-center gap-2 text-xs text-content-subtle">
                  <span>{provider.enabled ? 'Enabled' : 'Disabled'}</span>
                  <span aria-hidden="true">·</span>
                  <span>priority {provider.priority}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {/* Details panel */}
      {selected ? (
        <section aria-label={`${selected.displayName} configuration`} className="rounded-lg border border-border bg-surface p-4 md:p-5">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-4">
            <div>
              <h2 className="font-display text-lg font-semibold">{selected.displayName}</h2>
              <p className="mt-1 max-w-prose text-sm text-content-muted">{selected.description}</p>
            </div>
            <div className="flex items-center gap-2">
              <Badge tone={selected.enabled ? 'success' : 'neutral'}>{selected.enabled ? 'Enabled' : 'Disabled'}</Badge>
              <Button size="sm" variant="secondary" onClick={() => setTesting(selected)}>
                Test playback
              </Button>
            </div>
          </div>

          <p aria-live="polite" className="min-h-4 pt-2 text-xs text-content-muted">
            {status}
          </p>

          <dl className="divide-y divide-border">
            <DetailRow label="Display name">{selected.displayName}</DetailRow>
            <DetailRow label="Health">
              <span className="flex items-center gap-2">
                <HealthBadge status={selected.health} />
                <span className="text-xs text-content-subtle">
                  checked {new Date(selected.lastChecked).toISOString().slice(11, 16)} UTC
                </span>
              </span>
            </DetailRow>
            <DetailRow label="Base URL">
              <code className="font-mono text-sm">{selected.baseUrl}</code>
            </DetailRow>
            <DetailRow label="Allowed domains">
              <Chips values={selected.allowedDomains} />
            </DetailRow>
            {selected.moviePathTemplate ? (
              <DetailRow label="Movie path">
                <code className="font-mono text-sm">{selected.moviePathTemplate}</code>
              </DetailRow>
            ) : null}
            {selected.tvPathTemplate ? (
              <DetailRow label="TV-series path">
                <code className="font-mono text-sm">{selected.tvPathTemplate}</code>
              </DetailRow>
            ) : null}
            {selected.episodePathTemplate ? (
              <DetailRow label="Episode path">
                <code className="font-mono text-sm">{selected.episodePathTemplate}</code>
              </DetailRow>
            ) : null}
            {selected.shorthandEpisodeTemplate ? (
              <DetailRow label="Shorthand episode">
                <code className="font-mono text-sm">{selected.shorthandEpisodeTemplate}</code>
              </DetailRow>
            ) : null}
            <DetailRow label="Priority">{selected.priority}</DetailRow>
            <DetailRow label="Timeout">{selected.timeoutMs} ms</DetailRow>
            <DetailRow label="Regions">
              <Chips values={selected.regions} />
            </DetailRow>
            <DetailRow label="Consent required">
              <Badge tone={selected.consentRequired ? 'info' : 'neutral'}>
                {selected.consentRequired ? 'Yes' : 'No'}
              </Badge>
            </DetailRow>
            <DetailRow label="Test title ID">
              <code className="font-mono text-sm">{selected.testTitleId}</code>
            </DetailRow>
          </dl>
        </section>
      ) : null}

      <ConfirmDialog
        open={testing !== null}
        title={`Test playback for ${testing?.displayName ?? ''}?`}
        description={
          <>
            This would construct the player URL server-side from the configured templates and{' '}
            <strong>test title ID {testing?.testTitleId}</strong>, validate it against the allowed domains, then load
            the embed only in an isolated, sandboxed preview surface. No catalog or provider settings are changed.
          </>
        }
        confirmLabel="Run test"
        onCancel={() => setTesting(null)}
        onConfirm={() => {
          if (testing) {
            setStatus(
              `Preview: URL construction for ${testing.displayName} validated against ${testing.allowedDomains.join(', ')} (embed not loaded in this mock).`,
            );
          }
          setTesting(null);
        }}
      />
    </div>
  );
}
