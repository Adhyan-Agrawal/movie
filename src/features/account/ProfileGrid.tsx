import { ProfileCard } from './ProfileCard';
import type { AccountProfile } from './types';

/**
 * Profile grid rendered from the signed-in account's REAL `profiles` rows
 * (Spec Section 4). Read-only for now — creation, switching, editing, and
 * deletion arrive with profile management, so no non-persisting affordances
 * are shown here.
 */
export function ProfileGrid({ profiles }: { profiles: AccountProfile[] }) {
  if (profiles.length === 0) return null;

  return (
    <section aria-labelledby="profiles-heading" className="flex flex-col gap-8">
      <div className="flex flex-col gap-1">
        <h2 id="profiles-heading" className="text-lg font-semibold">
          Your profiles
        </h2>
        <p className="text-sm text-content-muted">
          {profiles.length} {profiles.length === 1 ? 'profile' : 'profiles'} on this account.
        </p>
      </div>

      <ul className="grid grid-cols-2 gap-x-6 gap-y-8 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
        {profiles.map((profile) => (
          <li key={profile.id}>
            <ProfileCard profile={profile} />
          </li>
        ))}
      </ul>
    </section>
  );
}
