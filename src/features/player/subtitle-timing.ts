/** Shift ORIGINAL cue times. Positive offsets delay subtitles; never mutate source cues. */
export function shiftedCueTiming(
  start: number,
  end: number,
  offsetSeconds: number,
): { startTime: number; endTime: number } | null {
  if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(offsetSeconds) ||
      start < 0 || end <= start) return null;
  const startTime = Math.max(0, start + offsetSeconds);
  const endTime = end + offsetSeconds;
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) return null;
  return { startTime, endTime };
}
