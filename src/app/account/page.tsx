import type { Metadata } from 'next';
import Link from 'next/link';
import { buttonClasses } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { cn } from '@/lib/cn';
import { getSignedInEmail, listAccountProfiles } from '@/features/account/queries';
import { listWatchlistTitles } from '@/features/watchlist/queries';
import { listWatchHistoryWithTitles } from '@/features/playback/history-queries';
import { greeting } from '@/features/account/types';
import { AdSlot } from '@/features/ads/AdSlot';
import { ConsentGate } from '@/features/ads/ConsentGate';

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

/** Derive a friendly first name from the signed-in email (no stored display name yet). */
function firstNameFromEmail(email: string | null): string {
  if (!email) return 'there';
  const local = email.split('@')[0] ?? email;
  return local.charAt(0).toUpperCase() + local.slice(1);
}

export default async function AccountOverviewPage() {
  const [email, profiles, watchlist, history] = await Promise.all([
    getSignedInEmail(),
    listAccountProfiles(),
    listWatchlistTitles(),
    listWatchHistoryWithTitles(5),
  ]);
  const firstName = firstNameFromEmail(email);

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-1">
        <h2 className="font-display text-xl font-semibold">
          {greeting()}, {firstName}
        </h2>
        <p className="text-sm text-content-muted">
          {email ? `Signed in as ${email}` : 'Manage your profiles and preferences.'}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <StatCard label="Profiles" value={profiles.length} href="/account/profiles" cta="View profiles" />
        <StatCard label="On your watchlist" value={watchlist.length} href="/account/watchlist" cta="View watchlist" />
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
        {history.length > 0 ? (
          <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface/40">
            {history.map(({ entry, title }) =>
              title ? (
                <li key={entry.sessionId}>
                  <Link
                    href={`/title/${title.type}/${title.slug}`}
                    className="flex items-center justify-between gap-4 px-4 py-3 text-sm transition-colors hover:bg-surface-raised/60"
                  >
                    <span className="font-medium text-content">{title.name}</span>
                    <span className="shrink-0 text-xs text-content-muted">
                      {new Date(entry.watchedAt).toLocaleDateString(undefined, {
                        month: 'short',
                        day: 'numeric',
                      })}
                    </span>
                  </Link>
                </li>
              ) : null,
            )}
          </ul>
        ) : (
          <EmptyState
            icon="🕑"
            title="No recent activity"
            description="Titles you watch will appear here. Start browsing to build your history."
            action={
              <Link href="/browse" className={buttonClasses({ variant: 'primary' })}>
                Browse the catalog
              </Link>
            }
          />
        )}
      </section>

      {/* Ad (Spec Section 11): one rectangle below the overview, consent-gated. */}
      <ConsentGate>
        <AdSlot slot="accountRectangle" />
      </ConsentGate>
    </div>
  );
}
