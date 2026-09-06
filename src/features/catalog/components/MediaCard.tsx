import Link from 'next/link';
import Image from 'next/image';
import { cn } from '@/lib/cn';
import { Badge } from '@/components/ui/Badge';
import type { Title } from '../types';

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
}: {
  title: Title;
  /** 0..1 resume progress, renders a bottom bar when present. */
  progress?: number;
  className?: string;
}) {
  const runtime = formatRuntime(title.runtimeMinutes);
  const href = `/title/${title.type}/${title.slug}`;

  return (
    <Link
      href={href}
      className={cn(
        'group relative flex w-40 shrink-0 flex-col gap-2 rounded-md sm:w-44 md:w-48',
        'focus-visible:outline-none',
        className,
      )}
      aria-label={`${title.name} (${title.releaseYear}), ${title.maturity}`}
    >
      <div
        className={cn(
          'relative aspect-[2/3] w-full overflow-hidden rounded-md border border-border',
          'bg-surface-raised shadow-soft transition-transform duration-200 ease-deliberate',
          'group-hover:-translate-y-1 group-hover:border-border-strong',
          'group-focus-visible:ring-2 group-focus-visible:ring-primary',
        )}
        style={title.posterUrl?.startsWith('linear-gradient') ? { backgroundImage: title.posterUrl } : undefined}
      >
        {isRemoteUrl(title.posterUrl) && title.posterUrl ? (
          <Image
            src={title.posterUrl}
            alt={`${title.name} poster`}
            fill
            sizes="(max-width: 640px) 45vw, 200px"
            className="object-cover"
          />
        ) : null}
        <div className="absolute left-2 top-2 flex gap-1">
          {title.type === 'tv' ? <Badge tone="info">Series</Badge> : null}
        </div>
        <div className="absolute right-2 top-2">
          <Badge tone="neutral">{title.maturity}</Badge>
        </div>

        {/* Legibility scrim for the metadata at the base of the poster */}
        <div className="absolute inset-x-0 bottom-0 h-2/5 bg-gradient-to-t from-black/80 to-transparent" />
        <div className="absolute inset-x-0 bottom-0 p-2.5">
          <p className="line-clamp-2 text-sm font-semibold text-white drop-shadow">{title.name}</p>
        </div>

        {typeof progress === 'number' ? (
          <div className="absolute inset-x-0 bottom-0 h-1 bg-black/50">
            <div
              className="h-full bg-primary"
              style={{ width: `${Math.round(Math.min(1, Math.max(0, progress)) * 100)}%` }}
            />
          </div>
        ) : null}
      </div>

      <div className="flex items-center gap-1.5 px-0.5 text-xs text-content-muted">
        <span>{title.releaseYear}</span>
        {runtime ? (
          <>
            <span aria-hidden="true">·</span>
            <span>{runtime}</span>
          </>
        ) : null}
        {typeof title.score === 'number' ? (
          <>
            <span aria-hidden="true">·</span>
            <span className="text-success">{title.score}%</span>
          </>
        ) : null}
      </div>
    </Link>
  );
}
