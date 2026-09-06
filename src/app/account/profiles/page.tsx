import type { Metadata } from 'next';
import { ProfileGrid } from '@/features/account/ProfileGrid';
import { MOCK_PROFILES } from '@/features/account/mock';

export const metadata: Metadata = { title: 'Profiles' };

export default function ProfilesPage() {
  return <ProfileGrid profiles={MOCK_PROFILES} />;
}
