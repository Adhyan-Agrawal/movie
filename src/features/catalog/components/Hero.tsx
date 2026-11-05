import Link from 'next/link';
import Image from 'next/image';
import { buttonClasses } from '@/components/ui/Button';
import { Container } from '@/components/ui/Container';
import { Icon } from '@/components/ui/Icon';
import { TrailerButton } from './TrailerButton';
import { formatRuntime } from './title-detail-helpers';
import type { Title } from '../types';

/** True when the artwork is a real remote image (TMDB-style http(s) URL). */
function isRemoteUrl(url: string | undefined): boolean {
  return url !== undefined && (url.startsWith('https://') || url.startsWith('http://'));
}

/** An editorial spotlight with real artwork and provider metadata. */
export function Hero({ title, priority = true }: { title: Title; priority?: boolean }) {
  const href = `/title/${title.type}/${title.slug}`;
  const watchHref = `/watch/${title.type}/${title.slug}`;
  const headingId = `hero-title-${title.id.replace(/[^a-z0-9-]/gi, '-')}`;
  const runtime = formatRuntime(title.runtimeMinutes);

  return (
    <section
      aria-labelledby={headingId}
      className="discovery-hero"
    >
      {isRemoteUrl(title.backdropUrl) && title.backdropUrl ? (
        /* Decorative backdrop — the section's text carries the meaning. */
        <Image
          src={title.backdropUrl}
          alt=""
          fill
          priority={priority}
          unoptimized
          loading={priority ? 'eager' : 'lazy'}
          decoding="async"
          sizes="100vw"
          className="hero-artwork object-cover"
          aria-hidden
        />
      ) : (
        <div
          aria-hidden="true"
          className="hero-artwork-fallback"
        />
      )}
      {/* Legibility gradients over artwork (Section 5) */}
      <div aria-hidden="true" className="hero-scrim" />

      <Container className="hero-content-wrap">
      <div className="hero-content">
        <p className="site-eyebrow hero-eyebrow"><span aria-hidden="true" />In the spotlight<span className="hero-type">{title.type === 'tv' ? 'Series' : 'Film'}</span></p>

        <h1 id={headingId} className="hero-title">
          {title.name}
        </h1>

        <div className="hero-metadata">
          {title.releaseYear > 0 ? <span>{title.releaseYear}</span> : null}
          {runtime ? <span>{runtime}</span> : null}
          {title.maturity ? <span className="hero-maturity">{title.maturity}</span> : null}
          {title.genres.length ? (
            <span>{title.genres.slice(0, 3).join(' / ')}</span>
          ) : null}
          {typeof title.score === 'number' ? (
            <span className="hero-rating">{(title.score / 10).toFixed(1)}/10 rating</span>
          ) : null}
        </div>

        {title.synopsis ? <p className="hero-synopsis">{title.synopsis}</p> : null}

        <div className="hero-actions">
          <Link
            href={watchHref}
            prefetch={false}
            aria-label={`Play ${title.name}`}
            className={buttonClasses({ size: 'lg', variant: 'primary', className: 'site-action-primary' })}
          >
            <Icon name="play" /> Play
          </Link>
          <TrailerButton trailerUrl={title.trailerUrl} titleName={title.name} imdbId={title.imdbId} tmdbId={title.tmdbId} type={title.type} />
        </div>
        <Link href={href} prefetch={false} className="hero-info-link">Explore this title <Icon name="arrow-right" width="17" height="17" /></Link>
      </div>
      </Container>
    </section>
  );
}
