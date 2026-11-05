import { MobileNav } from './MobileNav';
import { TopBar } from './TopBar';
import { Footer } from './Footer';
import { InstallPrompt } from '@/components/pwa/InstallPrompt';
import { AdSlot } from '@/features/ads/AdSlot';
import { ConsentGate } from '@/features/ads/ConsentGate';
import { isSignedIn } from '@/features/playback/progress-queries';
import { features } from '@/lib/env';

/**
 * AppShell (Section 5). Landmarks: nav (rail + mobile), header (top bar),
 * main content region with a skip link target. Padding accounts for the
 * fixed rail on desktop and the bottom nav on mobile.
 */
export async function AppShell({ children }: { children: React.ReactNode }) {
  const accountsAvailable = features.supabaseConfigured;
  const signedIn = accountsAvailable && await isSignedIn().catch(() => false);
  return (
    <div className="site-shell min-h-dvh min-w-0">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <div className="flex min-h-dvh min-w-0 flex-col">
        <TopBar signedIn={signedIn} accountsAvailable={accountsAvailable} />
        {/* pb-24 (6rem) clears the bottom nav; the safe-area inset is added on
            top so the last row isn't tucked under the home indicator. */}
        <main
          id="main"
          tabIndex={-1}
          className="site-main min-w-0 flex-1 focus:outline-none"
        >
          {children}
        </main>
        {/* Ad (Spec Section 11): one footer leaderboard, banner-only, gated on
            advertising consent — above the footer, never over content. */}
        <ConsentGate>
          <AdSlot slot="footerLeaderboard" />
        </ConsentGate>
        <Footer />
      </div>
      {/* Mounted here (not in layout.tsx) so it renders inside the shell, sat
          just above the fixed mobile nav. */}
      <InstallPrompt />
      <MobileNav accountsAvailable={accountsAvailable} />
    </div>
  );
}
