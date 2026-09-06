import type { Metadata } from 'next';
import { NotificationSettings } from '@/features/account/NotificationSettings';

export const metadata: Metadata = { title: 'Notifications' };

export default function NotificationsPage() {
  return <NotificationSettings />;
}
