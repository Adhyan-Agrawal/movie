/**
 * Pure watch-progress policy (Spec Sections 4, 8, 14).
 *
 * Extracted from the server modules so the clamping and resume rules can be
 * unit-tested directly — they are product policy, not plumbing. Never import
 * server-only modules here; this file must stay safe for any bundle.
 */

/** Progress fraction at or above which a title/episode counts as completed. */
export const COMPLETION_THRESHOLD = 0.95;

/** Below this fraction the viewer only just started — no resume value. */
export const RESUME_MIN_PROGRESS = 0.02;

/**
 * Clamp a playback position to a 0..1 progress fraction. Returns 0 when the
 * duration is unknown or invalid — never a fabricated percentage.
 */
export function progressFraction(positionSeconds: number, durationSeconds?: number): number {
  if (durationSeconds === undefined || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return 0;
  }
  if (!Number.isFinite(positionSeconds) || positionSeconds <= 0) {
    return 0;
  }
  return Math.min(1, positionSeconds / durationSeconds);
}

/**
 * True when a stored progress fraction is worth resuming: past the "just
 * started" floor and below the completion threshold. Finished and barely
 * started titles both return false.
 */
export function isResumable(progress: number): boolean {
  return progress >= RESUME_MIN_PROGRESS && progress < COMPLETION_THRESHOLD;
}
