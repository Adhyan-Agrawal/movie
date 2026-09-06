/**
 * Ad configuration (Spec Section 11 — commercial/ads).
 *
 * Adsterra is the sole provider for this slice. Each ad slot maps to an
 * Adsterra zone KEY (from the Adsterra dashboard: your zone's banner code →
 * atOptions.key). Keys live in server env vars and are read here at request
 * time — AdSlot passes only the key + dimensions to the banner component,
 * which is Adsterra's standard public embed pattern.
 *
 * A slot WITHOUT a key renders a labeled placeholder ("Advertisement") so the
 * placements are visible and honestly marked while unconfigured — never a
 * broken or invisible unit.
 *
 * No popunders, navigation interstitials, or social-bar formats: the strategy
 * is deliberately low-irritation (below-the-fold banners + one skippable
 * pre-roll on the player).
 */

export interface AdSlotConfig {
  /** Stable slot id (matches the `ad_placements.key` row). */
  key: string;
  /** Adsterra zone key from env; empty string = unconfigured. */
  adsterraKey: string;
  /** Banner dimensions Adsterra's invoke.js expects for this zone. */
  width: number;
  height: number;
  /** Human label for the placeholder and admin UI. */
  label: string;
}

/** All slot definitions (placement rendering, admin UI, seeding). */
export const AD_SLOT_DEFS = {
  homeLeaderboard: {
    key: 'home-leaderboard',
    envKey: 'leaderboard',
    width: 728,
    height: 90,
    label: 'Home leaderboard',
    format: 'banner',
  },
  browseLeaderboard: {
    key: 'browse-leaderboard',
    envKey: 'leaderboard',
    width: 728,
    height: 90,
    label: 'Browse/Movies/TV leaderboard',
    format: 'banner',
  },
  titleRectangle: {
    key: 'title-rectangle',
    envKey: 'rectangle',
    width: 300,
    height: 250,
    label: 'Title detail rectangle',
    format: 'banner',
  },
  watchPreroll: {
    key: 'watch-preroll',
    envKey: 'preroll',
    width: 728,
    height: 90,
    label: 'Player pre-roll',
    format: 'preroll',
  },
  watchBanner: {
    key: 'watch-banner',
    envKey: 'leaderboard',
    width: 728,
    height: 90,
    label: 'Watch page banner',
    format: 'banner',
  },
} as const;

export type AdSlotName = keyof typeof AD_SLOT_DEFS;

function readAdsterraKeys(): Record<string, string> {
  const raw = {
    leaderboard: process.env.ADSTERRA_KEY_LEADERBOARD ?? '',
    rectangle: process.env.ADSTERRA_KEY_RECTANGLE ?? '',
    preroll: process.env.ADSTERRA_KEY_PREROLL ?? '',
  };
  // Adsterra banner zone keys are hex tokens. Anything else (e.g. a pasted
  // Social Bar / Popunder script URL) is not a banner key — treat it as unset
  // rather than injecting it into the embed template.
  const isZoneKey = (v: string) => /^[a-f0-9]{16,64}$/i.test(v.trim());
  const leaderboard = isZoneKey(raw.leaderboard) ? raw.leaderboard.trim() : '';
  const rectangle = isZoneKey(raw.rectangle) ? raw.rectangle.trim() : '';
  // The pre-roll slot wants its own 728x90 banner zone; if only a script URL
  // was configured (common mistake — that's a different Adsterra product),
  // fall back to the leaderboard banner zone so the slot still serves.
  const preroll = isZoneKey(raw.preroll)
    ? raw.preroll.trim()
    : leaderboard;
  return { leaderboard, rectangle, preroll };
}

/** Resolve a slot's live config (env read at request time, not import time). */
export function getAdSlot(name: AdSlotName): AdSlotConfig {
  const def = AD_SLOT_DEFS[name];
  return { ...def, adsterraKey: readAdsterraKeys()[def.envKey] ?? '' };
}

/** True when at least one Adsterra zone key is configured. */
export function adsConfigured(): boolean {
  return Object.values(readAdsterraKeys()).some((k) => k.length > 0);
}

/** Admin-facing view of every slot and its configuration state. */
export function adSlotStatuses(): Array<{
  key: string;
  label: string;
  format: string;
  configured: boolean;
}> {
  return Object.values(AD_SLOT_DEFS).map((def) => ({
    key: def.key,
    label: def.label,
    format: def.format,
    configured: (readAdsterraKeys()[def.envKey] ?? '').length > 0,
  }));
}
