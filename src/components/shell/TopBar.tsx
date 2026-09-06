'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { cn } from '@/lib/cn';

/**
 * Top bar with a command-search entry point (Section 5). Becomes opaque on
 * scroll for legibility over content. The search field routes to /search;
 * the full command palette is a later slice.
 */
export function TopBar() {
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
        'sticky top-0 z-30 flex h-16 items-center gap-4 px-4 transition-colors duration-200 md:px-8',
        scrolled ? 'border-b border-border bg-base/85 backdrop-blur-md' : 'bg-transparent',
      )}
    >
      <Link href="/" className="font-display text-lg font-bold md:hidden" aria-label="Lumora home">
        <span className="text-primary">◆</span> Lumora
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
