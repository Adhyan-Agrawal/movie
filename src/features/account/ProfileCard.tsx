import { Badge } from '@/components/ui/Badge';
import { maturityLabel, type AccountProfile } from './types';

/** Neutral fallback fill when a profile row carries no avatar. */
const FALLBACK_GRADIENT = 'linear-gradient(150deg, hsl(230 62% 46%), hsl(265 55% 30%))';

/**
 * A single profile tile rendered from a REAL `profiles` row. Presentational
 * and read-only — profile switching and editing arrive with profile
 * management, so no fake affordances are shown.
 */
export function ProfileCard({ profile }: { profile: AccountProfile }) {
  const initial = profile.name.trim().charAt(0).toUpperCase() || '?';
  const avatar = profile.avatar?.trim() ? profile.avatar : FALLBACK_GRADIENT;

  return (
    <div className="flex flex-col items-center gap-3">
      <div
        aria-hidden="true"
        className="grid aspect-square w-full max-w-[8.5rem] place-items-center overflow-hidden rounded-lg border border-border shadow-soft"
        style={avatar.startsWith('linear-gradient') ? { backgroundImage: avatar } : undefined}
      >
        <span className="grid h-full w-full place-items-center font-display text-4xl font-bold text-white/90 drop-shadow">
          {initial}
        </span>
      </div>
      <div className="flex flex-col items-center gap-1.5">
        <span className="text-sm font-medium text-content">{profile.name}</span>
        {profile.isKids ? (
          <Badge tone="info">Kids</Badge>
        ) : (
          <Badge tone="neutral">{maturityLabel(profile.maturityCeiling)}</Badge>
        )}
      </div>
    </div>
  );
}
