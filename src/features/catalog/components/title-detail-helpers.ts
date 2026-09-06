import type { Title } from '../types';

/**
 * Pure, deterministic helpers for the title-detail experience (Spec Section 4).
 *
 * The catalog mock has no seasons/episodes/credits yet, so we *synthesize*
 * plausible SAMPLE data from a title's stable fields (slug, genres, runtime).
 * Everything here is deterministic — the same title always yields the same
 * output — so it is safe to render in a Server Component and simple to unit
 * test. The UI labels this data clearly as "sample"; it is replaced by real
 * `seasons` / `episodes` / `title_people` rows once Supabase is wired.
 */

export interface SynthEpisode {
  seasonNumber: number;
  episodeNumber: number;
  name: string;
  runtimeMinutes: number;
  synopsis: string;
}

export interface SynthSeason {
  seasonNumber: number;
  name: string;
  episodes: SynthEpisode[];
}

export interface CreditEntry {
  name: string;
  /** Character name (cast) or job (crew). */
  role: string;
}

export interface Credits {
  cast: CreditEntry[];
  crew: CreditEntry[];
}

/** Format runtime minutes as "2h 8m" / "2h" / "52m". Null when unknown/zero. */
export function formatRuntime(minutes?: number): string | null {
  if (!minutes || minutes <= 0) return null;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

/** Canonical episode code, e.g. "S1E1". */
export function formatEpisodeCode(seasonNumber: number, episodeNumber: number): string {
  return `S${seasonNumber}E${episodeNumber}`;
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

/** FNV-1a hash → stable non-negative integer within [min, max]. */
function seededInt(seed: string, min: number, max: number): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const span = max - min + 1;
  return min + (Math.abs(h) % span);
}

/** Bounds-safe pick that satisfies `noUncheckedIndexedAccess`. */
function pick<T>(pool: readonly T[], index: number): T {
  if (pool.length === 0) throw new Error('pick() requires a non-empty pool');
  const value = pool[((index % pool.length) + pool.length) % pool.length];
  if (value === undefined) throw new Error('pick() resolved to undefined');
  return value;
}

const EPISODE_NAMES = [
  'Cold Open',
  'Undertow',
  'The Long Dark',
  'Ashfall',
  'Signal Lost',
  'Homecoming',
  'Fault Lines',
  'The Reckoning',
  'Afterlight',
  'Threshold',
  'Gravity Well',
  'Nightfall',
  'The Bargain',
  'Embers',
  'First Light',
] as const;

const PERSON_FIRST = [
  'Ava',
  'Noel',
  'Priya',
  'Marcus',
  'Lena',
  'Idris',
  'Sofia',
  'Ravi',
  'Mara',
  'Elliot',
  'Nadia',
  'Theo',
] as const;

const PERSON_LAST = [
  'Vance',
  'Okafor',
  'Reyes',
  'Lindqvist',
  'Nakamura',
  'Bauer',
  'Costa',
  'Sato',
  'Delacroix',
  'Mercer',
] as const;

const CHARACTER_NAMES = [
  'Dr. Reyes',
  'Captain Hale',
  'Mira',
  'The Warden',
  'Jun',
  'Sister Agnes',
  'Detective Cole',
  'Wren',
  'Silas',
  'Ione',
] as const;

const CREW_JOBS = ['Director', 'Writer', 'Composer', 'Cinematographer', 'Editor'] as const;

/** Synthesize 1–2 seasons of episodes for a TV title (sample data). */
export function synthesizeSeasons(title: Title): SynthSeason[] {
  const seasonCount = 1 + seededInt(`${title.slug}:seasons`, 0, 1); // 1..2
  const baseRuntime = title.runtimeMinutes && title.runtimeMinutes > 0 ? title.runtimeMinutes : 45;
  const primaryGenre = title.genres[0] ?? 'Drama';
  const seasons: SynthSeason[] = [];

  for (let s = 1; s <= seasonCount; s += 1) {
    const episodeCount = seededInt(`${title.slug}:s${s}:eps`, 6, 10);
    const episodes: SynthEpisode[] = [];
    for (let e = 1; e <= episodeCount; e += 1) {
      const seed = `${title.slug}:s${s}:e${e}`;
      const name = pick(EPISODE_NAMES, seededInt(`${seed}:name`, 0, EPISODE_NAMES.length - 1));
      const runtimeMinutes = Math.max(22, baseRuntime + (seededInt(`${seed}:rt`, 0, 6) - 3));
      const synopsis = `${primaryGenre} tensions escalate in “${name}.” A sample episode synopsis generated for demonstration.`;
      episodes.push({ seasonNumber: s, episodeNumber: e, name, runtimeMinutes, synopsis });
    }
    seasons.push({ seasonNumber: s, name: `Season ${s}`, episodes });
  }

  return seasons;
}

/** Synthesize a small cast/crew list for a title (sample data). */
export function synthesizeCredits(title: Title): Credits {
  const person = (seed: string): string =>
    `${pick(PERSON_FIRST, seededInt(`${seed}:f`, 0, PERSON_FIRST.length - 1))} ${pick(
      PERSON_LAST,
      seededInt(`${seed}:l`, 0, PERSON_LAST.length - 1),
    )}`;

  const cast: CreditEntry[] = Array.from({ length: 5 }, (_unused, i) => ({
    name: person(`${title.slug}:cast:${i}`),
    role: pick(CHARACTER_NAMES, seededInt(`${title.slug}:cast:${i}:c`, 0, CHARACTER_NAMES.length - 1)),
  }));

  const crew: CreditEntry[] = Array.from({ length: 3 }, (_unused, i) => ({
    name: person(`${title.slug}:crew:${i}`),
    role: pick(CREW_JOBS, i),
  }));

  return { cast, crew };
}
