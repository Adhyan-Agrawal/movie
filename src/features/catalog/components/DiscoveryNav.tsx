import Link from 'next/link';
import { DISCOVERY_COLLECTIONS, discoveryHref } from '../discovery';
import type { DiscoveryCollection, DiscoveryFilters, TitleType } from '../types';

export function DiscoveryNav({ collections = DISCOVERY_COLLECTIONS, type, genres }: { collections?: DiscoveryCollection[]; type?: TitleType; genres?: string[] }) {
  const visible = collections.filter((item) => (!type || !item.filters.type || item.filters.type === type)
    && (!genres || !item.filters.genre || genres.some((genre) => genre === item.filters.genre || (type !== 'movie' && ['Action & Adventure', 'Sci-Fi & Fantasy'].includes(genre) && ['Action', 'Science Fiction'].includes(item.filters.genre!)))));
  if (!visible.length) return null;
  return (
    <nav aria-label="Explore genres and world cinema" className="discovery-nav flex flex-col gap-3">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-content-subtle">Follow your mood. Discover a new world.</p>
      <ul className="flex gap-2 overflow-x-auto pb-2 [scrollbar-width:thin]">
        {visible.map((item) => {
          const filters: DiscoveryFilters = { ...item.filters, ...(type ? { type } : {}) };
          return (
            <li key={item.id} className="shrink-0">
              <Link href={discoveryHref(filters, type === 'movie' ? '/movies' : type === 'tv' ? '/tv' : '/browse')} className="discovery-chip inline-flex min-h-11 items-center rounded-full border border-border bg-surface/70 px-4 text-sm font-medium text-content-muted transition-colors hover:border-primary hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
