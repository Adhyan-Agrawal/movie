import type { Metadata } from 'next';
import { DeviceList } from '@/features/account/DeviceList';
import { MOCK_DEVICE_SESSIONS } from '@/features/account/mock';

export const metadata: Metadata = { title: 'Devices' };

export default function DevicesPage() {
  return <DeviceList sessions={MOCK_DEVICE_SESSIONS} />;
}
