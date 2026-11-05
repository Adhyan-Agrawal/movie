import Link from 'next/link';
import Image from 'next/image';
import { cn } from '@/lib/cn';
import { Icon } from '@/components/ui/Icon';
import type { Title } from '../types';
import { TrailerPreview } from './TrailerPreview';

/** True when the artwork is a real remote image (TMDB-style http(s) URL). */
function isRemoteUrl(url: string | undefined): boolean {
  return url !== undefined && (url.startsWith('https://') || url.startsWith('http://'));
}

/** Format runtime minutes as "2h 8m" / "52m". */
function formatRuntime(minutes?: number): string | null {
  if (!minutes) return null;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h > 0) return `${h}h${m > 0 ? ` ${m}m` : ''}`;
  return `${m}m`;
}

export function MediaCard({
  title,
  progress,
  className,
  href,
  variant = 'poster',
  showMaturity = true,
}: {
  title: Title;
  /** 0..1 resume progress, renders a bottom bar when present. */
  progress?: number;
  className?: string;
  /** Override the default title link (e.g. resume a specific episode). */
  href?: string;
  /** Landscape shelves use a backdrop only when the provider supplies one. */
  variant?: 'poster' | 'landscape';
  /** Browser-local history has no certification metadata. */
  showMaturity?: boolean;
}) {
  const runtime = formatRuntime(title.runtimeMinutes);
  const cardHref = href ?? `/title/${title.type}/${title.slug}`;
  const artwork = variant === 'landscape' && isRemoteUrl(title.backdropUrl) ? title.backdropUrl : title.posterUrl;
  const metadata = [title.releaseYear > 0 ? String(title.releaseYear) : null, runtime, title.type === 'tv' ? 'Series' : 'Film'].filter(Boolean);

  return (
    <Link
      href={cardHref}
      prefetch={false}
      className={cn(
        'discovery-card group',
        variant === 'landscape' ? 'media-card-landscape' : 'media-card-poster',
        className,
      )}
      aria-label={[title.name, title.releaseYear > 0 ? String(title.releaseYear) : null, showMaturity ? title.maturity : null].filter(Boolean).join(', ')}
    >
      <div
        className="media-card-artwork"
      >
        {isRemoteUrl(artwork) && artwork ? (
          <Image
            src={artwork}
            alt=""
            fill
            unoptimized
            loading="lazy"
            decoding="async"
            sizes={variant === 'landscape' ? '(max-width: 640px) 78vw, (max-width: 1024px) 40vw, 360px' : '(max-width: 640px) 45vw, (max-width: 1024px) 25vw, 240px'}
            className={cn('media-card-image object-cover', variant === 'landscape' && artwork === title.posterUrl && 'media-card-poster-fallback')}
          />
        ) : <div className="media-card-placeholder"><Icon name={title.type === 'tv' ? 'tv' : 'film'} width="32" height="32" /><span>{title.name}</span></div>}
        <TrailerPreview imdbId={title.imdbId} tmdbId={title.tmdbId} type={title.type} />
        <div className="media-card-hover" aria-hidden="true"><span className="media-card-hover-icon"><Icon name="arrow-right" /></span><span>Explore title</span></div>
        {showMaturity && title.maturity ? <span className="media-card-maturity">{title.maturity}</span> : null}

        {typeof progress === 'number' ? (
          <div className="media-card-progress">
            <div
              className="h-full bg-primary"
              style={{ width: `${Math.round(Math.min(1, Math.max(0, progress)) * 100)}%` }}
            />
          </div>
        ) : null}
      </div>

      <div className="media-card-copy">
        <p className="media-card-title">{title.name}</p>
        <div className="media-card-meta">
        <span>{metadata.join(' · ')}</span>
        {typeof title.score === 'number' ? (
            <span className="media-card-rating" aria-label={`${(title.score / 10).toFixed(1)} out of 10 rating`}>{(title.score / 10).toFixed(1)}/10</span>
        ) : null}
        </div>
      </div>
    </Link>
  );
}
