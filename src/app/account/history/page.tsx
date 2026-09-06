import type { Metadata } from 'next';
import { getTitleById } from '@/features/catalog/queries';
import { HistoryList, type HistoryItem } from '@/features/account/HistoryList';
import { MOCK_HISTORY } from '@/features/account/mock';

export const metadata: Metadata = { title: 'History' };

export default async function HistoryPage() {
  const resolved = await Promise.all(
    MOCK_HISTORY.map(async (entry) => {
      const title = await getTitleById(entry.titleId);
      return title ? ({ entry, title } satisfies HistoryItem) : null;
    }),
  );
  const items = resolved.filter((item): item is HistoryItem => item !== null);

  return <HistoryList items={items} />;
}
