import Link from 'next/link';
import { cn } from '@/lib/cn';
import { publicEnv } from '@/lib/env';
import { Badge } from '@/components/ui/Badge';
import { buttonClasses } from '@/components/ui/Button';
import { Container } from '@/components/ui/Container';
import { MediaRow } from './MediaRow';
import { WatchlistButton } from './WatchlistButton';
import { ShareButton } from './ShareButton';
import { SeasonEpisodeList } from './SeasonEpisodeList';
import { formatRuntime, synthesizeCredits, synthesizeSeasons } from './title-detail-helpers';
import { getSimilarTitles } from '../queries';
import type { MediaRow as MediaRowType, Title } from '../types';

/** Playback availability, driven by provider/consent policy (Spec Sections 4, 9). */
export type TitleAvailability = 'available' | 'unavailable' | 'consent-required';

const AVAILABILITY: Record<
  TitleAvailability,
  { tone: 'success' | 'warning' | 'info'; label: string; note?: string; playable: boolean }
> = {
  available: { tone: 'success', label: 'Streaming now on Lumora', playable: true },
  unavailable: {
    tone: 'warning',
    label: 'Playback currently unavailable',
    note: 'No authorized playback source is available for this title right now. Please check back later or try an alternate source.',
    playable: false,
  },
  'consent-required': {
    tone: 'info',
    label: 'Consent required to play',
    note: 'Playback uses an external provider embed. Review and accept provider consent to continue.',
    playable: false,
  },
};

/**
 * Premium title-detail layout (Spec Section 4): backdrop hero band with
 * legibility scrims, poster, metadata, synopsis, sample credits, TV
 * seasons/episodes, similar titles, and a props-driven availability state.
 * Never presents a broken iframe as the primary experience.
 */
export async function TitleDetail({
  title,
  availability = 'available',
}: {
  title: Title;
  availability?: TitleAvailability;
}) {
  const similar = await getSimilarTitles(title);
  const credits = synthesizeCredits(title);
  const seasons = title.type === 'tv' ? synthesizeSeasons(title) : [];
  const runtime = formatRuntime(title.runtimeMinutes);
  const state = AVAILABILITY[availability];
  const watchHref = `/watch/${title.type}/${title.slug}`;
  const shareUrl = new URL(`/title/${title.type}/${title.slug}`, publicEnv.NEXT_PUBLIC_APP_URL).toString();
  const similarRow: MediaRowType = { id: 'similar', heading: 'More like this', titles: similar };

  const toneDot =
    state.tone === 'success' ? 'bg-success' : state.tone === 'warning' ? 'bg-warning' : 'bg-info';
  const toneText =
    state.tone === 'success' ? 'text-success' : state.tone === 'warning' ? 'text-warning' : 'text-info';

  return (
    <article aria-labelledby="title-heading" className="flex flex-col gap-10 pb-8">
      {/* Backdrop hero band */}
      <section className="relative overflow-hidden">
        <div
          aria-hidden="true"
          className="absolute inset-0"
          style={
            title.backdropUrl?.startsWith('linear-gradient')
              ? { backgroundImage: title.backdropUrl }
              : title.backdropUrl
                ? { backgroundImage: `url(${title.backdropUrl})`, backgroundSize: 'cover', backgroundPosition: 'center' }
                : undefined
          }
        />
        {/* Legibility scrims over artwork (Section 5) */}
        <div aria-hidden="true" className="absolute inset-0 bg-gradient-to-t from-base via-base/80 to-base/30" />
        <div aria-hidden="true" className="absolute inset-0 bg-gradient-to-r from-base/85 via-base/40 to-transparent" />

        <Container className="relative z-10">
          <div className="flex flex-col gap-6 pb-8 pt-10 md:flex-row md:gap-8 md:pb-12 md:pt-16">
            {/* Poster */}
            <div className="shrink-0">
              <div
                role="img"
                aria-label={`Poster art for ${title.name}`}
                className="aspect-[2/3] w-36 overflow-hidden rounded-lg border border-border shadow-raised sm:w-44 md:w-56"
                style={title.posterUrl?.startsWith('linear-gradient') ? { backgroundImage: title.posterUrl } : undefined}
              />
            </div>

            {/* Primary info */}
            <div className="flex max-w-2xl flex-col gap-4">
              <div className="flex flex-wrap items-center gap-2">
                {title.featured ? <Badge tone="primary">Featured</Badge> : null}
                {title.type === 'tv' ? <Badge tone="info">Series</Badge> : <Badge tone="neutral">Film</Badge>}
                <Badge tone="neutral">{title.maturity}</Badge>
              </div>

              <div className="flex flex-col gap-1">
                <h1 id="title-heading" className="font-display text-3xl font-bold tracking-tight md:text-5xl">
                  {title.name}
                </h1>
                {title.originalName && title.originalName !== title.name ? (
                  <p className="text-sm text-content-subtle">{title.originalName}</p>
                ) : null}
              </div>

              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-content-muted">
                <span>{title.releaseYear}</span>
                {runtime ? (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>{runtime}</span>
                  </>
                ) : null}
                {title.genres.length ? (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>{title.genres.join(', ')}</span>
                  </>
                ) : null}
                {typeof title.score === 'number' ? (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="text-success">{title.score}% score</span>
                  </>
                ) : null}
              </div>

              {/* Provider / availability status line */}
              <p className={cn('flex items-center gap-2 text-sm', toneText)}>
                <span aria-hidden="true" className={cn('h-2 w-2 rounded-full', toneDot)} />
                {state.label}
              </p>

              {/* Primary actions */}
              <div className="mt-1 flex flex-wrap items-center gap-3">
                {state.playable ? (
                  <Link
                    href={watchHref}
                    aria-label={`Play ${title.name}`}
                    className={buttonClasses({ size: 'lg', variant: 'primary' })}
                  >
                    <span aria-hidden="true">▶</span> Play
                  </Link>
                ) : (
                  <button
                    type="button"
                    disabled
                    aria-label={`Play ${title.name} (unavailable)`}
                    className={buttonClasses({ size: 'lg', variant: 'primary' })}
                  >
                    <span aria-hidden="true">▶</span> Play
                  </button>
                )}

                <WatchlistButton titleName={title.name} />

                {title.trailerUrl ? (
                  <a
                    href={title.trailerUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`Watch the trailer for ${title.name} (opens in a new tab)`}
                    className={buttonClasses({ size: 'lg', variant: 'secondary' })}
                  >
                    <span aria-hidden="true">▶</span> Trailer
                  </a>
                ) : null}

                <ShareButton url={shareUrl} titleName={title.name} />
              </div>

              {!state.playable && state.note ? (
                <div
                  role="status"
                  className={cn(
                    'rounded-md border px-3 py-2 text-sm',
                    state.tone === 'warning'
                      ? 'border-warning/30 bg-warning/10 text-warning'
                      : 'border-info/30 bg-info/10 text-info',
                  )}
                >
                  {state.note}
                </div>
              ) : null}

              <p className="max-w-xl text-sm leading-relaxed text-content-muted md:text-base">{title.synopsis}</p>
            </div>
          </div>
        </Container>
      </section>

      {/* Details */}
      <Container>
        <div className="grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,1fr)_260px]">
          <div className="flex flex-col gap-10">
            {title.type === 'tv' && seasons.length ? (
              <section aria-labelledby="episodes-heading" className="flex flex-col gap-4">
                <div className="flex items-baseline justify-between gap-4">
                  <h2 id="episodes-heading" className="text-lg font-semibold tracking-tight">
                    Episodes
                  </h2>
                  <span className="text-xs text-content-subtle">Sample schedule</span>
                </div>
                <SeasonEpisodeList
                  seasons={seasons}
                  titleType={title.type}
                  titleSlug={title.slug}
                  titleName={title.name}
                />
              </section>
            ) : null}

            <section aria-labelledby="credits-heading" className="flex flex-col gap-4">
              <div className="flex items-baseline justify-between gap-4">
                <h2 id="credits-heading" className="text-lg font-semibold tracking-tight">
                  Cast &amp; crew
                </h2>
                <span className="text-xs text-content-subtle">Sample credits</span>
              </div>
              <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
                <div className="flex flex-col gap-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-content-subtle">Cast</h3>
                  <ul className="flex flex-col gap-2">
                    {credits.cast.map((c) => (
                      <li key={`cast-${c.name}-${c.role}`} className="flex items-center justify-between gap-3 text-sm">
                        <span className="text-content">{c.name}</span>
                        <span className="text-content-subtle">{c.role}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="flex flex-col gap-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-content-subtle">Crew</h3>
                  <ul className="flex flex-col gap-2">
                    {credits.crew.map((c) => (
                      <li key={`crew-${c.name}-${c.role}`} className="flex items-center justify-between gap-3 text-sm">
                        <span className="text-content">{c.name}</span>
                        <span className="text-content-subtle">{c.role}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </section>
          </div>

          <aside aria-labelledby="details-heading" className="flex flex-col gap-4">
            <h2 id="details-heading" className="text-lg font-semibold tracking-tight">
              Details
            </h2>
            <dl className="flex flex-col gap-3 rounded-lg border border-border bg-surface/40 p-4 text-sm">
              <Fact label="Type" value={title.type === 'tv' ? 'TV series' : 'Film'} />
              <Fact label="Released" value={String(title.releaseYear)} />
              {runtime ? <Fact label={title.type === 'tv' ? 'Episode runtime' : 'Runtime'} value={runtime} /> : null}
              <Fact label="Maturity" value={title.maturity} />
              <Fact label="Genres" value={title.genres.join(', ') || '—'} />
              {typeof title.score === 'number' ? <Fact label="Score" value={`${title.score}%`} /> : null}
            </dl>
          </aside>
        </div>
      </Container>

      {/* Similar titles (uses getSimilarTitles + MediaCard via MediaRow) */}
      <MediaRow row={similarRow} />
    </article>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <dt className="text-content-subtle">{label}</dt>
      <dd className="text-right text-content">{value}</dd>
    </div>
  );
}
