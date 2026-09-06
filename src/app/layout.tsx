import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import '@/styles/globals.css';
import { publicEnv } from '@/lib/env';
import { AppShell } from '@/components/shell/AppShell';
import { ConsentBanner } from '@/components/consent/ConsentBanner';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
});

export const metadata: Metadata = {
  title: {
    default: `${publicEnv.NEXT_PUBLIC_APP_NAME} — Cinematic streaming`,
    template: `%s · ${publicEnv.NEXT_PUBLIC_APP_NAME}`,
  },
  description: 'A calm, premium place to discover and watch movies and television.',
  metadataBase: new URL(publicEnv.NEXT_PUBLIC_APP_URL),
  applicationName: publicEnv.NEXT_PUBLIC_APP_NAME,
};

export const viewport: Viewport = {
  themeColor: '#08090c',
  colorScheme: 'dark',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body>
        <AppShell>{children}</AppShell>
        <ConsentBanner />
      </body>
    </html>
  );
}
