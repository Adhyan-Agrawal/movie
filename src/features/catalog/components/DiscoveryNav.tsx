import Link from 'next/link';
import { DISCOVERY_COLLECTIONS, discoveryHref, providerGenre } from '../discovery';
import type { DiscoveryCollection, DiscoveryFilters, TitleType } from '../types';

export function DiscoveryNav({ collections = DISCOVERY_COLLECTIONS, type, genres }: { collections?: DiscoveryCollection[]; type?: TitleType; genres?: string[] }) {
  const visible = collections.filter((item) => (!type || !item.filters.type || item.filters.type === type)
    && (!genres || !item.filters.genre || genres.some((genre) => genre.toLowerCase() === providerGenre(item.filters.genre!, type ?? 'movie').toLowerCase()
      || (!type && genre.toLowerCase() === providerGenre(item.filters.genre!, 'tv').toLowerCase()))));
  if (!visible.length) return null;
  return (
    <nav aria-label="Explore genres and world cinema" className="discovery-nav">
      <p className="site-eyebrow">Genres &amp; world cinema</p>
      <ul>
        {visible.map((item) => {
          const filters: DiscoveryFilters = { ...item.filters, ...(type ? { type } : {}) };
          const href = type ? discoveryHref(filters, type === 'movie' ? '/movies' : '/tv') : item.href;
          return (
            <li key={item.id} className="shrink-0">
               <Link href={href} prefetch={false} className="discovery-chip">
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
