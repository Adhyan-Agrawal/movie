import { describe, expect, it } from 'vitest';
import { MOCK_ROWS, MOCK_CONTINUE_WATCHING, MOCK_TITLES } from '@/features/catalog/mock-data';

describe('mock catalog integrity', () => {
  it('every row references known titles', () => {
    const ids = new Set(MOCK_TITLES.map((t) => t.id));
    for (const row of MOCK_ROWS) {
      expect(row.titles.length).toBeGreaterThan(0);
      for (const t of row.titles) expect(ids.has(t.id)).toBe(true);
    }
  });

  it('continue-watching progress is a 0..1 fraction', () => {
    for (const entry of MOCK_CONTINUE_WATCHING) {
      expect(entry.progress.progress).toBeGreaterThanOrEqual(0);
      expect(entry.progress.progress).toBeLessThanOrEqual(1);
    }
  });

  it('titles have unique slugs', () => {
    const slugs = MOCK_TITLES.map((t) => t.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});
