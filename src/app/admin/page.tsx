import Link from 'next/link';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button, buttonClasses } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { StatTile } from '@/features/admin/StatTile';
import { BarChart, RankedBarList } from '@/features/admin/Charts';
import { HealthGrid } from '@/features/admin/HealthGrid';
import { AuditTimeline } from '@/features/admin/AuditTimeline';
import {
  AUDIT_EVENTS,
  HEALTH_SERVICES,
  KPI_METRICS,
  PROVIDERS,
  REPORTING_TIMEZONE,
  TOP_TITLES,
  VIEWS_BY_DAY,
  type HealthStatus,
} from '@/features/admin/mock';

export const metadata = {
  title: 'Dashboard',
  description: 'Operations overview: usage, playback, provider and system health.',
};

const providerHealthTone: Record<HealthStatus, { tone: 'success' | 'warning' | 'danger'; icon: string; label: string }> = {
  ok: { tone: 'success', icon: '✓', label: 'Healthy' },
  degraded: { tone: 'warning', icon: '!', label: 'Degraded' },
  down: { tone: 'danger', icon: '✕', label: 'Down' },
};

function SectionHeading({ title, href, linkLabel }: { title: string; href?: string; linkLabel?: string }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-2">
      <h2 className="font-display text-lg font-semibold">{title}</h2>
      {href && linkLabel ? (
        <Link href={href} className="text-sm text-primary hover:text-primary-hover">
          {linkLabel}
        </Link>
      ) : null}
    </div>
  );
}

export default function AdminDashboardPage() {
  const recentAudit = AUDIT_EVENTS.slice(0, 4);

  return (
    <div className="flex flex-col gap-8 py-6">
      <PageHeader
        title="Dashboard"
        description="Operations at a glance. Figures cover the current window and are de-duplicated where noted."
        actions={
          <div className="flex items-center gap-2">
            <Badge tone="neutral">Times in {REPORTING_TIMEZONE}</Badge>
            <Button variant="secondary" size="sm">
              Export
            </Button>
          </div>
        }
      />

      {/* KPI grid */}
      <section aria-label="Key metrics">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {KPI_METRICS.map((metric) => (
            <StatTile
              key={metric.id}
              label={metric.label}
              value={metric.value}
              deltaPct={metric.deltaPct}
              goodDirection={metric.goodDirection}
              comparison={metric.comparison}
              spark={metric.spark}
              definition={metric.definition}
            />
          ))}
        </div>
      </section>

      {/* Trends + top titles */}
      <section aria-label="Trends" className="grid gap-4 lg:grid-cols-3">
        <div className="rounded-lg border border-border bg-surface p-4 lg:col-span-2">
          <SectionHeading title="Views — last 14 days" />
          <BarChart data={VIEWS_BY_DAY} caption="Daily views over the last 14 days" unit="" />
          <p className="mt-2 text-xs text-content-subtle">
            Daily title-open events, de-duplicated per profile per hour. All days shown in {REPORTING_TIMEZONE}.
          </p>
        </div>
        <div className="rounded-lg border border-border bg-surface p-4">
          <SectionHeading title="Top titles" href="/admin/catalog/titles" linkLabel="Catalog" />
          <RankedBarList
            items={TOP_TITLES.map((t) => ({ id: t.id, label: t.name, value: t.views, meta: t.type.toUpperCase() }))}
            caption="Top titles by views this week"
            valueLabel="Views"
          />
        </div>
      </section>

      {/* Provider health */}
      <section aria-label="Provider health">
        <SectionHeading title="Provider health" href="/admin/providers" linkLabel="Manage providers" />
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {PROVIDERS.map((provider) => {
            const meta = providerHealthTone[provider.health];
            return (
              <li key={provider.id} className="flex items-center justify-between gap-2 rounded-lg border border-border bg-surface p-4">
                <div>
                  <p className="text-sm font-medium text-content">{provider.displayName}</p>
                  <p className="text-xs text-content-subtle">
                    {provider.enabled ? 'Enabled' : 'Disabled'} · priority {provider.priority}
                  </p>
                </div>
                <Badge tone={meta.tone}>
                  <span aria-hidden="true">{meta.icon}</span> {meta.label}
                </Badge>
              </li>
            );
          })}
        </ul>
      </section>

      {/* System health */}
      <section aria-label="System health">
        <SectionHeading title="System health" href="/admin/health" linkLabel="Health detail" />
        <HealthGrid services={HEALTH_SERVICES} />
      </section>

      {/* Recent audit */}
      <section aria-label="Recent activity">
        <SectionHeading title="Recent activity" href="/admin/audit" linkLabel="Full audit log" />
        <div className="rounded-lg border border-border bg-surface p-4 md:p-5">
          <AuditTimeline events={recentAudit} />
          <div className="mt-2">
            <Link href="/admin/audit" className={buttonClasses({ variant: 'secondary', size: 'sm' })}>
              View all events
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
