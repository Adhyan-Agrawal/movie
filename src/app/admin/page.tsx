import Link from 'next/link';
import { PageHeader } from '@/components/ui/PageHeader';
import { buttonClasses } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { StatTile } from '@/features/admin/StatTile';
import { AuditTimeline } from '@/features/admin/AuditTimeline';
import { getAdminCounts, listAuditEvents } from '@/features/admin/queries';

export const metadata = {
  title: 'Dashboard',
  description: 'Live catalog, user, and playback totals from the database.',
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

/** Dashboard (Spec Section 10). Every figure is a live count from Postgres,
 * read through the RLS-scoped server client — no estimates, no deltas, no
 * fabricated trend data. Trend charts and per-window comparisons arrive with
 * the reporting/analytics phase. */
export default async function AdminDashboardPage() {
  const [counts, recentAudit] = await Promise.all([getAdminCounts(), listAuditEvents(4)]);

  const tiles = [
    {
      id: 'titles-total',
      label: 'Titles (total)',
      value: counts.titlesTotal.toLocaleString(),
      definition: 'All rows in the titles table visible to your catalog.read permission, including drafts.',
    },
    {
      id: 'titles-published',
      label: 'Titles (published)',
      value: counts.titlesPublished.toLocaleString(),
      definition: 'Titles with status = published.',
    },
    {
      id: 'accounts',
      label: 'Accounts',
      value: counts.accounts.toLocaleString(),
      definition: 'Rows in the accounts table.',
    },
    {
      id: 'profiles',
      label: 'Profiles',
      value: counts.profiles.toLocaleString(),
      definition: 'Viewing profiles across all accounts.',
    },
    {
      id: 'playback-sessions',
      label: 'Playback sessions',
      value: counts.playbackSessions.toLocaleString(),
      definition: 'Rows in the playback_sessions table (all time).',
    },
  ];

  return (
    <div className="flex flex-col gap-8 py-6">
      <PageHeader
        title="Dashboard"
        description="Live totals from the production database. Usage trends and windowed comparisons arrive with the reporting phase."
      />

      {/* KPI grid — live counts */}
      <section aria-label="Key metrics">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          {tiles.map((tile) => (
            <StatTile key={tile.id} label={tile.label} value={tile.value} definition={tile.definition} />
          ))}
        </div>
      </section>

      {/* Recent audit */}
      <section aria-label="Recent activity">
        <SectionHeading title="Recent activity" href="/admin/audit" linkLabel="Full audit log" />
        <div className="rounded-lg border border-border bg-surface p-4 md:p-5">
          {recentAudit.length > 0 ? (
            <>
              <AuditTimeline events={recentAudit} />
              <div className="mt-2">
                <Link href="/admin/audit" className={buttonClasses({ variant: 'secondary', size: 'sm' })}>
                  View all events
                </Link>
              </div>
            </>
          ) : (
            <EmptyState
              title="No audit events recorded yet"
              description="Actions taken through the admin console will appear here."
            />
          )}
        </div>
      </section>
    </div>
  );
}
