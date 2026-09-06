import { getHomeData } from '@/features/catalog/data';
import { Hero } from '@/features/catalog/components/Hero';
import { ContinueWatchingRow, MediaRow } from '@/features/catalog/components/MediaRow';

export default async function HomePage() {
  const { hero, continueWatching, rows, usingMockData } = await getHomeData();

  return (
    <div className="flex flex-col gap-10 pb-8">
      <Hero title={hero} />

      {usingMockData ? (
        <div className="mx-4 -mt-4 rounded-md border border-warning/30 bg-warning/10 px-4 py-2 text-xs text-warning md:mx-8">
          Showing sample catalog. Configure Supabase and TMDB to load live content.
        </div>
      ) : null}

      <div className="flex flex-col gap-10">
        <ContinueWatchingRow entries={continueWatching} />
        {rows.map((row) => (
          <MediaRow key={row.id} row={row} />
        ))}
      </div>
    </div>
  );
}
