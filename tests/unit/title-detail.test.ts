import { describe, expect, it } from 'vitest';
import { formatRuntime, truncate } from '@/features/catalog/components/title-detail-helpers';

/**
 * The title-detail helpers are pure formatters — seasons/episodes and credits
 * are never fabricated. When real `seasons`/`episodes`/`title_people` reads
 * land, their mapping gets its own tests; nothing here may assert invented
 * catalog data.
 */

describe('formatRuntime', () => {
  it('formats hours and minutes', () => {
    expect(formatRuntime(128)).toBe('2h 8m');
  });

  it('formats a whole hour without trailing minutes', () => {
    expect(formatRuntime(120)).toBe('2h');
  });

  it('formats sub-hour runtimes', () => {
    expect(formatRuntime(52)).toBe('52m');
  });

  it('returns null for missing or zero runtime', () => {
    expect(formatRuntime(undefined)).toBeNull();
    expect(formatRuntime(0)).toBeNull();
  });
});

describe('truncate', () => {
  it('leaves short strings unchanged', () => {
    expect(truncate('a short synopsis', 160)).toBe('a short synopsis');
  });

  it('truncates long strings on a boundary with an ellipsis', () => {
    const out = truncate('The quick brown fox jumps over the lazy dog again and again', 20);
    expect(out.length).toBeLessThanOrEqual(20);
    expect(out.endsWith('…')).toBe(true);
  });

  it('handles strings with no spaces without exceeding the limit', () => {
    const out = truncate('x'.repeat(200), 50);
    expect(out.length).toBeLessThanOrEqual(50);
    expect(out.endsWith('…')).toBe(true);
  });
});
