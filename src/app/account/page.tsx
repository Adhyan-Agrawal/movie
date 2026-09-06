import type { Metadata } from 'next';
import Link from 'next/link';
import { buttonClasses } from '@/components/ui/Button';
import { cn } from '@/lib/cn';
import { getTitleById } from '@/features/catalog/queries';
import {
  formatDate,
  formatRelativeTime,
  greeting,
  MOCK_ACCOUNT,
  MOCK_DEVICE_SESSIONS,
  MOCK_HISTORY,
  MOCK_PROFILES,
  MOCK_WATCHLIST_IDS,
} from '@/features/account/mock';

export const metadata: Metadata = { title: 'Overview' };

function StatCard({ label, value, href, cta }: { label: string; value: number; href: string; cta: string }) {
  return (
    <Link
      href={href}
      className={cn(
        'flex flex-col gap-1 rounded-lg border border-border bg-surface/40 p-5',
        'transition-colors hover:border-border-strong',
      )}
    >
      <span className="font-display text-3xl font-bold">{value}</span>
      <span className="text-sm text-content-muted">{label}</span>
      <span className="mt-2 text-xs text-primary">{cta} →</span>
    </Link>
  );
}

export default async function AccountOverviewPage() {
  const firstName = MOCK_ACCOUNT.displayName.split(' ')[0] ?? MOCK_ACCOUNT.displayName;
  const recent = await Promise.all(
    MOCK_HISTORY.slice(0, 3).map(async (entry) => ({ entry, title: await getTitleById(entry.titleId) })),
  );

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-1">
        <h2 className="font-display text-xl font-semibold">
          {greeting()}, {firstName}
        </h2>
        <p className="text-sm text-content-muted">
          Member since {formatDate(MOCK_ACCOUNT.memberSince)} · {MOCK_ACCOUNT.plan}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard label="Profiles" value={MOCK_PROFILES.length} href="/account/profiles" cta="Manage profiles" />
        <StatCard
          label="On your watchlist"
          value={MOCK_WATCHLIST_IDS.length}
          href="/account/watchlist"
          cta="View watchlist"
        />
        <StatCard
          label="Signed-in devices"
          value={MOCK_DEVICE_SESSIONS.length}
          href="/account/devices"
          cta="Manage devices"
        />
      </div>

      <section aria-labelledby="recent-heading" className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h3 id="recent-heading" className="text-lg font-semibold">
            Recent activity
          </h3>
          <Link href="/account/history" className="text-sm text-primary hover:underline">
            View all
          </Link>
        </div>
        <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface/40">
          {recent.map(({ entry, title }) => (
            <li key={entry.id} className="flex items-center gap-4 p-4">
              <div
                className="aspect-[2/3] w-10 shrink-0 overflow-hidden rounded-md border border-border bg-surface-raised"
                style={
                  title?.posterUrl?.startsWith('linear-gradient') ? { backgroundImage: title.posterUrl } : undefined
                }
                aria-hidden="true"
              />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium">{title?.name ?? 'Unknown title'}</span>
                <span className="text-xs text-content-muted">
                  Watched {formatRelativeTime(entry.watchedAt)}
                  {entry.progress >= 1 ? ' · Finished' : ` · ${Math.round(entry.progress * 100)}%`}
                </span>
              </div>
              {title ? (
                <Link
                  href={`/title/${title.type}/${title.slug}`}
                  className={buttonClasses({ variant: 'ghost', size: 'sm' })}
                >
                  Open
                </Link>
              ) : null}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
