/**
 * Pure, deterministic helpers for the title-detail experience (Spec Section 4).
 *
 * Only honest formatting lives here — no fabricated seasons, episodes, cast,
 * or crew. Episode and credit data will render once real `seasons` /
 * `episodes` / `title_people` rows exist in Supabase; until then the detail
 * page shows explicit "not available yet" states.
 */

/** Format runtime minutes as "2h 8m" / "2h" / "52m". Null when unknown/zero. */
export function formatRuntime(minutes?: number): string | null {
  if (!minutes || minutes <= 0) return null;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

/**
 * Trim to a max length, preferring a word boundary, adding an ellipsis.
 * Used for meta descriptions / social cards (Section 16).
 */
export function truncate(text: string, max = 160): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max - 1);
  const lastSpace = slice.lastIndexOf(' ');
  const cut = lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice;
  return `${cut.trimEnd()}…`;
}
