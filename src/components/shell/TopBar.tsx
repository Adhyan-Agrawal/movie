'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { cn } from '@/lib/cn';
import { Logo } from '@/components/ui/Logo';

/**
 * Top bar with a command-search entry point (Section 5). Becomes opaque on
 * scroll for legibility over content. The search field routes to /search;
 * the full command palette is a later slice.
 */
export function TopBar({ signedIn = false }: { signedIn?: boolean }) {
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
        'sticky top-0 z-30 flex min-h-[4rem] items-center gap-4 px-4 pt-[env(safe-area-inset-top)] transition-colors duration-200 md:px-8',
        scrolled ? 'border-b border-border bg-base/85 backdrop-blur-md' : 'bg-transparent',
      )}
    >
      <Link href="/" className="flex items-center gap-2 font-display text-lg font-bold md:hidden" aria-label="Lumora home">
        <Logo size={24} priority />
        <span>Lumora</span>
      </Link>

      <div className="ml-auto flex items-center gap-3">
        <Link
          href="/search"
          className={cn(
            'flex h-10 items-center gap-2 rounded-md border border-border bg-surface/60 px-3',
            'text-sm text-content-muted transition-colors hover:border-border-strong hover:text-content',
          )}
          aria-label="Search"
        >
          <span aria-hidden="true">⌕</span>
          <span className="hidden sm:inline">Search titles, people…</span>
        </Link>
        {!signedIn ? (
          <Link
            href="/signin"
            className="hidden h-10 items-center rounded-md border border-border bg-surface/60 px-4 text-sm font-medium text-content transition-colors hover:border-border-strong sm:flex"
          >
            Sign in
          </Link>
        ) : null}
        <Link
          href="/account"
          aria-label="Account"
          className="grid h-10 w-10 place-items-center rounded-full border border-border bg-surface-raised text-content-muted transition-colors hover:text-content"
        >
          <span aria-hidden="true">☺</span>
        </Link>
      </div>
    </header>
  );
}
