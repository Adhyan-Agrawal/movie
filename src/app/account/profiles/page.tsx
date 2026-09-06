import type { Metadata } from 'next';
import { EmptyState } from '@/components/ui/EmptyState';
import { ProfileGrid } from '@/features/account/ProfileGrid';
import { listAccountProfiles } from '@/features/account/queries';

export const metadata: Metadata = { title: 'Profiles' };

export default async function ProfilesPage() {
  // REAL profiles for the signed-in account (RLS-scoped to auth.uid()).
  const profiles = await listAccountProfiles();

  if (profiles.length === 0) {
    return (
      <EmptyState
        icon="👤"
        title="No profiles yet"
        description="Profile creation isn’t available yet — it arrives with profile management."
      />
    );
  }

  return <ProfileGrid profiles={profiles} />;
}
