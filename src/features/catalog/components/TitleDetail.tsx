import Link from 'next/link';
import Image from 'next/image';
import { cn } from '@/lib/cn';
import { features, publicEnv } from '@/lib/env';
import { Badge } from '@/components/ui/Badge';
import { Container } from '@/components/ui/Container';
import { EmptyState } from '@/components/ui/EmptyState';
import { MediaRow } from './MediaRow';
import { SeasonEpisodeList } from './SeasonEpisodeList';
import { WatchlistButton } from './WatchlistButton';
import { TrailerButton } from './TrailerButton';
import { ShareButton } from './ShareButton';
import { formatRuntime } from './title-detail-helpers';
import { getSimilarTitles, listCastForTitle, listSeasonsForTitle } from '../queries';
import { getRatingSummary, getMyRating } from '../ratings-queries';
import { getResumablePlayback, isSignedIn } from '@/features/playback/progress-queries';
import { RatingControl } from './RatingControl';
import { ResumePlayButton, type PlayResumeInfo } from './ResumePlayButton';
import type { MediaRow as MediaRowType, Title } from '../types';
import { Icon } from '@/components/ui/Icon';
import { SectionReveal } from '@/components/ui/SectionReveal';
import { isStoredCatalogId } from '@/features/account/availability';

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

/** True when the artwork is a real remote image (TMDB-style http(s) URL). */
function isRemoteUrl(url: string | undefined): boolean {
  return url !== undefined && (url.startsWith('https://') || url.startsWith('http://'));
}

/**
 * Premium title-detail layout (Spec Section 4): backdrop hero band with
 * legibility scrims, poster, metadata, synopsis, seasons/episodes and cast
 * from the real `seasons`/`episodes`/`title_people` tables (honest not-yet-
 * imported states when they're empty), similar titles, and a props-driven
 * availability state. Never presents a broken iframe as the primary experience.
 */
export async function TitleDetail({
  title,
  availability = 'available',
  initialInWatchlist = false,
}: {
  title: Title;
  availability?: TitleAvailability;
  /** Resolved server-side from the signed-in viewer's watchlist. */
  initialInWatchlist?: boolean;
}) {
  const [similar, seasons, cast, ratingSummary, myRating, signedIn, playback] = await Promise.all([
    getSimilarTitles(title),
    title.type === 'tv' ? listSeasonsForTitle(title.id) : Promise.resolve([]),
    listCastForTitle(title.id),
    features.supabaseConfigured ? getRatingSummary(title.id) : Promise.resolve({ average: null, count: 0 }),
    features.supabaseConfigured ? getMyRating(title.id) : Promise.resolve(null),
    features.supabaseConfigured ? isSignedIn().catch((err: unknown) => {
      console.warn('title.isSignedIn: optional read failed', {
        message: err instanceof Error ? err.message : String(err),
      });
      return false;
    }) : Promise.resolve(false),
    features.supabaseConfigured ? getResumablePlayback(title) : Promise.resolve(null),
  ]);
  const runtime = formatRuntime(title.runtimeMinutes);
  const state = AVAILABILITY[availability];
  const watchHref = `/watch/${title.type}/${title.slug}`;
  // Signed-in resume: the title page CTA becomes "Resume" and (for a series)
  // deep-links to the LAST episode the viewer was watching. Guests resolve
  // their own resume client-side from the browser guest store.
  const serverResume: PlayResumeInfo | null = playback
    ? playback.type === 'movie'
      ? { href: watchHref, label: 'Resume', progress: playback.progress }
      : {
          href: `/watch/tv/${title.slug}?season=${playback.episode.seasonNumber}&episode=${playback.episode.episodeNumber}`,
          label: `Resume S${playback.episode.seasonNumber} E${playback.episode.episodeNumber}`,
          progress: playback.progress,
        }
    : null;
  const shareUrl = new URL(`/title/${title.type}/${title.slug}`, publicEnv.NEXT_PUBLIC_APP_URL).toString();
  const similarRow: MediaRowType = { id: 'similar', heading: 'More like this', titles: similar };

  const toneDot =
    state.tone === 'success' ? 'bg-success' : state.tone === 'warning' ? 'bg-warning' : 'bg-info';
  const toneText =
    state.tone === 'success' ? 'text-success' : state.tone === 'warning' ? 'text-warning' : 'text-info';

  return (
    <article aria-labelledby="title-heading" className="title-detail">
      {/* Backdrop hero band */}
      <section className="title-hero">
        {isRemoteUrl(title.backdropUrl) && title.backdropUrl ? (
          /* Decorative backdrop — the adjacent text carries the meaning. */
          <Image
            src={title.backdropUrl}
            alt=""
            fill
            priority
            unoptimized
            loading="eager"
            decoding="async"
            sizes="100vw"
            className="object-cover"
            aria-hidden
          />
        ) : (
          <div
            aria-hidden="true"
             className="hero-artwork-fallback"
          />
        )}
        {/* Legibility scrims over artwork (Section 5) */}
        <div aria-hidden="true" className="title-hero-scrim" />

        <Container className="relative z-10">
          <div className="title-hero-layout">
            {/* Poster */}
            <div className="title-poster">
              <div
                className="title-poster-artwork"
              >
                {isRemoteUrl(title.posterUrl) && title.posterUrl ? (
                  <Image
                    src={title.posterUrl}
                    alt={`Poster for ${title.name}`}
                    fill
                    unoptimized
                    loading="lazy"
                    decoding="async"
                     sizes="(max-width: 767px) 1px, (max-width: 1199px) 210px, 270px"
                    className="object-cover"
                  />
                ) : (
                   <div className="media-card-placeholder"><Icon name={title.type === 'tv' ? 'tv' : 'film'} width="32" height="32" /><span>Artwork unavailable</span></div>
                )}
              </div>
            </div>

            {/* Primary info */}
            <div className="title-primary-info">
              <div className="site-eyebrow flex flex-wrap items-center gap-3">
                {title.featured ? <Badge tone="primary">Featured</Badge> : null}
                <span>{title.type === 'tv' ? 'The series' : 'The film'}</span>
                {title.maturity ? <span className="hero-maturity">{title.maturity}</span> : null}
              </div>

              <div className="flex flex-col gap-1">
                <h1 id="title-heading" className="title-heading">
                  {title.name}
                </h1>
                {title.originalName && title.originalName !== title.name ? (
                   <p className="title-original-name">{title.originalName}</p>
                ) : null}
              </div>

              <div className="hero-metadata">
                {title.releaseYear > 0 ? <span>{title.releaseYear}</span> : null}
                {runtime ? <span>{runtime}</span> : null}
                {title.genres.length ? (
                    <span>{title.genres.join(' / ')}</span>
                ) : null}
                {typeof title.score === 'number' ? (
                    <span className="hero-rating">{(title.score / 10).toFixed(1)}/10 rating</span>
                ) : null}
              </div>

              {/* Provider / availability status line */}
              <p className={cn('title-availability', toneText)}>
                <span aria-hidden="true" className={cn('h-2 w-2 rounded-full', toneDot)} />
                {state.label}
              </p>

              {/* Primary actions */}
              <div className="title-actions">
                <ResumePlayButton
                  baseHref={watchHref}
                  playable={state.playable}
                  signedIn={signedIn}
                  serverResume={serverResume}
                />

                <WatchlistButton titleId={title.id} titleName={title.name} initialInWatchlist={initialInWatchlist}
                  available={features.supabaseConfigured && isStoredCatalogId(title.id)} />

                {title.trailerUrl || title.imdbId || title.tmdbId ? (
                  <TrailerButton trailerUrl={title.trailerUrl} titleName={title.name}
                    imdbId={title.imdbId} tmdbId={title.tmdbId} type={title.type} />
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

              {/* Community rating + per-viewer rating control (Spec Section 4). */}
              <div className="mt-1">
                <RatingControl
                  titleId={title.id}
                  initialMyRating={myRating}
                  average={ratingSummary.average}
                  count={ratingSummary.count}
                  available={features.supabaseConfigured && isStoredCatalogId(title.id)}
                />
              </div>

              {title.synopsis ? <p className="title-synopsis">{title.synopsis}</p> : null}
            </div>
          </div>
        </Container>
      </section>

      {/* Details */}
      <Container>
        <SectionReveal><div className="title-details-layout">
          <div className="flex flex-col gap-10">
            {title.type === 'tv' ? (
              <section aria-labelledby="episodes-heading" className="flex flex-col gap-4">
                 <h2 id="episodes-heading" className="title-section-heading">
                  Episodes
                </h2>
                {seasons.length > 0 ? (
                  <SeasonEpisodeList seasons={seasons} titleSlug={title.slug} titleName={title.name} />
                ) : (
                  <EmptyState
                    icon="▦"
                    title="No episode details yet"
                    description="Episode details aren’t available for this title yet."
                    className="py-10"
                  />
                )}
              </section>
            ) : null}

            <section aria-labelledby="credits-heading" className="flex flex-col gap-4">
               <h2 id="credits-heading" className="title-section-heading">
                Cast
              </h2>
              {cast.length > 0 ? (
                 <ul className="title-cast-grid">
                  {cast.map((member) => (
                    <li
                      key={member.personId}
                       className="min-w-0"
                     >
                      <Link href={`/person/${member.personId}`} prefetch={false} className="title-cast-card">
                      <div className="title-cast-photo">
                       {member.profileUrl ? (
                         <Image
                          src={member.profileUrl}
                          alt=""
                           fill
                          unoptimized
                          loading="lazy"
                          decoding="async"
                           sizes="(max-width: 539px) 40vw, (max-width: 1023px) 20vw, 200px"
                           className="object-cover"
                        />
                      ) : (
                        <div
                          aria-hidden="true"
                           className="absolute inset-0 grid place-items-center text-content-subtle"
                        >
                           <Icon name="user" width="28" height="28" />
                        </div>
                      )}
                      </div>
                       <div className="min-w-0">
                         <p className="title-cast-name">{member.name}</p>
                         {member.character ? (
                           <p className="title-cast-role">{member.character}</p>
                        ) : null}
                       </div>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState
                  icon="◎"
                  title="No cast information yet"
                  description="Cast information isn’t available for this title yet."
                  className="py-10"
                />
              )}
            </section>
          </div>

          <aside aria-labelledby="details-heading" className="flex flex-col gap-4">
             <h2 id="details-heading" className="title-section-heading">
              Details
            </h2>
             <dl className="title-facts">
              <Fact label="Type" value={title.type === 'tv' ? 'TV series' : 'Film'} />
               {title.releaseYear > 0 ? <Fact label="Released" value={String(title.releaseYear)} /> : null}
              {runtime ? <Fact label={title.type === 'tv' ? 'Episode runtime' : 'Runtime'} value={runtime} /> : null}
              <Fact label="Maturity" value={title.maturity} />
              <Fact label="Genres" value={title.genres.join(', ') || '—'} />
               {typeof title.score === 'number' ? <Fact label="Rating" value={`${(title.score / 10).toFixed(1)}/10`} /> : null}
               {title.originalLanguage ? <Fact label="Original language" value={title.originalLanguage.toUpperCase()} /> : null}
               {title.originCountries?.length ? <Fact label="Country of origin" value={title.originCountries.join(', ')} /> : null}
            </dl>
          </aside>
        </div></SectionReveal>
      </Container>

      {/* Similar titles (uses getSimilarTitles + MediaCard via MediaRow) */}
      <SectionReveal><MediaRow row={similarRow} variant="landscape" /></SectionReveal>
    </article>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
