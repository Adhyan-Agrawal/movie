import { Rail } from './Rail';
import { MobileNav } from './MobileNav';
import { TopBar } from './TopBar';
import { Footer } from './Footer';
import { AdSlot } from '@/features/ads/AdSlot';
import { ConsentGate } from '@/features/ads/ConsentGate';
import { isSignedIn } from '@/features/playback/progress-queries';

/**
 * AppShell (Section 5). Landmarks: nav (rail + mobile), header (top bar),
 * main content region with a skip link target. Padding accounts for the
 * fixed rail on desktop and the bottom nav on mobile.
 */
export async function AppShell({ children }: { children: React.ReactNode }) {
  const signedIn = await isSignedIn().catch(() => false);
  return (
    <div className="min-h-dvh">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <Rail />
      <div className="flex min-h-dvh flex-col md:pl-16">
        <TopBar signedIn={signedIn} />
        <main id="main" tabIndex={-1} className="flex-1 pb-24 focus:outline-none md:pb-8">
          {children}
        </main>
        {/* Ad (Spec Section 11): one footer leaderboard, banner-only, gated on
            advertising consent — above the footer, never over content. */}
        <ConsentGate>
          <AdSlot slot="footerLeaderboard" />
        </ConsentGate>
        <Footer />
      </div>
      <MobileNav />
    </div>
  );
}
