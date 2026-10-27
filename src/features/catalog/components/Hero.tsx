import Link from 'next/link';
import Image from 'next/image';
import { Badge } from '@/components/ui/Badge';
import { buttonClasses } from '@/components/ui/Button';
import type { Title } from '../types';

/** True when the artwork is a real remote image (TMDB-style http(s) URL). */
function isRemoteUrl(url: string | undefined): boolean {
  return url !== undefined && (url.startsWith('https://') || url.startsWith('http://'));
}

/** Editorial hero (Section 4). Real TMDB backdrop when present; gradient fallback keeps it premium. */
export function Hero({ title, priority = true }: { title: Title; priority?: boolean }) {
  const href = `/title/${title.type}/${title.slug}`;
  const watchHref = `/watch/${title.type}/${title.slug}`;
  const headingId = `hero-title-${title.id.replace(/[^a-z0-9-]/gi, '-')}`;

  return (
    <section
      aria-labelledby={headingId}
      className="discovery-hero relative flex min-h-[62vh] flex-col justify-end overflow-hidden md:min-h-[72vh]"
    >
      {isRemoteUrl(title.backdropUrl) && title.backdropUrl ? (
        /* Decorative backdrop — the section's text carries the meaning. */
        <Image
          src={title.backdropUrl}
          alt=""
          fill
          priority={priority}
          sizes="100vw"
          className="object-cover"
          aria-hidden
        />
      ) : (
        <div
          aria-hidden="true"
          className="absolute inset-0"
          style={title.backdropUrl?.startsWith('linear-gradient') ? { backgroundImage: title.backdropUrl } : undefined}
        />
      )}
      {/* Legibility gradients over artwork (Section 5) */}
      <div aria-hidden="true" className="absolute inset-0 bg-gradient-to-t from-base via-base/70 to-transparent" />
      <div aria-hidden="true" className="absolute inset-0 bg-gradient-to-r from-base/90 via-base/30 to-transparent" />

      <div className="relative z-10 flex max-w-2xl flex-col gap-4 px-4 pb-24 md:px-8 md:pb-28">
        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-content-muted">Lumora / In the spotlight</p>
        <div className="flex flex-wrap items-center gap-2">
          {title.featured ? <Badge tone="primary">Featured</Badge> : null}
          {title.type === 'tv' ? <Badge tone="info">Series</Badge> : null}
          <Badge tone="neutral">{title.maturity}</Badge>
        </div>

        <h1 id={headingId} className="font-display text-4xl font-bold tracking-tight md:text-6xl">
          {title.name}
        </h1>

        <div className="flex flex-wrap items-center gap-2 text-sm text-content-muted">
          {title.releaseYear > 0 ? <span>{title.releaseYear}</span> : null}
          {title.genres.length ? (
            <>
              <span aria-hidden="true">·</span>
              <span>{title.genres.join(', ')}</span>
            </>
          ) : null}
          {typeof title.score === 'number' ? (
            <>
              <span aria-hidden="true">·</span>
              <span className="text-success">{(title.score / 10).toFixed(1)}/10 rating</span>
            </>
          ) : null}
        </div>

        <p className="line-clamp-3 max-w-xl text-sm leading-relaxed text-content-muted md:text-base">{title.synopsis}</p>

        <div className="mt-1 flex flex-wrap items-center gap-3">
          <Link
            href={watchHref}
            aria-label={`Play ${title.name}`}
            className={buttonClasses({ size: 'lg', variant: 'primary' })}
          >
            <span aria-hidden="true">▶</span> Play
          </Link>
          <Link href={href} className={buttonClasses({ size: 'lg', variant: 'secondary' })}>
            More info
          </Link>
        </div>
      </div>
    </section>
  );
}
