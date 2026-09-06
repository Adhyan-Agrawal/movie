import { Rail } from './Rail';
import { MobileNav } from './MobileNav';
import { TopBar } from './TopBar';
import { Footer } from './Footer';

/**
 * AppShell (Section 5). Landmarks: nav (rail + mobile), header (top bar),
 * main content region with a skip link target. Padding accounts for the
 * fixed rail on desktop and the bottom nav on mobile.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <Rail />
      <div className="flex min-h-dvh flex-col md:pl-16">
        <TopBar />
        <main id="main" tabIndex={-1} className="flex-1 pb-24 focus:outline-none md:pb-8">
          {children}
        </main>
        <Footer />
      </div>
      <MobileNav />
    </div>
  );
}
