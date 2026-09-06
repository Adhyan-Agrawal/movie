import { PageHeader } from '@/components/ui/PageHeader';
import { UsersTable } from '@/features/admin/UsersTable';

export const metadata = {
  title: 'Users',
  description: 'Accounts, roles, and sessions.',
};

export default function AdminUsersPage() {
  return (
    <div className="py-6">
      <PageHeader
        title="Users"
        description="Support-safe account metadata. Emails are masked; suspend and revoke-sessions are confirmed and audited (Section 10)."
      />
      <UsersTable />
    </div>
  );
}
