import { PageHeader } from '@/components/ui/PageHeader';
import { UsersTable } from '@/features/admin/UsersTable';
import { listAdminAccounts } from '@/features/admin/queries';

export const metadata = {
  title: 'Users',
  description: 'Accounts registered on the platform.',
};

export default async function AdminUsersPage() {
  const accounts = await listAdminAccounts();

  return (
    <div className="py-6">
      <PageHeader
        title="Users"
        description="Accounts from the live database (users.read). Suspend and revoke-sessions actions arrive with the user-management phase."
      />
      <UsersTable accounts={accounts} />
    </div>
  );
}
