import type { Metadata } from 'next';
import { EmptyState } from '@/components/ui/EmptyState';
import { ProfileManager } from '@/features/account/ProfileManager';
import { listAccountProfiles } from '@/features/account/queries';
import { getActiveProfileId } from '@/features/account/active-profile';

export const metadata: Metadata = { title: 'Profiles' };

/** Account profiles (Spec Section 8): real rows + full management. */
export default async function ProfilesPage() {
  // REAL profiles for the signed-in account (RLS-scoped to auth.uid()).
  const [profiles, activeProfileId] = await Promise.all([listAccountProfiles(), getActiveProfileId()]);

  if (profiles.length === 0) {
    return (
      <EmptyState
        icon="👤"
        title="No profiles yet"
        description="Profile creation isn't available while signed out — sign in to manage profiles."
      />
    );
  }

  return <ProfileManager profiles={profiles} activeProfileId={activeProfileId} />;
}
