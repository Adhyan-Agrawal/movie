import { Badge } from '@/components/ui/Badge';
import { cn } from '@/lib/cn';
import { maturityLabel, type Profile } from './mock';

/**
 * A single Netflix-style profile tile. Presentational — the parent
 * `ProfileGrid` owns state and passes handlers. In manage mode the avatar
 * becomes an "edit" affordance and a separate delete control appears (kept as
 * a sibling, never nested, to avoid nested interactive elements).
 */
export function ProfileCard({
  profile,
  manage = false,
  onSelect,
  onEdit,
  onDelete,
}: {
  profile: Profile;
  manage?: boolean;
  onSelect?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  const initial = profile.name.trim().charAt(0).toUpperCase() || '?';

  return (
    <div className="group relative flex flex-col items-center gap-3">
      {manage ? (
        <button
          type="button"
          onClick={onDelete}
          aria-label={`Delete ${profile.name}’s profile`}
          className={cn(
            'absolute -right-1 -top-1 z-10 grid h-7 w-7 place-items-center rounded-full',
            'border border-border-strong bg-surface-overlay text-content-muted shadow-soft transition-colors',
            'hover:border-danger hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger',
          )}
        >
          <span aria-hidden="true">✕</span>
        </button>
      ) : null}

      <button
        type="button"
        onClick={manage ? onEdit : onSelect}
        aria-label={manage ? `Edit ${profile.name}’s profile` : `Switch to ${profile.name}`}
        className={cn(
          'relative aspect-square w-full max-w-[8.5rem] overflow-hidden rounded-lg border border-border shadow-soft',
          'transition-transform duration-200 ease-deliberate hover:-translate-y-0.5 hover:border-border-strong',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
        )}
        style={{ backgroundImage: profile.avatarGradient }}
      >
        <span
          aria-hidden="true"
          className="absolute inset-0 grid place-items-center font-display text-4xl font-bold text-white/90 drop-shadow"
        >
          {initial}
        </span>
        {manage ? (
          <span
            aria-hidden="true"
            className="absolute inset-0 grid place-items-center bg-black/45 text-sm font-medium text-white opacity-0 transition-opacity duration-150 group-hover:opacity-100"
          >
            ✎ Edit
          </span>
        ) : null}
      </button>

      <div className="flex flex-col items-center gap-1.5">
        <span className="text-sm font-medium text-content">{profile.name}</span>
        <div className="flex items-center gap-1">
          {profile.isKids ? <Badge tone="info">Kids</Badge> : <Badge tone="neutral">{maturityLabel(profile.maturity)}</Badge>}
          {profile.pinProtected ? (
            <span className="text-content-subtle">
              <span aria-hidden="true">🔒</span>
              <span className="sr-only">PIN protected</span>
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
