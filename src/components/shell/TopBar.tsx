'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { cn } from '@/lib/cn';
import { Logo } from '@/components/ui/Logo';
import { Icon } from '@/components/ui/Icon';
import { Rail } from './Rail';
import { ACCOUNT_SERVICES_UNAVAILABLE } from '@/features/account/availability';

/**
 * Top bar with a command-search entry point (Section 5). Becomes opaque on
 * scroll for legibility over content. The search field routes to /search;
 * the full command palette is a later slice.
 */
export function TopBar({ signedIn = false, accountsAvailable = true }: { signedIn?: boolean; accountsAvailable?: boolean }) {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <header
      className={cn(
        // min-h (rather than a fixed h-16) so the notch padding in standalone
        // mode grows the bar instead of squeezing its 40px row. env() is 0 in
        // a normal browser tab, so desktop/md+ layout is untouched.
        'site-topbar sticky top-0 z-30 pt-[env(safe-area-inset-top)]',
        scrolled && 'is-scrolled',
      )}
    >
      <Link href="/" className="site-wordmark" aria-label="Lumora home">
        <Logo size={27} priority />
        <span>lumora<span className="site-wordmark-period">.</span></span>
      </Link>
      <Rail />
      <div className="ml-auto flex min-w-0 items-center gap-2 md:gap-3">
        <Link
          href="/search"
          prefetch={false}
          className="site-search-link"
          aria-label="Search"
        >
          <Icon name="search" />
          <span className="hidden xl:inline">Find your next story</span>
        </Link>
        {!accountsAvailable ? <span className="site-signin hidden sm:inline-flex text-content-muted" title={ACCOUNT_SERVICES_UNAVAILABLE}>Accounts offline</span> : !signedIn ? (
          <Link
            href="/signin"
            prefetch={false}
            className="site-signin hidden sm:inline-flex"
          >
            Sign in
          </Link>
        ) : null}
        {accountsAvailable ? <Link
          href="/account"
          aria-label="Account"
          prefetch={false}
          className="site-account-link"
        >
          <Icon name="user" width="18" height="18" />
        </Link> : <button type="button" disabled className="site-account-link opacity-60" aria-label="Accounts unavailable" title={ACCOUNT_SERVICES_UNAVAILABLE}><Icon name="user" width="18" height="18" /></button>}
      </div>
    </header>
  );
}
