import { describe, expect, it } from 'vitest';
import { shiftedCueTiming } from '@/features/player/subtitle-timing';

describe('shiftedCueTiming', () => {
  it('delays positive offsets and advances negative offsets', () => {
    expect(shiftedCueTiming(5, 8, 0.25)).toEqual({ startTime: 5.25, endTime: 8.25 });
    expect(shiftedCueTiming(5, 8, -0.25)).toEqual({ startTime: 4.75, endTime: 7.75 });
  });

  it('clamps partly elapsed cues and drops fully expired cues', () => {
    expect(shiftedCueTiming(1, 3, -2)).toEqual({ startTime: 0, endTime: 1 });
    expect(shiftedCueTiming(1, 3, -3)).toBeNull();
    expect(shiftedCueTiming(1, 3, -4)).toBeNull();
  });

  it('resets and reapplies from original times without cumulative drift', () => {
    const original = Object.freeze({ start: 5, end: 8 });
    expect(shiftedCueTiming(original.start, original.end, 2)).toEqual({ startTime: 7, endTime: 10 });
    expect(shiftedCueTiming(original.start, original.end, -1)).toEqual({ startTime: 4, endTime: 7 });
    expect(shiftedCueTiming(original.start, original.end, 0)).toEqual({ startTime: 5, endTime: 8 });
    expect(original).toEqual({ start: 5, end: 8 });
  });

  it.each([
    [Number.NaN, 3, 0], [1, Infinity, 0], [1, 3, Number.NaN], [1, 3, Infinity],
    [-1, 3, 0], [3, 3, 0], [4, 3, 0], [Number.MAX_VALUE / 2, Number.MAX_VALUE, Number.MAX_VALUE],
  ])('rejects invalid or overflowing timing (%s, %s, %s)', (start, end, offset) => {
    expect(shiftedCueTiming(start!, end!, offset!)).toBeNull();
  });
});
