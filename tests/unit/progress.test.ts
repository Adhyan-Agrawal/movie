import { describe, expect, it } from 'vitest';
import {
  COMPLETION_THRESHOLD,
  RESUME_MIN_PROGRESS,
  isResumable,
  progressFraction,
} from '@/features/playback/progress';

/**
 * The progress policy is pure math with product meaning: a fabricated 50% on
 * an unknown duration would be a lie on the home row, and resuming a finished
 * title would be a bad default. These tests pin both rules.
 */

describe('progressFraction', () => {
  it('computes a 0..1 fraction from position and duration', () => {
    expect(progressFraction(60, 120)).toBeCloseTo(0.5);
    expect(progressFraction(0, 120)).toBe(0);
    expect(progressFraction(119, 120)).toBeCloseTo(0.9917);
  });

  it('clamps beyond-full playback to 1', () => {
    expect(progressFraction(300, 120)).toBe(1);
  });

  it('returns 0 for unknown, zero, or invalid durations — never a guess', () => {
    expect(progressFraction(60, undefined)).toBe(0);
    expect(progressFraction(60, 0)).toBe(0);
    expect(progressFraction(60, Number.NaN)).toBe(0);
    expect(progressFraction(60, -10)).toBe(0);
  });

  it('returns 0 for missing or invalid positions', () => {
    expect(progressFraction(Number.NaN, 120)).toBe(0);
    expect(progressFraction(-5, 120)).toBe(0);
  });
});

describe('isResumable', () => {
  it('resumes mid-watch positions', () => {
    expect(isResumable(0.5)).toBe(true);
    expect(isResumable(RESUME_MIN_PROGRESS)).toBe(true);
  });

  it('does not resume barely-started or finished titles', () => {
    expect(isResumable(0)).toBe(false);
    expect(isResumable(0.01)).toBe(false);
    expect(isResumable(COMPLETION_THRESHOLD)).toBe(false);
    expect(isResumable(1)).toBe(false);
  });
});
