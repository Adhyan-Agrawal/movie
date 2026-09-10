import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import '@/styles/globals.css';
import { publicEnv } from '@/lib/env';
import { AppShell } from '@/components/shell/AppShell';
import { ConsentBanner } from '@/components/consent/ConsentBanner';
import { ServiceWorkerRegister } from '@/components/pwa/ServiceWorkerRegister';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
});

/** Absolute URL to the brand logo — the default link-preview image. */
const appUrl = new URL(publicEnv.NEXT_PUBLIC_APP_URL);
const OG_LOGO = new URL('/logo.png', appUrl).toString();

export const metadata: Metadata = {
  title: {
    default: `${publicEnv.NEXT_PUBLIC_APP_NAME} — Cinematic streaming`,
    template: `%s · ${publicEnv.NEXT_PUBLIC_APP_NAME}`,
  },
  description: 'A calm, premium place to discover and watch movies and television.',
  metadataBase: appUrl,
  applicationName: publicEnv.NEXT_PUBLIC_APP_NAME,
  // Default social/link-preview image = the brand logo. Title pages override
  // this with their poster (see /title/[type]/[slug]/page.tsx).
  openGraph: {
    siteName: publicEnv.NEXT_PUBLIC_APP_NAME,
    images: [{ url: OG_LOGO, width: 512, height: 512, alt: `${publicEnv.NEXT_PUBLIC_APP_NAME} logo` }],
  },
  twitter: {
    card: 'summary',
    images: [OG_LOGO],
  },
  // iOS home-screen install: full-screen, dark status bar, matching title.
  appleWebApp: {
    capable: true,
    title: publicEnv.NEXT_PUBLIC_APP_NAME,
    statusBarStyle: 'black-translucent',
  },
};

export const viewport: Viewport = {
  themeColor: '#08090c',
  colorScheme: 'dark',
  // Installed/standalone mode draws under the notch and home indicator; the
  // shell pads with env(safe-area-inset-*) so nothing is clipped.
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body>
        <AppShell>{children}</AppShell>
        <ConsentBanner />
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
