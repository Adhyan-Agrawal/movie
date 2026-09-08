import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Container } from '@/components/ui/Container';
import { EmptyState } from '@/components/ui/EmptyState';
import { buttonClasses } from '@/components/ui/Button';
import { MediaCard } from '@/features/catalog/components/MediaCard';
import { truncate } from '@/features/catalog/components/title-detail-helpers';
import { getPerson, getPersonCredits } from '@/features/people/queries';
import type { PersonCredit } from '@/features/people/types';
import type { Title } from '@/features/catalog/types';
import { publicEnv } from '@/lib/env';

/**
 * Person profile route (actor/director pages).
 *
 * Indexable (Spec Section 16): unlike search/watch, person pages are public,
 * stable destinations with real content, so robots default to index/follow and
 * generateMetadata supplies basic Open Graph. RLS scoping happens in the query
 * layer — getPersonCredits reads through the anon client, so it returns only
 * credits whose titles are published/public.
 */

/** Cheap UUID shape check — mirrors the repository guard. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRemoteUrl(url: string | null | undefined): url is string {
  return Boolean(url && (url.startsWith('https://') || url.startsWith('http://')));
}

type PersonParams = { params: Promise<{ id: string }> };

function canonicalUrl(id: string): string {
  return new URL(`/person/${id}`, publicEnv.NEXT_PUBLIC_APP_URL).toString();
}

export async function generateMetadata({ params }: PersonParams): Promise<Metadata> {
  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return { title: 'Person not found', robots: { index: false, follow: false } };
  }

  const person = await getPerson(id);
  if (!person) {
    return { title: 'Person not found', robots: { index: false, follow: false } };
  }

  const description = person.knownFor
    ? truncate(`${person.name} is known for ${person.knownFor}. Browse their movies and shows on Lumora.`, 160)
    : `Browse ${person.name}'s movies and shows on Lumora.`;
  const url = canonicalUrl(id);

  return {
    // Indexable on purpose — no `robots: { index: false }`.
    title: person.name,
    description,
    alternates: { canonical: url },
    openGraph: {
      title: person.name,
      description,
      url,
      siteName: publicEnv.NEXT_PUBLIC_APP_NAME,
      type: 'profile',
      ...(person.profileUrl ? { images: [person.profileUrl] } : {}),
    },
    twitter: {
      card: 'summary',
      title: person.name,
      description,
    },
  };
}

export default async function PersonPage({ params }: PersonParams) {
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();

  const person = await getPerson(id);
  if (!person) notFound();

  const credits = await getPersonCredits(id);
  const acting = credits.filter((c) => c.creditType === 'cast').sort(byRecency);
  const crew = credits.filter((c) => c.creditType === 'crew').sort(byRecency);
  const knownFor = topKnownFor(credits);

  return (
    <Container>
      {/* Profile header: photo + name + "known for" blurb. */}
      <header className="flex flex-col gap-6 py-8 md:flex-row md:items-start md:gap-8">
        <div className="shrink-0">
          {isRemoteUrl(person.profileUrl) ? (
            <Image
              src={person.profileUrl}
              alt={`Photo of ${person.name}`}
              width={160}
              height={240}
              sizes="(max-width: 640px) 128px, 160px"
              className="aspect-[2/3] w-32 rounded-lg border border-border object-cover shadow-raised md:w-40"
            />
          ) : (
            <div
              role="img"
              aria-label={`Photo of ${person.name}`}
              className="grid aspect-[2/3] w-32 place-items-center rounded-lg border border-border bg-surface-raised text-4xl text-content-subtle md:w-40"
            >
              ◎
            </div>
          )}
        </div>

        <div className="flex max-w-2xl flex-col gap-2 pt-1">
          <h1 className="font-display text-3xl font-bold tracking-tight md:text-5xl">{person.name}</h1>
          {person.knownFor ? <p className="text-sm text-content-muted">Known for {person.knownFor}</p> : null}
          <p className="mt-1 text-sm text-content-muted">
            {credits.length} {credits.length === 1 ? 'title credit' : 'title credits'} in the Lumora catalog
          </p>
        </div>
      </header>

      {/* Known for: the person's highest-editorial-score titles, as MediaCards. */}
      {knownFor.length > 0 ? (
        <section aria-labelledby="known-for-heading" className="flex flex-col gap-4 py-4">
          <h2 id="known-for-heading" className="text-lg font-semibold tracking-tight">
            Known for
          </h2>
          <ul className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
            {knownFor.map((title) => (
              <li key={title.id}>
                <MediaCard title={title} className="w-full sm:w-full md:w-full" />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* Credits grouped by credit_type (acting vs. directing/crew). */}
      <div className="flex flex-col gap-10 py-8">
        {acting.length > 0 ? <CreditList id="acting" heading="Acting" credits={acting} /> : null}
        {crew.length > 0 ? <CreditList id="crew" heading="Directing & crew" credits={crew} /> : null}

        {credits.length === 0 ? (
          <EmptyState
            icon="◎"
            title="No credits yet"
            description={`We don't have any titles linked to ${person.name} yet. Check back after a catalog sync.`}
          />
        ) : null}
      </div>
    </Container>
  );
}

/** Highest-`editorial_score` titles, de-duplicated by title (a person can have
 * several credit rows for one title — e.g. dual roles, or cast + director). */
function topKnownFor(credits: PersonCredit[], limit = 12): Title[] {
  const seen = new Set<string>();
  const out: Title[] = [];
  const sorted = [...credits].sort((a, b) => (b.title.score ?? -1) - (a.title.score ?? -1));
  for (const credit of sorted) {
    if (seen.has(credit.title.id)) continue;
    seen.add(credit.title.id);
    out.push(credit.title);
    if (out.length >= limit) break;
  }
  return out;
}

/** Newest first, then alphabetically — a stable ordering for credit lists. */
function byRecency(a: PersonCredit, b: PersonCredit): number {
  return (b.title.releaseYear ?? 0) - (a.title.releaseYear ?? 0) || a.title.name.localeCompare(b.title.name);
}

/**
 * Group repeated credit rows for the same title under one row (the DB keeps
 * distinct rows per character/job, so dual roles appear once with two labels
 * instead of two identical links).
 */
function groupCreditsByTitle(credits: PersonCredit[]): { title: Title; roles: PersonCredit[] }[] {
  const order = new Map<string, { title: Title; roles: PersonCredit[] }>();
  for (const credit of credits) {
    const existing = order.get(credit.title.id);
    if (existing) {
      existing.roles.push(credit);
    } else {
      order.set(credit.title.id, { title: credit.title, roles: [credit] });
    }
  }
  return [...order.values()];
}

/** Human labels for a credit row's role(s): "as Character", a crew job, etc. */
function roleLabels(roles: PersonCredit[]): string | null {
  const labels = roles
    .map((credit) => {
      if (credit.creditType === 'cast' && credit.character) return `as ${credit.character}`;
      if (credit.creditType === 'crew' && credit.job) return credit.job;
      return null;
    })
    .filter((label): label is string => Boolean(label));
  return labels.length > 0 ? labels.join(', ') : null;
}

/** One grouped credit list (Acting or Directing & crew). */
function CreditList({ id, heading, credits }: { id: string; heading: string; credits: PersonCredit[] }) {
  const rows = groupCreditsByTitle(credits);
  if (rows.length === 0) return null;

  return (
    <section aria-labelledby={`${id}-heading`} className="flex flex-col gap-4">
      <h2 id={`${id}-heading`} className="text-lg font-semibold tracking-tight">
        {heading}
      </h2>
      <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface/40">
        {rows.map(({ title, roles }) => {
          const labels = roleLabels(roles);
          const meta = [title.releaseYear ? String(title.releaseYear) : null, title.type === 'tv' ? 'Series' : 'Film', labels]
            .filter((part): part is string => Boolean(part))
            .join(' · ');
          return (
            <li key={title.id} className="flex items-center justify-between gap-4 px-4 py-3">
              <div className="flex min-w-0 flex-col gap-0.5">
                <Link
                  href={`/title/${title.type}/${title.slug}`}
                  className="truncate text-sm font-semibold text-content transition-colors hover:underline focus-visible:underline focus-visible:outline-none"
                >
                  {title.name}
                </Link>
                <p className="truncate text-xs text-content-muted">{meta}</p>
              </div>
              <Link
                href={`/watch/${title.type}/${title.slug}`}
                aria-label={`Watch ${title.name}`}
                className={buttonClasses({ variant: 'ghost', size: 'sm' })}
              >
                <span aria-hidden="true">▶</span> Watch
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
